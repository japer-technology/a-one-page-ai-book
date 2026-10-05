import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, chatJSON, isServerBusyError } from '../src/llm/client';
// The retry policy (and the verdict on which failures are worth another
// request) lives in llm/retry.ts; its own expectations are in tests/retry.test.ts.
import { isTransientLLMError } from '../src/llm/retry';
import type { EndpointSettings } from '../src/core/types';

const openai: EndpointSettings = {
  name: 'test',
  baseUrl: 'http://127.0.0.1:1234',
  vendor: 'openai-compat',
  model: 'm',
  temperature: 0.9,
  apiKey: '',
};

const ollama: EndpointSettings = { ...openai, baseUrl: 'http://127.0.0.1:11434', vendor: 'ollama' };

function streamResponse(contentType: string, chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

describe('OpenAI-compatible dialect', () => {
  it('streams SSE, reassembling tokens even when chunks split lines mid-way', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse('text/event-stream; charset=utf-8', [
          'data: {"choices":[{"delta":{"content":"Hel',
          'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const tokens: string[] = [];
    const text = await chat(
      { endpoint: openai, model: 'm', onToken: (t) => tokens.push(t) },
      MESSAGES,
    );
    expect(text).toBe('Hello world');
    expect(tokens.join('')).toBe('Hello world');
  });

  it('falls back to plain JSON when the server ignores stream:true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'whole page' } }] })),
    );
    const text = await chat({ endpoint: openai, model: 'm', onToken: () => {} }, MESSAGES);
    expect(text).toBe('whole page');
  });

  it('returns non-stream JSON without onToken', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'page' } }] })),
    );
    expect(await chat({ endpoint: openai, model: 'm' }, MESSAGES)).toBe('page');
  });

  it('sends the API key as a bearer header', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      capturedHeaders = init?.headers;
      return jsonResponse({ choices: [{ message: { content: 'x' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const endpoint = { ...openai, apiKey: 'sk-secret' };
    await chat({ endpoint, model: 'm' }, MESSAGES);
    expect(capturedHeaders?.authorization).toBe('Bearer sk-secret');
  });
});

describe('Ollama dialect', () => {
  it('streams native NDJSON (bare JSON lines, no data: prefix)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse('application/x-ndjson', [
          '{"model":"m","message":{"role":"assistant","content":"The "},"done":false}\n',
          '{"model":"m","message":{"role":"assistant","content":"keeper."},"done":false}\n',
          '{"model":"m","message":{"role":"assistant","content":""},"done":true}\n',
        ]),
      ),
    );
    const tokens: string[] = [];
    const text = await chat(
      { endpoint: ollama, model: 'm', onToken: (t) => tokens.push(t) },
      MESSAGES,
    );
    expect(text).toBe('The keeper.');
    expect(tokens).toEqual(['The ', 'keeper.']);
  });

  it('handles an NDJSON final line without a trailing newline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse('application/x-ndjson', [
          '{"model":"m","message":{"role":"assistant","content":"final"},"done":false}\n',
          '{"model":"m","message":{"role":"assistant","content":" word"},"done":true}',
        ]),
      ),
    );
    const text = await chat({ endpoint: ollama, model: 'm', onToken: () => {} }, MESSAGES);
    expect(text).toBe('final word');
  });

  it('returns non-stream JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: { role: 'assistant', content: 'ok' } })),
    );
    expect(await chat({ endpoint: ollama, model: 'm' }, MESSAGES)).toBe('ok');
  });

  it('falls back to /v1/chat/completions when /api/chat 404s', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => jsonResponse({ error: 'not found' }, 404))
      .mockImplementationOnce(async () =>
        jsonResponse({ choices: [{ message: { content: 'via v1' } }] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const text = await chat({ endpoint: ollama, model: 'm' }, MESSAGES);
    expect(text).toBe('via v1');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/chat');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/chat/completions');
  });
});

