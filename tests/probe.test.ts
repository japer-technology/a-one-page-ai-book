import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANDIDATES, modelListUrls } from '../src/llm/endpoints';
import type { EndpointCandidate } from '../src/llm/endpoints';
import { bestReachable, discover, probeCandidate } from '../src/llm/probe';

/**
 * probe.ts talks to the network only through global fetch — stub it to test
 * every diagnosis path: reachable, reachable-without-model-list, cors-blocked,
 * and absent. Node 22 provides DOMException/performance/fetch natively.
 */

const candidate: EndpointCandidate = {
  id: 'lmstudio',
  label: 'LM Studio',
  baseUrl: 'http://127.0.0.1:1234',
  vendor: 'openai-compat',
  note: '',
};

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeCandidate', () => {
  it('reports reachable with models when the model list parses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] })),
    );
    const result = await probeCandidate(candidate, 500);
    expect(result.status).toBe('reachable');
    expect(result.models).toEqual(['model-a', 'model-b']);
    expect(result.latencyMs).not.toBeNull();
  });

  it('reports reachable with empty models when the payload is not a model list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ hello: 'world' })),
    );
    const result = await probeCandidate(candidate, 500);
    expect(result.status).toBe('reachable');
    expect(result.models).toEqual([]);
    expect(result.detail).toContain('model list empty or unreadable');
  });

  it('treats a resolved non-OK response as reachable, not CORS-blocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 404)),
    );
    const result = await probeCandidate(candidate, 500);
    expect(result.status).toBe('reachable');
    expect(result.models).toEqual([]);
    expect(result.detail).toContain('HTTP 404');
  });

  it('distinguishes cors-blocked (TypeError, then opaque) from absent (both fail)', async () => {
    const corsReject = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const opaque = vi.fn(
      async () => ({ ok: false, status: 0, type: 'opaque' }) as unknown as Response,
    );
    vi.stubGlobal('fetch', corsReject);
    let result = await probeCandidate(candidate, 500);
    expect(result.status).toBe('absent');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementationOnce(corsReject).mockImplementationOnce(opaque),
    );
    result = await probeCandidate(candidate, 500);
    expect(result.status).toBe('cors-blocked');
    expect(result.detail).toContain('CORS');
  });

  it('tries both Ollama URLs and parses native tags', async () => {
    const ollama: EndpointCandidate = {
      ...candidate,
      vendor: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
    };
    const fetchMock = vi.fn(async () => jsonResponse({ models: [{ name: 'llama3.2:3b' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeCandidate(ollama, 500);
    expect(result.status).toBe('reachable');
    expect(result.models).toEqual(['llama3.2:3b']);
    expect(modelListUrls(ollama)).toHaveLength(2);
  });
});

describe('discover', () => {
  it('probes every candidate and reports progress', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const seen: string[] = [];
    const results = await discover((result, index, total) => {
      seen.push(`${index}/${total}:${result.candidate.id}`);
    }, 200);
    expect(results).toHaveLength(CANDIDATES.length);
    expect(seen).toHaveLength(CANDIDATES.length);
    expect(results.every((r) => r.status === 'absent')).toBe(true);
  });

  it('finishes quickly thanks to bounded parallelism', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        throw new TypeError('Failed to fetch');
      }),
    );
    await discover(undefined, 300);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });
});

describe('bestReachable', () => {
  it('prefers an endpoint with models', () => {
    const withModels = {
      candidate,
      status: 'reachable' as const,
      models: ['x'],
      latencyMs: 10,
      detail: '',
    };
    const withoutModels = { ...withModels, models: [] };
    expect(bestReachable([withoutModels, withModels])).toBe(withModels);
    expect(bestReachable([])).toBeNull();
  });
});
