/**
 * tests/retry.test.ts — the retry policy for local model calls.
 *
 * Every assertion here protects a behaviour a reader can see: how long the app
 * waits before it gives up on a local server hiccup, how many times it re-sends
 * a request, and which failures it must NOT re-send (a wrong API key, a wrong
 * model name, a cancelled generation) because re-sending them would only make
 * the reader wait longer for the same answer.
 *
 * The backoffs are real timers, so the tests that drive the loop run under fake
 * timers and pump them with `settle` below. Nothing in `src/llm/retry.ts` is
 * stubbed: the waits under test are the waits that ship.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  announcesRetry,
  classifyLLMFailure,
  isRetryableLLMFailure,
  llmRetryDelayMs,
  maxLLMAttempts,
  retryNotice,
  retryTemperature,
  sleepAbortable,
  withLLMRetry,
  type LLMFailureKind,
  type LLMRetryInfo,
} from '../src/llm/retry';
import { chat } from '../src/llm/client';
import type { EndpointSettings } from '../src/core/types';

const endpoint: EndpointSettings = {
  name: 'test',
  baseUrl: 'http://127.0.0.1:1234',
  vendor: 'openai-compat',
  model: 'm',
  temperature: 0.9,
  apiKey: '',
};

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Let a promise settle while its backoff timers are driven forward. The retry
 * ladders reach tens of seconds on purpose, so they cannot be waited out in
 * real time; skipping the clock keeps the assertions about the ladder itself.
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 20 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
    await tracked;
  }
  return promise;
}

/** Run the retry loop with fake timers, and report how many attempts it made. */
async function runRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: { background?: boolean; signal?: AbortSignal; onRetry?: (i: LLMRetryInfo) => void } = {},
): Promise<{ ok: boolean; value: T | undefined; calls: number; error: unknown }> {
  let calls = 0;
  const promise = withLLMRetry<T>(async (ctx) => {
    calls++;
    return fn(ctx.attempt);
  }, options);
  const outcome = await settle(
    promise.then(
      (v) => ({ ok: true as const, error: undefined, value: v }),
      (e: unknown) => ({ ok: false as const, error: e, value: undefined }),
    ),
  );
  return { ...outcome, calls };
}

/** A request that fails `failTimes` times with `error`, then succeeds. */
function flaky<T>(failTimes: number, error: unknown, value: T) {
  return (attempt: number): Promise<T> => {
    if (attempt < failTimes) return Promise.reject(error);
    return Promise.resolve(value);
  };
}

