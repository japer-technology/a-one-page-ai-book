import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, chatJSON, isTransientLLMError } from '../src/llm/client';
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
    expect(isTransientLLMError(new Error('Model output was not valid JSON'))).toBe(false);
  });
});
