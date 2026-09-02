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
  return new Error(`LLM server responded ${status}${short ? `: ${short}` : ''}`);
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
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
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
    }
  }
}

async function readJSONError(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as { error?: unknown };
    if (json && typeof json.error === 'string') return json.error;
    if (json && typeof json.error === 'object' && json.error !== null) {
      const message = (json.error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return '';
  } catch {
    return (await response.text()).slice(0, 300);
  }
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
      headers: { 'content-type': 'application/json' },
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
        let full = '';
        await readSSE(response, (t) => {
          full += t;
          onToken(t);
        });
        if (full.trim().length === 0) throw new Error('LLM returned an empty page');
        return full;
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
    headers: { 'content-type': 'application/json' },
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

  if (stream) {
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