const busy = () => new Error('LLM server responded 503');
const auth = () =>
  new Error(
    'LLM server rejected the request (HTTP 401: unauthorized). If this endpoint requires an API key, add it in Settings.',
  );

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('classifyLLMFailure', () => {
  it('reads a busy single generation slot as busy', () => {
    expect(classifyLLMFailure(busy())).toBe('busy');
    expect(
      classifyLLMFailure(
        new Error('LLM server is busy (HTTP 429) — its one generation slot is already in use.'),
      ),
    ).toBe('busy');
    expect(
      classifyLLMFailure(
        new Error('LLM server is busy (HTTP 400: Only one request at a time is allowed.)'),
      ),
    ).toBe('busy');
  });

  it('reads a model that is not in memory yet as warming, not as a bad request', () => {
    // LM Studio answers 400/500 "Model is loading."; Ollama answers
    // {"error":"model … is loading, please wait"}. Both mean "wait a moment",
    // and reporting either as a hard 400/500 error was the bug.
    expect(classifyLLMFailure(new Error('LLM server responded 400: Model is loading.'))).toBe(
      'warming',
    );
    expect(classifyLLMFailure(new Error('LLM server responded 500: Model is loading.'))).toBe(
      'warming',
    );
    expect(classifyLLMFailure(new Error('model "llama3" is not loaded'))).toBe('warming');
    expect(classifyLLMFailure(new Error('model is loading, please wait'))).toBe('warming');
  });

  it('reads a dead connection and a 5xx as transport failures', () => {
    expect(classifyLLMFailure(new TypeError('Failed to fetch'))).toBe('unreachable');
    expect(classifyLLMFailure(new Error('ECONNREFUSED'))).toBe('unreachable');
    expect(classifyLLMFailure(new Error('LLM server responded 500: internal error'))).toBe(
      'gateway',
    );
    expect(classifyLLMFailure(new Error('LLM server responded 502: bad gateway'))).toBe('gateway');
    expect(classifyLLMFailure(new Error('LLM server responded 504: gateway timeout'))).toBe(
      'gateway',
    );
  });

  it('reads an unusable answer as its own kind', () => {
    expect(classifyLLMFailure(new Error('LLM returned an empty page'))).toBe('empty');
    expect(classifyLLMFailure(new Error('The LLM server returned an empty response body.'))).toBe(
      'empty',
    );
    expect(classifyLLMFailure(new Error('Model output was not valid JSON. Got: Sure!'))).toBe(
      'bad-json',
    );
  });

  it('does not mistake the empty-body advice for a model that is loading', () => {
    // The client's own wording suggests checking "whether the model is still
    // loaded", which brushes against the warming vocabulary. It is an empty
    // answer, and getting that wrong would put a 15-second model-load wait behind
    // a string the model never produced.
    expect(
      classifyLLMFailure(
        new Error(
          'The LLM server returned an empty response body. Check the endpoint in Settings (and whether the model is still loaded).',
        ),
      ),
    ).toBe('empty');
  });

  it('treats a wrong key, a wrong model name and a real generation failure as final', () => {
    expect(classifyLLMFailure(auth())).toBe('fatal');
    // 404 is Ollama's "model not found": a Settings problem, not a readiness one.
    expect(classifyLLMFailure(new Error('LLM server responded 404: model not found'))).toBe(
      'fatal',
    );
    expect(
      classifyLLMFailure(
        new Error('LLM server reported an error while generating: CUDA out of memory'),
      ),
    ).toBe('fatal');
    expect(
      classifyLLMFailure(
        new Error('LLM server reported an error while generating: context overflow'),
      ),
    ).toBe('fatal');
  });

  it('never re-sends a cancelled or timed-out generation', () => {
    // The signal is dead: a retry would fail instantly and report "cancelled"
    // for a request the reader never saw start.
    expect(classifyLLMFailure(new DOMException('x', 'AbortError'))).toBe('fatal');
    expect(classifyLLMFailure(new DOMException('x', 'TimeoutError'))).toBe('fatal');
    expect(classifyLLMFailure(new Error('Generation cancelled.'))).toBe('fatal');
    expect(isRetryableLLMFailure('fatal')).toBe(false);
  });
});

describe('the retry ladders', () => {
  const RETRYABLE: LLMFailureKind[] = [
    'busy',
    'warming',
    'unreachable',
    'gateway',
    'empty',
    'bad-json',
  ];

  it('gives a busy or warming server several attempts, with growing waits', () => {
    expect(maxLLMAttempts('busy')).toBeGreaterThanOrEqual(3);
    expect(maxLLMAttempts('warming')).toBeGreaterThanOrEqual(3);
    for (const kind of RETRYABLE) {
      expect(maxLLMAttempts(kind), kind).toBeGreaterThan(1);
      const first = llmRetryDelayMs(kind, 1);
      const last = llmRetryDelayMs(kind, maxLLMAttempts(kind) - 1);
      expect(last, kind).toBeGreaterThan(first);
    }
  });

  it('never leaves a hole in the ladder', () => {
    // Every attempt below the cap must have a defined wait, or a retry would
    // fire twice back to back against a server that is still busy.
    for (const kind of RETRYABLE) {
      for (let attempt = 1; attempt < maxLLMAttempts(kind); attempt++) {
        expect(llmRetryDelayMs(kind, attempt), `${kind} attempt ${attempt}`).toBeGreaterThan(0);
      }
    }
    expect(maxLLMAttempts('fatal')).toBe(1);
    expect(llmRetryDelayMs('fatal', 1)).toBe(0);
  });

  it('keeps housekeeping short so it never makes the reader wait', () => {
    for (const kind of RETRYABLE) {
      expect(maxLLMAttempts(kind, true), kind).toBeLessThanOrEqual(maxLLMAttempts(kind, false));
      for (let attempt = 1; attempt < maxLLMAttempts(kind, true); attempt++) {
        expect(
          llmRetryDelayMs(kind, attempt, true),
          `${kind} attempt ${attempt}`,
        ).toBeLessThanOrEqual(3000);
      }
    }
  });

  it('stays quiet about a fast re-ask and speaks up about a long wait', () => {
    // A structured answer re-asked 350 ms later needs no toast; a server held by
    // another app for 15 s must say so, or the pause reads as a hang.
    expect(announcesRetry('bad-json')).toBe(false);
    expect(announcesRetry('busy')).toBe(true);
    expect(announcesRetry('warming')).toBe(true);
    expect(announcesRetry('unreachable')).toBe(true);
    expect(announcesRetry('gateway')).toBe(true);
    // A failure that is not retried is never announced.
    expect(announcesRetry('fatal')).toBe(false);
  });

  it('says what is actually happening in each retry notice', () => {
    const notice = (kind: LLMFailureKind) =>
      retryNotice({ attempt: 1, kind, delayMs: 0, totalAttempts: maxLLMAttempts(kind) });
    expect(notice('busy')).toMatch(/busy/);
    expect(notice('warming')).toMatch(/loading/);
    expect(notice('unreachable')).toMatch(/reach/);
    expect(notice('gateway')).toMatch(/hiccup/);
    expect(notice('empty')).toMatch(/nothing/);
    expect(notice('bad-json')).toMatch(/JSON/);
    // The count is the attempts still available after this one.
    expect(notice('busy')).toContain(`1 of ${maxLLMAttempts('busy') - 1}`);
  });
});

