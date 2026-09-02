/**
 * llm/probe.ts — local LLM discovery.
 *
 * Strategy: for each known candidate endpoint, attempt a CORS fetch of its
 * model list. A response that *resolves* (any HTTP status) proves the server
 * is reachable AND CORS works — browsers throw TypeError for both connection
 * failures and missing CORS headers, so a resolved fetch is a clean signal.
 * Only after pure TypeErrors do we fall back to a `no-cors` presence check:
 * an opaque response means "an HTTP server answered here, but it won't talk
 * to this page's origin" — reported as `cors-blocked` with actionable help.
 */
import { CANDIDATES, modelListUrls, parseModelsResponse } from './endpoints';
import type { EndpointCandidate } from './endpoints';

export type ProbeStatus = 'reachable' | 'cors-blocked' | 'absent';

export interface ProbeResult {
  candidate: EndpointCandidate;
  status: ProbeStatus;
  models: string[];
  latencyMs: number | null;
  detail: string;
}

export interface TimeoutHandle {
  signal: AbortSignal;
  cancel: () => void;
}

export function timeoutSignal(ms: number): TimeoutHandle {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export async function probeCandidate(
  candidate: EndpointCandidate,
  timeoutMs = 1800,
): Promise<ProbeResult> {
  const urls = modelListUrls(candidate);

  // Pass 1: CORS fetch each model-list URL.
  let lastHttpStatus: number | null = null;
  let networkError = false;
  for (const url of urls) {
    const t = timeoutSignal(timeoutMs);
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: t.signal,
      });
      lastHttpStatus = response.status;
      if (!response.ok) continue; // e.g. Ollama without /v1 — try the next URL
      let models: string[] = [];
      try {
        models = parseModelsResponse(candidate.vendor, await response.json());
      } catch {
        models = []; // server answered 200 with non-JSON — reachable, list unreadable
      }
      return {
        candidate,
        status: 'reachable',
        models,
        latencyMs: Math.round(performance.now() - started),
        detail:
          models.length > 0
            ? `${models.length} model(s) loaded`
            : 'server responded; model list empty or unreadable',
      };
    } catch {
      // TypeError = connection refused OR CORS rejection; abort = timeout.
      networkError = true;
    } finally {
      t.cancel();
    }
  }

  // A resolved-but-non-OK response means the server IS reachable and CORS
  // works (a CORS failure throws) — it just doesn't expose this model list.
  if (lastHttpStatus !== null) {
    return {
      candidate,
      status: 'reachable',
      models: [],
      latencyMs: null,
      detail: `server answered HTTP ${lastHttpStatus} to the model-list probe`,
    };
  }

  // Pass 2: no-cors presence check (opaque response = an HTTP server is there).
  if (networkError) {
    for (const url of [urls[0], candidate.baseUrl]) {
      if (url === undefined) continue;
      const t = timeoutSignal(timeoutMs);
      try {
        await fetch(url, { method: 'GET', mode: 'no-cors', signal: t.signal });
        return {
          candidate,
          status: 'cors-blocked',
          models: [],
          latencyMs: null,
          detail:
            'An HTTP server answered, but either CORS refused this page’s origin or it is not an LLM endpoint. Enable CORS for localhost origins in the server settings — or open Page Turn from a localhost URL.',
        };
      } catch {
        // keep trying the next URL
      } finally {
        t.cancel();
      }
    }
  }

  return { candidate, status: 'absent', models: [], latencyMs: null, detail: 'no response' };
}

/**
 * Probe all candidates with bounded parallelism. Sequential probing is slow
 * (dozens of seconds worst case); four workers keeps the scan snappy while
 * staying polite to local servers.
 */
export async function discover(
  onProgress?: (result: ProbeResult, index: number, total: number) => void,
  timeoutMs = 1800,
  concurrency = 4,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const queue = [...CANDIDATES];
  let done = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length)) },
    async () => {
      for (;;) {
        const candidate = queue.shift();
        if (!candidate) return;
        const result = await probeCandidate(candidate, timeoutMs);
        results.push(result);
        onProgress?.(result, done, CANDIDATES.length);
        done++;
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** The best reachable endpoint, or null. */
export function bestReachable(results: ProbeResult[]): ProbeResult | null {
  const withModels = results.find((r) => r.status === 'reachable' && r.models.length > 0);
  return withModels ?? results.find((r) => r.status === 'reachable') ?? null;
}
