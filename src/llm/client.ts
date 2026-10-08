/**
 * llm/client.ts — the model-agnostic generation engine.
 *
 * Speaks two dialects behind one interface:
 *   - OpenAI-compatible  POST {base}/v1/chat/completions   (LM Studio, llama.cpp, vLLM, …)
 *   - Ollama native      POST {base}/api/chat              (falls back to /v1 if absent)
 * Both stream via server-sent events when an onToken callback is provided.
 */
import type { ChatMessage, EndpointSettings } from '../core/types';
import { parseJSONLoose } from '../core/parsers';
import { normalizeBaseUrl } from './endpoints';

export interface GenOptions {
  endpoint: EndpointSettings;
  model: string;
  temperature?: number;
  signal?: AbortSignal;
  /** When set, generation streams tokens and the promise still resolves with full text. */
  onToken?: (token: string) => void;
}

const MAX_TOKENS = 2400;

/**
 * A 200 response can still carry a failure. llama.cpp, vLLM and LM Studio all
 * emit `{error: …}` inside the stream when generation dies mid-flight (OOM,
 * context overflow, model unloaded). Ignoring it committed a page that stops
 * mid-sentence as though it were complete, and reported "empty page" when
 * nothing had arrived — throwing away the server's actual reason.
 */
function errorFromPayload(json: unknown): Error | null {
  if (typeof json !== 'object' || json === null) return null;
  const error = (json as { error?: unknown }).error;
  if (error === undefined || error === null) return null;
  const text =
    typeof error === 'string'
      ? error
      : typeof (error as { message?: unknown }).message === 'string'
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error);
  return new Error(`LLM server reported an error while generating: ${text.slice(0, 300)}`);
}

/** A real server error must escape the per-line parse; an unparsable line must not. */
function rethrowServerError(err: unknown): void {
  if (err instanceof Error && err.message.startsWith('LLM server reported')) throw err;
}

function httpError(status: number, body: string): Error {
  const short = body.slice(0, 300).replace(/\s+/g, ' ').trim();
  if (status === 401 || status === 403) {
    return new Error(
      `LLM server rejected the request (HTTP ${status}${short ? `: ${short}` : ''}). If this endpoint requires an API key, add it in Settings.`,
    );
  }
  // The warming test must run FIRST: a bare 503 is "busy", but Ollama's 503
  // with "model … is not loaded"/"is loading" is a readiness problem, and the
  // busy branch used to claim every 429/503 before the body was consulted —
  // telling the reader to raise a concurrency limit while the model was still
  // loading, and picking the wrong retry ladder.
  if (isServerWarmingStatus(status, body)) {
    return new Error(
      `The local LLM server is still loading the model (HTTP ${status}${short ? `: ${short}` : ''}) — it answers as soon as the weights are in memory.`,
    );
  }
  if (isServerBusyStatus(status, body)) {
    return new Error(
      `LLM server is busy (HTTP ${status}${short ? `: ${short}` : ''}) — its one generation slot is already in use. Wait for the current request to finish, or raise the concurrency limit in the server's settings.`,
    );
  }
  return new Error(`LLM server responded ${status}${short ? `: ${short}` : ''}`);
}

/**
 * Did the server answer "I can only do one thing at a time"? Local servers
 * configured with a single generation slot (LM Studio's default, llama.cpp
 * with `-np 1`) reject a second concurrent request instead of queueing it:
 * 429/503, or LM Studio's HTTP 400 "Only one request at a time is allowed".
 */
function isServerBusyStatus(status: number, body: string): boolean {
  if (status === 429 || status === 503) return true;
  if (status !== 400 && status !== 409) return false;
  return /one request at a time|only one request|busy|concurrent|already processing|slot/i.test(
    body,
  );
}

/**
 * A "server is busy" failure: the request never reached the model, so trying it
 * again once the slot frees is meaningful (unlike a 404 or a malformed body).
 */
export function isServerBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('one generation slot') ||
    message.includes('one request at a time is allowed') ||
    /LLM server responded (429|503)(\b|:)/.test(message)
  );
}

/**
 * Is the server up but not ready to generate? Ollama answers 503 with
 * "model … is not loaded"/"is loading, please wait", LM Studio answers 400 or
 * 500 with "Model is loading.", and a server that unloaded the model under
 * memory pressure has to page it back in before it can answer. The request
 * never reached the model, so it is worth re-sending — but only after a longer
 * pause than a busy slot needs, which is why this is a separate verdict from
 * "busy" rather than more busy wording.
 *
 * A 404 is deliberately excluded: that is Ollama's "model 'x' not found", which
 * is a wrong model name in Settings, not a readiness problem.
 */
export function isServerWarmingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /still loading the model|is loading|loading the model|loading model|not loaded|please wait|unloading|warming up|warm up/i.test(
    message,
  );
}

function isServerWarmingStatus(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 404) return false;
  if (status < 400 || status > 599) return false;
  return /model .{0,60}(?:is loading|not loaded|loading)|is loading|loading the model|loading, please wait|weights/i.test(
    body,
  );
}