// A local server with ONE generation slot keeps generating for a client that
// walked away: leaving the response body open on an error path holds the slot,
// which is what makes the reader's own NEXT request answer "the server is busy".
describe('the response stream is always released', () => {
  /** A stream that reports whether the reader was cancelled. */
  function trackedStream(chunks: string[], contentType: string) {
    const state = { cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        // Deliberately never closed: the error arrives while the stream is open.
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return {
      state,
      response: new Response(body, { status: 200, headers: { 'content-type': contentType } }),
    };
  }

  it('cancels the reader when the server reports an error mid-SSE-stream', async () => {
    const { state, response } = trackedStream(
      [
        'data: {"choices":[{"delta":{"content":"Once "}}]}\n\n',
        'data: {"error":{"message":"context overflow"}}\n\n',
      ],
      'text/event-stream',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    const err = await chat({ endpoint: openai, model: 'm', onToken: () => {} }, MESSAGES).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain('context overflow');
    expect(state.cancelled).toBe(true);
  });

  it('cancels the reader when the server reports an error mid-NDJSON-stream', async () => {
    const { state, response } = trackedStream(
      [
        '{"model":"m","message":{"content":"Once "},"done":false}\n',
        '{"error":"CUDA out of memory"}\n',
      ],
      'application/x-ndjson',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    const err = await chat({ endpoint: ollama, model: 'm', onToken: () => {} }, MESSAGES).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain('CUDA out of memory');
    expect(state.cancelled).toBe(true);
  });

  it('releases the reader after a normal [DONE] without holding the socket', async () => {
    const { state, response } = trackedStream(
      ['data: {"choices":[{"delta":{"content":"A page."}}]}\n\n', 'data: [DONE]\n\n'],
      'text/event-stream',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    expect(await chat({ endpoint: openai, model: 'm', onToken: () => {} }, MESSAGES)).toBe(
      'A page.',
    );
    expect(state.cancelled).toBe(true);
  });
});

describe('errors', () => {
  it('explains 401 as a key problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'unauthorized' } }, 401)),
    );
    await expect(chat({ endpoint: openai, model: 'm' }, MESSAGES)).rejects.toThrow(/API key/);
  });

  it('refuses to run without a model', async () => {
    await expect(chat({ endpoint: { ...openai, model: '' }, model: '' }, MESSAGES)).rejects.toThrow(
      /No model selected/,
    );
  });
});

describe('chatJSON', () => {
  it('parses structured output tolerantly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ choices: [{ message: { content: '```json\n["a","b"]\n```' } }] }),
      ),
    );
    expect(await chatJSON<string[]>({ endpoint: openai, model: 'm' }, MESSAGES)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('isTransientLLMError', () => {
  it('classifies connection failures as transient, aborts and timeouts as not', () => {
    expect(isTransientLLMError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientLLMError(new Error('NetworkError when attempting to fetch resource.'))).toBe(
      true,
    );
    expect(isTransientLLMError(new DOMException('x', 'AbortError'))).toBe(false);
    expect(isTransientLLMError(new DOMException('x', 'TimeoutError'))).toBe(false);
  });

  it('re-sends an answer the model produced but made unusable', () => {
    // A small local model that ignored the JSON instruction is exactly the case
    // a re-ask fixes: sampling is stochastic, and the retry nudges the
    // temperature. Calling this fatal showed a red error on the first try.
    expect(isTransientLLMError(new Error('Model output was not valid JSON. Got: …'))).toBe(true);
    expect(isTransientLLMError(new Error('LLM returned an empty page'))).toBe(true);
    expect(isTransientLLMError(new Error('The LLM server returned an empty response body.'))).toBe(
      true,
    );
  });

  it('re-sends a server that is not ready yet, and a 5xx it or its proxy emitted', () => {
    expect(isTransientLLMError(new Error('LLM server responded 500: Model is loading.'))).toBe(
      true,
    );
    expect(isTransientLLMError(new Error('The local LLM server is still loading the model'))).toBe(
      true,
    );
    expect(isTransientLLMError(new Error('LLM server responded 502: bad gateway'))).toBe(true);
  });

  it('never re-sends a wrong key, a wrong model name or a real generation failure', () => {
    expect(
      isTransientLLMError(
        new Error(
          'LLM server rejected the request (HTTP 401). If this endpoint requires an API key',
        ),
      ),
    ).toBe(false);
    expect(isTransientLLMError(new Error('LLM server responded 404: model not found'))).toBe(false);
    expect(
      isTransientLLMError(
        new Error('LLM server reported an error while generating: context overflow'),
      ),
    ).toBe(false);
  });
});

// A local server with a single generation slot (LM Studio's default, llama.cpp
// with `-np 1`) rejects a second concurrent request instead of queueing it.
// Symptom this protects: writing page 1 of a new book showed "LLM server
// responded 400: Only one request at a time is allowed" notices about the
// app's own background upkeep calls.
describe('a busy single-slot server', () => {
  it('recognises the 429 the app gets when a second request overlaps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { message: 'Only one request at a time is allowed.' } }, 429),
      ),
    );
    const err = await chat({ endpoint: openai, model: 'm' }, MESSAGES).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('busy');
    expect((err as Error).message).toContain('generation slot');
    expect(isServerBusyError(err)).toBe(true);
    // Worth re-sending — the slot frees as soon as the other request ends.
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('recognises LM Studio\u2019s HTTP 400 wording as busy, not as a bad request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'Only one request at a time is allowed on this server.' }, 400),
      ),
    );
    const err = await chat({ endpoint: openai, model: 'm' }, MESSAGES).catch((e: unknown) => e);
    expect(isServerBusyError(err)).toBe(true);
    expect((err as Error).message).toContain('generation slot');
  });

  it('still reports an ordinary 400 as an ordinary failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'model not found' }, 400)),
    );
    const err = await chat({ endpoint: openai, model: 'm' }, MESSAGES).catch((e: unknown) => e);
    expect((err as Error).message).toContain('LLM server responded 400');
    expect(isServerBusyError(err)).toBe(false);
    expect(isTransientLLMError(err)).toBe(false);
  });

  it('a 503 is transient too — the server is still loading the model', () => {
    expect(isTransientLLMError(new Error('LLM server responded 503'))).toBe(true);
  });
});

describe('multi-line SSE events', () => {
  it('joins data: lines of one event instead of dropping them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse('text/event-stream', [
          'data: {"choices":[{"delta":{"content":\n',
          'data: "Hello"}}]}\n\ndata: [DONE]\n\n',
        ]),
      ),
    );
    const tokens: string[] = [];
    const text = await chat(
      { endpoint: openai, model: 'm', onToken: (t) => tokens.push(t) },
      MESSAGES,
    );
    expect(text).toBe('Hello');
    expect(tokens.join('')).toBe('Hello');
  });

  it('still throws when an error payload spans several data: lines', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse('text/event-stream', [
          'data: {"error":\n',
          'data: "CUDA out of memory"}\n\ndata: [DONE]\n\n',
        ]),
      ),
    );
    await expect(
      chat({ endpoint: openai, model: 'm', onToken: () => {} }, MESSAGES),
    ).rejects.toThrow(/CUDA out of memory/);
  });
});