describe('retryTemperature', () => {
  it('leaves the reader’s own setting alone on the first attempt', () => {
    expect(retryTemperature(0.9, 0)).toBe(0.9);
  });

  it('nudges the sampling on a retry, and stays inside the schema range', () => {
    expect(retryTemperature(0.9, 1)).toBeGreaterThan(0.9);
    expect(retryTemperature(2, 3)).toBe(2);
    expect(retryTemperature(0, 1)).toBeGreaterThan(0);
    // A missing temperature falls back to the client's own default.
    expect(retryTemperature(undefined, 1)).toBeGreaterThan(0.9);
  });
});

describe('withLLMRetry', () => {
  it('succeeds on the first attempt without ever retrying', async () => {
    const onRetry = vi.fn();
    const result = await runRetry(() => Promise.resolve('page'), { onRetry });
    expect(result.value).toBe('page');
    expect(result.calls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('re-sends a busy server until the slot frees', async () => {
    const onRetry = vi.fn<(info: LLMRetryInfo) => void>();
    const result = await runRetry(flaky(2, busy(), 'page'), { onRetry });
    expect(result.value).toBe('page');
    expect(result.calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, kind: 'busy' });
    expect(onRetry.mock.calls[1]?.[0]).toMatchObject({ attempt: 2, kind: 'busy' });
  });

  it('gives up after the ladder is exhausted and re-throws the real reason', async () => {
    const result = await runRetry(flaky(99, busy(), 'never'));
    expect(result.ok).toBe(false);
    expect(result.calls).toBe(maxLLMAttempts('busy'));
    expect((result.error as Error).message).toContain('503');
  });

  it('does not retry a fatal failure even once', async () => {
    const result = await runRetry(flaky(99, auth(), 'never'));
    expect(result.calls).toBe(1);
    expect((result.error as Error).message).toContain('401');
  });

  it('re-sends a 400 "Model is loading." reply instead of reporting a bad request', async () => {
    // The symptom this protects: LM Studio answers 400 while it pages the model
    // in, and the app used to surface a red "LLM server responded 400" for a
    // server that was simply not ready.
    const result = await runRetry(
      flaky(1, new Error('LLM server responded 400: Model is loading.'), 'page'),
    );
    expect(result.value).toBe('page');
    expect(result.calls).toBe(2);
  });

  it('re-sends an empty page, an empty body and a malformed JSON answer', async () => {
    for (const message of [
      'LLM returned an empty page',
      'The LLM server returned an empty response body.',
      'Model output was not valid JSON. Got: x',
    ]) {
      const result = await runRetry(flaky(1, new Error(message), 'page'));
      expect(result.calls, message).toBe(2);
      expect(result.value, message).toBe('page');
    }
  });

  it('nudges the temperature only after the model answered unusably', async () => {
    // After an empty page the model DID answer — just not with anything usable.
    // A near-greedy local model reproduces the same empty answer on a
    // byte-identical re-send, so the retry samples a little warmer.
    const resampled: Array<number | undefined> = [];
    await settle(
      withLLMRetry<string>(async (ctx) => {
        resampled.push(ctx.temperature(0.9));
        if (resampled.length === 1) throw new Error('LLM returned an empty page');
        return 'page';
      }, {}),
    );
    expect(resampled[0]).toBe(0.9);
    expect(resampled[1]).toBeGreaterThan(0.9);

    // A transport failure never reached the model: the same request is re-sent
    // unchanged, so a story is not re-sampled for a hiccup in the wire.
    const transport: Array<number | undefined> = [];
    await settle(
      withLLMRetry<string>(async (ctx) => {
        transport.push(ctx.temperature(0.9));
        if (transport.length === 1) throw busy();
        return 'page';
      }, {}),
    );
    expect(transport).toEqual([0.9, 0.9]);
  });

  it('reports the previous failure’s kind to the request builder', async () => {
    const kinds: Array<string | null> = [];
    await settle(
      withLLMRetry<string>(async (ctx) => {
        kinds.push(ctx.previousKind);
        if (kinds.length === 1) throw busy();
        return 'page';
      }, {}),
    );
    expect(kinds).toEqual([null, 'busy']);
  });

  it('stops immediately when the reader cancels mid-backoff', async () => {
    const controller = new AbortController();
    const onRetry = vi.fn(() => controller.abort(new DOMException('cancelled', 'AbortError')));
    let calls = 0;
    const promise = withLLMRetry<string>(
      async () => {
        calls++;
        throw busy();
      },
      { signal: controller.signal, onRetry },
    );
    const outcome = await settle(
      promise.then(
        (v) => ({ ok: true as const, error: undefined, value: v }),
        (e: unknown) => ({ ok: false as const, error: e, value: undefined }),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(DOMException);
    expect((outcome.error as DOMException).name).toBe('AbortError');
    // One announced retry, and no second request after the cancel: a retry on a
    // dead signal would fail instantly with a misleading "cancelled".
    expect(calls).toBe(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not wait at all when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleepAbortable(60_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('a flaky local server recovers end to end through chat()', () => {
  const recoveryCases: Array<{ label: string; first: () => Response }> = [
    {
      label: 'the model is still loading',
      first: () => jsonResponse({ error: 'Model is loading.' }, 500),
    },
    {
      label: 'the one generation slot is busy',
      first: () =>
        jsonResponse({ error: { message: 'Only one request at a time is allowed.' } }, 429),
    },
    {
      label: 'the gateway blinked (502)',
      first: () => new Response('bad gateway', { status: 502 }),
    },
    {
      label: 'the server answered 200 with nothing',
      first: () => jsonResponse({ choices: [{ message: { content: '' } }] }),
    },
  ];

  for (const { label, first } of recoveryCases) {
    it(`answers anyway when ${label}, then the model works`, async () => {
      let calls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          calls++;
          if (calls === 1) return first();
          return jsonResponse({ choices: [{ message: { content: 'The keeper waited.' } }] });
        }),
      );
      const text = await settle(
        withLLMRetry((ctx) =>
          chat(
            {
              endpoint,
              model: 'm',
              temperature: ctx.temperature(endpoint.temperature),
            },
            MESSAGES,
          ),
        ),
      );
      expect(text).toBe('The keeper waited.');
      expect(calls).toBe(2);
    });
  }

  it('still reports a wrong API key at once, without re-sending it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'unauthorized' } }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const outcome = await settle(
      withLLMRetry(() => chat({ endpoint, model: 'm' }, MESSAGES)).then(
        (v) => ({ ok: true as const, error: undefined, value: v }),
        (e: unknown) => ({ ok: false as const, error: e, value: undefined }),
      ),
    );
    expect(outcome.ok).toBe(false);
    expect((outcome.error as Error).message).toMatch(/API key/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('model load failures are not retried', () => {
  it('treats an out-of-memory 500 as fatal', () => {
    expect(
      classifyLLMFailure(
        new Error(
          'LLM server responded 500: model requires more system memory (11 GiB) than is available',
        ),
      ),
    ).toBe('fatal');
    expect(
      classifyLLMFailure(new Error('LLM server responded 500: CUDA error: out of memory')),
    ).toBe('fatal');
    expect(
      classifyLLMFailure(
        new Error('LLM server responded 500: the input exceeds the context length'),
      ),
    ).toBe('fatal');
  });

  it('still retries an ordinary 500', () => {
    expect(classifyLLMFailure(new Error('LLM server responded 500: internal error'))).toBe(
      'gateway',
    );
  });
});