/** Headers shared by both dialects, including the optional bearer key. */
function buildHeaders(endpoint: EndpointSettings, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.apiKey.trim().length > 0) headers.authorization = `Bearer ${endpoint.apiKey.trim()}`;
  if (stream) headers.accept = 'text/event-stream';
  return headers;
}

/** Is this response an SSE stream, or a plain JSON body? (Some servers ignore stream:true.) */
function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
}

/** Ollama native streams are NDJSON: bare JSON objects, one per line, no data: prefix. */
function isNdjson(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('ndjson');
}

/** Drain every complete line from the buffer; onLine returning true stops early. */
function drainLines(
  buffer: string,
  onLine: (line: string) => boolean,
): { rest: string; stop: boolean } {
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline < 0) return { rest, stop: false };
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (line.length > 0 && onLine(line)) return { rest, stop: true };
  }
}

/** Parse one SSE stream from either dialect; invoke onToken per text delta. */
async function readSSE(response: Response, onToken: (t: string) => void): Promise<void> {
  if (!response.body) throw new Error('LLM server sent no response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /**
   * The payload lines of the SSE event being assembled.
   *
   * The SSE spec lets ONE event carry several `data:` lines, joined with
   * newlines before parsing. Each line was parsed in isolation here, so such
   * an event could never parse: its tokens vanished, and an `{error:…}`
   * delivered that way was swallowed — the stream then ran to [DONE] and the
   * truncated page was returned as if it had completed.
   */
  let eventData: string[] = [];
  /** Parse one event payload. true = [DONE], false = consumed, null = not parseable (yet). */
  const asEvent = (payload: string): boolean | null => {
    if (payload === '[DONE]') return true;
    try {
      const json = JSON.parse(payload) as {
        error?: unknown;
        choices?: Array<{ delta?: { content?: string } }>;
        message?: { content?: string };
      };
      const error = errorFromPayload(json);
      if (error) throw error;
      const delta = json.choices?.[0]?.delta?.content ?? json.message?.content;
      if (typeof delta === 'string' && delta.length > 0) onToken(delta);
      return false;
    } catch (err) {
      rethrowServerError(err);
      return null;
    }
  };
  /** @returns true when the stream should stop ([DONE]). */
  const onDataLine = (payload: string): boolean => {
    if (payload.length === 0) return false;
    eventData.push(payload);
    // The event so far: one line in the common single-line dialect (so
    // streaming is unaffected), several once a split payload becomes valid.
    const whole = asEvent(eventData.join('\n'));
    if (whole !== null) {
      eventData = [];
      return whole;
    }
    // Not a multi-line payload: a server that writes no blank separator
    // between events — then the last line on its own is the event.
    if (eventData.length > 1) {
      const last = asEvent(payload);
      if (last !== null) {
        eventData = [];
        return last;
      }
    }
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { rest, stop } = drainLines(buffer, (line) => {
        if (!line.startsWith('data:')) return false;
        return onDataLine(line.slice(5).trim());
      });
      buffer = rest;
      // Release the stream on an early stop so the socket is not held open.
      if (stop) return;
    }
    // A server may end without a trailing newline — salvage the last line.
    const leftover = buffer.trim();
    if (leftover.length > 0 && leftover.startsWith('data:')) {
      onDataLine(leftover.slice(5).trim());
    }
  } finally {
    await releaseStream(reader);
  }
}

/**
 * Let go of a response body on EVERY exit path, including the exceptional one.
 *
 * A stream abandoned without cancelling the reader keeps its connection open
 * and, on a local server with a single generation slot, keeps the abandoned
 * generation running — which is the very thing that makes the reader's own
 * next request answer "the server is busy". A mid-stream `{error: …}` (OOM,
 * context overflow) used to unwind straight out of the read loop with the
 * socket still held, so one failed generation could poison every request after
 * it. `cancel()` on an already-closed stream is a no-op, so this is safe on the
 * normal path too.
 */
async function releaseStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Already released, or the transport is gone — nothing left to do.
  }
}

/** Parse an Ollama NDJSON stream: bare JSON per line, {message:{content}, done}. */
async function readNdjson(response: Response, onToken: (t: string) => void): Promise<void> {
  if (!response.body) throw new Error('LLM server sent no response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { rest, stop } = drainLines(buffer, (line) => {
        try {
          const json = JSON.parse(line) as {
            error?: unknown;
            message?: { content?: string };
            done?: boolean;
          };
          const error = errorFromPayload(json);
          if (error) throw error;
          const delta = json.message?.content;
          if (typeof delta === 'string' && delta.length > 0) onToken(delta);
          if (json.done === true) return true;
        } catch (err) {
          rethrowServerError(err);
          // Otherwise it is a partial line; it resumes on the next chunk.
        }
        return false;
      });
      buffer = rest;
      if (stop) return;
    }
    // Final line without a trailing newline is still a line.
    const leftover = buffer.trim();
    if (leftover.length > 0) {
      try {
        const json = JSON.parse(leftover) as { error?: unknown; message?: { content?: string } };
        const error = errorFromPayload(json);
        if (error) throw error;
        const delta = json.message?.content;
        if (typeof delta === 'string' && delta.length > 0) onToken(delta);
      } catch (err) {
        rethrowServerError(err);
      }
    }
  } finally {
    await releaseStream(reader);
  }
}

