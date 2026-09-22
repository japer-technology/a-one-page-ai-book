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

export interface GenOptions {
  endpoint: EndpointSettings;
  model: string;
  temperature?: number;
  signal?: AbortSignal;
  /** When set, generation streams tokens and the promise still resolves with full text. */
  onToken?: (token: string) => void;
}

const MAX_TOKENS = 2400;

function httpError(status: number, body: string): Error {
  const short = body.slice(0, 300).replace(/\s+/g, ' ').trim();
  if (status === 401 || status === 403) {
    return new Error(
      `LLM server rejected the request (HTTP ${status}${short ? `: ${short}` : ''}). If this endpoint requires an API key, add it in Settings.`,
    );
  }
  return new Error(`LLM server responded ${status}${short ? `: ${short}` : ''}`);
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
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { rest, stop } = drainLines(buffer, (line) => {
      if (!line.startsWith('data:')) return false;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return true;
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          message?: { content?: string };
        };
        const delta = json.choices?.[0]?.delta?.content ?? json.message?.content;
        if (typeof delta === 'string' && delta.length > 0) onToken(delta);
      } catch {
        // ignore partial lines; they resume on the next chunk
      }
      return false;
    });
    buffer = rest;
    if (stop) return;
  }
  // A server may end without a trailing newline — salvage the last line.
  const leftover = buffer.trim();
  if (leftover.length > 0 && leftover.startsWith('data:')) {
    const payload = leftover.slice(5).trim();
    if (payload !== '[DONE]') {
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          message?: { content?: string };
        };
        const delta = json.choices?.[0]?.delta?.content ?? json.message?.content;
        if (typeof delta === 'string' && delta.length > 0) onToken(delta);
      } catch {
        // nothing salvageable
      }
    }
  }
}

/** Parse an Ollama NDJSON stream: bare JSON per line, {message:{content}, done}. */
async function readNdjson(response: Response, onToken: (t: string) => void): Promise<void> {
  if (!response.body) throw new Error('LLM server sent no response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { rest, stop } = drainLines(buffer, (line) => {
      try {
        const json = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        const delta = json.message?.content;
        if (typeof delta === 'string' && delta.length > 0) onToken(delta);
        if (json.done === true) return true;
      } catch {
        // ignore partial lines; they resume on the next chunk
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
      const json = JSON.parse(leftover) as { message?: { content?: string } };
      const delta = json.message?.content;
      if (typeof delta === 'string' && delta.length > 0) onToken(delta);
    } catch {
      // nothing salvageable
    }
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
 * A connection-level failure worth ONE automatic retry: the server may just
 * have hiccuped. Aborts and timeouts are NOT transient — a timed-out request
 * has a dead signal (a retry would fail instantly with a misleading error).
 */
export function isTransientLLMError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('Load failed') ||
    message.includes('fetch failed') ||
    message.includes('ECONNREFUSED')
  );
}

export async function chat(opts: GenOptions, messages: ChatMessage[]): Promise<string> {
  const { endpoint, model, signal, onToken } = opts;
  const temperature = opts.temperature ?? endpoint.temperature ?? 0.9;
  const stream = typeof onToken === 'function';
  const base = endpoint.baseUrl.replace(/\/+$/, '');

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
      const json = (await response.json()) as { message?: { content?: string } };
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

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content ?? '';
  if (content.trim().length === 0) throw new Error('LLM returned an empty page');
  return content;
}

/** Ask for structured JSON and parse it tolerantly. */
export async function chatJSON<T>(opts: GenOptions, messages: ChatMessage[]): Promise<T> {
  const text = await chat(opts, messages);
  return parseJSONLoose<T>(text);
}
