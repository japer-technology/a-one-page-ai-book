/**
 * llm/probe.ts — local LLM discovery.
 *
 * Strategy: for each known candidate endpoint, attempt a CORS fetch of its
 * model list. If that fails (network error OR missing CORS headers — browsers
 * report both as TypeError), do a `no-cors` presence check: an opaque response
 * means "an HTTP server answered here, but it won't talk to this page's
 * origin", which we report as `cors-blocked` with actionable guidance.
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

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

export async function probeCandidate(
  candidate: EndpointCandidate,
  timeoutMs = 1800,
): Promise<ProbeResult> {
  const urls = modelListUrls(candidate);

  // Pass 1: CORS fetch each model-list URL.
  let corsNetworkError = false;
  for (const url of urls) {
    const t = timeoutSignal(timeoutMs);
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: t.signal,
      });
      if (response.ok) {
        const models = parseModelsResponse(candidate.vendor, await response.json());
        return {
          candidate,
          status: 'reachable',
          models,
          latencyMs: Math.round(performance.now() - started),
          detail:
            models.length > 0
              ? `${models.length} model(s) loaded`
              : 'server responded; no models listed yet',
        };
      }
      corsNetworkError = true;
    } catch (err) {
      if (isAbort(err)) {
        // Timed out — treat as absent unless a no-cors check says otherwise.
        corsNetworkError = true;
      } else {
        corsNetworkError = true; // TypeError: connection refused OR CORS rejection
      }
    } finally {
      t.cancel();
    }
  }

  // Pass 2: no-cors presence check (opaque response = an HTTP server is there).
  if (corsNetworkError) {
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
            'A server answered, but it refused this page’s origin (CORS). Enable CORS for localhost origins in the server settings — or run Page Turn from a localhost URL.',
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

/** Probe all candidates sequentially (keeps local servers calm). */
export async function discover(
  onProgress?: (result: ProbeResult, index: number, total: number) => void,
  timeoutMs = 1800,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (let i = 0; i < CANDIDATES.length; i++) {
    const candidate = CANDIDATES[i];
    if (!candidate) continue;
    const result = await probeCandidate(candidate, timeoutMs);
    results.push(result);
    onProgress?.(result, i, CANDIDATES.length);
  }
  return results;
}

/** The best reachable endpoint, or null. */
export function bestReachable(results: ProbeResult[]): ProbeResult | null {
  const withModels = results.find((r) => r.status === 'reachable' && r.models.length > 0);
  return withModels ?? results.find((r) => r.status === 'reachable') ?? null;
}