/**
 * A 200 whose body is empty or not JSON must not surface as a raw
 * `SyntaxError: Unexpected end of JSON input` / `Unexpected token 'd'`.
 * Proxies and older builds do occasionally answer a stream request with a
 * mislabelled or empty body.
 */
async function readJsonBody<T>(response: Response): Promise<T> {
  const text = await response.text().catch(() => '');
  if (text.trim().length === 0) {
    throw new Error(
      'The LLM server returned an empty response body. Check the endpoint in Settings (and whether the model is still loaded).',
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    if (text.trimStart().startsWith('data:')) {
      throw new Error(
        'The LLM server sent a stream for a non-streaming request. Try again, or switch the protocol in Settings.',
      );
    }
    throw new Error(
      `The LLM server returned something that is not JSON: ${text.slice(0, 200).replace(/\s+/g, ' ')}`,
    );
  }
}

async function readJSONError(response: Response): Promise<string> {
  // Read the body ONCE: response.json() consumes it, so a later text() fallback
  // would throw "body already read" and hide the server's actual message.
  const text = await response.text().catch(() => '');
  if (!text) return '';
  try {
    const json = JSON.parse(text) as { error?: unknown };
    if (json && typeof json.error === 'string') return json.error;
    if (json && typeof json.error === 'object' && json.error !== null) {
      const message = (json.error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return '';
  } catch {
    return text.slice(0, 300);
  }
}

/**
 * A connection-level failure worth re-sending, and how many times, is decided
 * by `llm/retry.ts` (see `isTransientLLMError` there). It lives in its own
 * module because the policy is a data table that deserves unit tests, while
 * this module is about talking to the server.
 */

export async function chat(opts: GenOptions, messages: ChatMessage[]): Promise<string> {
  const { endpoint, model, signal, onToken } = opts;
  const temperature = opts.temperature ?? endpoint.temperature ?? 0.9;
  const stream = typeof onToken === 'function';
  // The same normalization every other entry point uses. Stripping only
  // trailing slashes meant a base URL ending in `/v1` — which Settings strips
  // but the schema does not, so an imported or hand-edited library can carry
  // one — posted to `/v1/v1/chat/completions` and 404'd on every generation.
  const base = normalizeBaseUrl(endpoint.baseUrl);

  if (!model) throw new Error('No model selected — pick one in Settings first.');

  // Ollama native first; fall back to the OpenAI-compatible path if it 404s.
  if (endpoint.vendor === 'ollama') {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: buildHeaders(endpoint, stream),
      body: JSON.stringify({
        model,
        messages,
        stream,
        options: { temperature, num_predict: MAX_TOKENS },
      }),
      signal,
    });
    if (response.ok) {
      if (stream) {
        if (isNdjson(response)) {
          let full = '';
          await readNdjson(response, (t) => {
            full += t;
            onToken(t);
          });
          if (full.trim().length === 0) throw new Error('LLM returned an empty page');
          return full;
        }
        if (isEventStream(response)) {
          let full = '';
          await readSSE(response, (t) => {
            full += t;
            onToken(t);
          });
          if (full.trim().length === 0) throw new Error('LLM returned an empty page');
          return full;
        }
        // fall through: the server ignored stream:true and sent plain JSON
      }
      const json = await readJsonBody<{ error?: unknown; message?: { content?: string } }>(
        response,
      );
      const serverError = errorFromPayload(json);
      if (serverError) throw serverError;
      const content = json.message?.content ?? '';
      if (content.trim().length === 0) throw new Error('LLM returned an empty page');
      return content;
    }
    if (response.status !== 404 && response.status !== 405) {
      throw httpError(response.status, await readJSONError(response));
    }
    // fall through to /v1 (some builds only expose the OpenAI endpoint)
  }

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(endpoint, stream),
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: MAX_TOKENS,
      stream,
    }),
    signal,
  });

  if (!response.ok) throw httpError(response.status, await readJSONError(response));

  if (stream && isEventStream(response)) {
    let full = '';
    await readSSE(response, (t) => {
      full += t;
      onToken(t);
    });
    if (full.trim().length === 0) throw new Error('LLM returned an empty page');
    return full;
  }

  const json = await readJsonBody<{
    error?: unknown;
    choices?: Array<{ message?: { content?: string } }>;
  }>(response);
  // A 200 that carries the server's error: OOM, model not loaded, context
  // overflow. Reporting it as "empty page" pointed the reader at the wrong
  // problem entirely.
  const serverError = errorFromPayload(json);
  if (serverError) throw serverError;
  const content = json.choices?.[0]?.message?.content ?? '';
  if (content.trim().length === 0) throw new Error('LLM returned an empty page');
  return content;
}

/** Ask for structured JSON and parse it tolerantly. */
export async function chatJSON<T>(opts: GenOptions, messages: ChatMessage[]): Promise<T> {
  const text = await chat(opts, messages);
  return parseJSONLoose<T>(text);
}
