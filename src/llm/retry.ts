/**
 * llm/retry.ts — how often a local model call is re-sent before the app tells
 * the reader that something broke.
 *
 * The governing fact about a local LLM is that **every request is a brand-new
 * conversation**. There is no session on the server: the client sends the whole
 * system prompt, the whole story context and the whole message list on each
 * call, and the server keeps nothing between calls. That is exactly what makes
 * re-sending a failed request safe — a retry is not a "continue where you left
 * off", it is the identical (or deliberately re-sampled) request sent again.
 *
 * It is also why the retry budget has to be generous. Every failure this module
 * retries is a *transport or readiness* failure of a local process the reader
 * runs themselves: a second app or browser tab holding the server's single
 * generation slot, a model still being paged in from disk, a proxy in front of
 * llama.cpp blinking after a restart, a model that answered 200 with nothing
 * because the slot was contended. None of those are the reader's mistake, and
 * all of them usually clear within seconds. Reporting a red error on the first
 * one — which is what this app used to do — makes a working local setup look
 * broken.
 *
 * Nothing in here touches the DOM or performs I/O; the whole policy is pure and
 * unit-tested.
 */
import { isServerBusyError, isServerWarmingError } from './client';

/** Why an LLM call failed, in the terms the retry policy cares about. */
export type LLMFailureKind =
  /** The server's one generation slot is held by something else. */
  | 'busy'
  /** The server is up but the model is not in memory yet (or is being swapped). */
  | 'warming'
  /** Nothing answered: connection refused, CORS, a dropped socket. */
  | 'unreachable'
  /** A 5xx from the server itself or from a proxy in front of it. */
  | 'gateway'
  /** The server answered 200 but produced no usable text. */
  | 'empty'
  /** A structured phase answered with something that is not parsable JSON. */
  | 'bad-json'
  /** Retrying cannot help: bad credentials, a wrong model name, a real abort… */
  | 'fatal';

interface RetryPolicy {
  /** Total attempts, INCLUDING the first one. */
  attempts: number;
  /** Wait before attempt 2, 3, 4 … (index = attempt number already made − 1). */
  delays: number[];
  /**
   * Whether the reader is told about the retry. Long waits must be explained —
   * an unexplained pause on a local server reads as a hang. A re-ask that costs
   * a few hundred milliseconds is not worth a toast that flashes past.
   */
  announce: boolean;
}

/**
 * The ladders. Delays grow because the conditions behind them need time to
 * clear: a competing generation has to finish, model weights have to reach
 * memory. They stay bounded because the reader is waiting.
 */
const FULL_POLICY: Record<LLMFailureKind, RetryPolicy> = {
  busy: { attempts: 4, delays: [1500, 5000, 12000], announce: true },
  warming: { attempts: 4, delays: [2500, 7000, 15000], announce: true },
  unreachable: { attempts: 4, delays: [600, 1800, 4000], announce: true },
  gateway: { attempts: 4, delays: [1000, 3000, 7000], announce: true },
  empty: { attempts: 4, delays: [400, 1200, 3000], announce: true },
  // A small model that wrote prose where JSON was asked for usually complies on
  // the next sample — cheap and fast, so no notice and a tight ladder.
  'bad-json': { attempts: 3, delays: [350, 900], announce: false },
  fatal: { attempts: 1, delays: [], announce: false },
};

/**
 * Background upkeep (the living cast, the rolling summary) shares the reader's
 * single generation slot, so its backoff would be time the reader spends
 * waiting for housekeeping. It gets fewer, shorter waits: it retries enough to
 * survive a hiccup, never enough to hold up a page.
 */
const BACKGROUND_POLICY: Record<LLMFailureKind, RetryPolicy> = {
  busy: { attempts: 3, delays: [800, 2500], announce: true },
  warming: { attempts: 3, delays: [1000, 3000], announce: true },
  unreachable: { attempts: 3, delays: [400, 1200], announce: true },
  gateway: { attempts: 3, delays: [600, 1800], announce: true },
  empty: { attempts: 3, delays: [300, 900], announce: false },
  'bad-json': { attempts: 3, delays: [350, 900], announce: false },
  fatal: { attempts: 1, delays: [], announce: false },
};

export function policyFor(kind: LLMFailureKind, background = false): RetryPolicy {
  return background ? BACKGROUND_POLICY[kind] : FULL_POLICY[kind];
}

/** Attempts (including the first) this failure is worth. */
export function maxLLMAttempts(kind: LLMFailureKind, background = false): number {
  return policyFor(kind, background).attempts;
}

/** Wait before retrying `failedAttempt` (1-based) after a `kind` failure. */
export function llmRetryDelayMs(
  kind: LLMFailureKind,
  failedAttempt: number,
  background = false,
): number {
  const { delays } = policyFor(kind, background);
  const index = Math.max(0, failedAttempt - 1);
  return delays[index] ?? delays[delays.length - 1] ?? 0;
}

// ---- Classification ---------------------------------------------------------

/** Connection-level failures: fetch never got an HTTP response at all. */
const NETWORK_RE =
  /Failed to fetch|NetworkError|Load failed|fetch failed|ECONNREFUSED|ECONNRESET|ERR_CONNECTION|ERR_NETWORK|net::ERR|socket hang up|connection (?:refused|reset|closed)/i;

/** A 200 that carried nothing usable, from any phase of the app. */
const EMPTY_RE = /returned an empty|empty response body|returned no usable|returned nothing/i;

/** A structured phase whose answer could not be parsed (see core/parsers.ts). */
const BAD_JSON_RE = /not valid JSON|Unexpected token|Unexpected end of JSON|is not JSON/i;

/** `LLM server responded 500: …` — the status the HTTP layer reported. */
const STATUS_RE = /LLM server responded (\d{3})/;

/**
 * Local-model LOAD failures. They arrive as an ordinary HTTP 500, but the
 * condition cannot change between attempts — loading a model into memory fails
 * the same way every time. The mid-stream taxonomy already treats this wording
 * as fatal; the pre-stream classifier did not, so a doomed request climbed the
 * whole gateway ladder.
 */
const OUT_OF_RESOURCES_RE =
  /out of memory|requires more (?:system )?memory|insufficient memory|not enough memory|context (?:length|size|window) (?:is )?(?:too|exceed)|exceeds? the context|context overflow|too large for (?:the|this) (?:context|model|memory|gpu)|failed to allocate|CUDA error/i;

/**
 * An abort or a timeout is never retryable: the signal is dead, so a retry
 * would fail instantly with a misleading "cancelled" error, and a generation
 * that burned its whole ceiling will burn it again.
 */
function isAbortLike(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /Generation cancelled|Generation timed out|aborted|AbortError|TimeoutError/i.test(message);
}

/**
 * Classify a failure. Order matters: the narrow, actionable causes are tested
 * before the broad ones, because a server's own wording is what distinguishes
 * "wait a moment" from "this will never work".
 */
export function classifyLLMFailure(err: unknown): LLMFailureKind {
  if (isAbortLike(err)) return 'fatal';
  const message = err instanceof Error ? err.message : String(err);
  // The busy and warming verdicts are shared with the HTTP layer: 429/503 and
  // LM Studio's HTTP 400 "Only one request at a time is allowed" are busy, and
  // "Model is loading." / "model is not loaded" are warming.
  if (isServerBusyError(err)) return 'busy';
  if (NETWORK_RE.test(message)) return 'unreachable';
  if (isServerWarmingError(err)) return 'warming';
  if (BAD_JSON_RE.test(message)) return 'bad-json';
  if (EMPTY_RE.test(message)) return 'empty';
  const status = Number(STATUS_RE.exec(message)?.[1] ?? 0);
  // A 5xx is not automatically "the server hiccuped, try again": the common
  // local-model LOAD failures arrive as HTTP 500 with memory wording, and the
  // condition cannot change between attempts — loading the model fails the
  // same way every time. The mid-stream taxonomy already treats this wording
  // as fatal; here it was taking the full gateway ladder (4 attempts, ~11 s of
  // "the local server hiccuped" announcements) before showing the real error.
  if (OUT_OF_RESOURCES_RE.test(message)) return 'fatal';
  if (status >= 500 && status <= 599) return 'gateway';
  // Everything else — 401/403, 404 (wrong model or URL), a malformed body, a
  // server-reported generation error (OOM, context overflow) — is the answer.
  return 'fatal';
}

/** Is this failure one a re-sent request could plausibly survive? */
export function isRetryableLLMFailure(kind: LLMFailureKind): boolean {
  return kind !== 'fatal';
}

/**
 * Should this error be re-sent? Kept as the one public predicate so no caller
 * has to know the taxonomy.
 */
export function isTransientLLMError(err: unknown): boolean {
  return isRetryableLLMFailure(classifyLLMFailure(err));
}

/**
 * Should the reader be told that a retry is happening?
 *
 * Nothing is announced for a failure whose re-ask is over in a few hundred
 * milliseconds (a re-asked structured answer), and nothing is announced for a
 * failure that is not retried at all.
 */
export function announcesRetry(kind: LLMFailureKind, background = false): boolean {
  if (!isRetryableLLMFailure(kind)) return false;
  return policyFor(kind, background).announce;
}

// ---- Waiting ----------------------------------------------------------------

/**
 * Sleep that wakes immediately when the request is aborted. It RESOLVES rather
 * than rejects on abort: the caller checks `signal.aborted` and rethrows the
 * abort reason, so a cancel during a backoff is reported as the cancellation it
 * was instead of as the busy-server error the retry was waiting out.
 */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Generation cancelled', 'AbortError');
}

// ---- The loop ---------------------------------------------------------------

/** What the caller needs to know to build the next attempt. */
export interface LLMAttemptContext {
  /** 0 for the first attempt, 1 for the first retry, … */
  attempt: number;
  /** Why the previous attempt failed; null on the first attempt. */
  previousKind: LLMFailureKind | null;
  /**
   * The temperature to sample this attempt at. Identical to the configured
   * value except after a failure where the model DID answer — but unusably
   * (nothing, or prose instead of JSON). A local model is often near-greedy, so
   * re-sending a byte-identical request tends to reproduce the same empty or
   * malformed answer; nudging the sampling is what makes the retry a genuinely
   * new attempt rather than a repeat of the same mistake.
   */
  temperature: (base: number | undefined) => number | undefined;
}

export interface LLMRetryInfo {
  /** 1-based number of the attempt about to be made. */
  attempt: number;
  kind: LLMFailureKind;
  delayMs: number;
  /** Attempts this request is worth in total. */
  totalAttempts: number;
}

export interface LLMRetryOptions {
  signal?: AbortSignal;
  /** Housekeeping behind the reader's work: shorter ladders (see BACKGROUND_POLICY). */
  background?: boolean;
  /** Called before each retry — never for the first attempt. */
  onRetry?: (info: LLMRetryInfo) => void;
}

/** Failure kinds where re-sampling the model is worth a temperature nudge. */
function deservesResample(kind: LLMFailureKind | null): boolean {
  return kind === 'empty' || kind === 'bad-json';
}

/** A bounded temperature nudge per retry, clamped to the schema's [0, 2]. */
export function retryTemperature(base: number | undefined, attempt: number): number {
  const start = typeof base === 'number' && Number.isFinite(base) ? base : 0.9;
  return Math.min(2, Number((start + 0.15 * attempt).toFixed(2)));
}

/**
 * Run `fn`, re-sending it while the failure is one a fresh request could
 * survive. Re-throws the last error once the ladder is exhausted, so callers
 * still see the real reason.
 *
 * `fn` receives the attempt number: attempt 0 is the reader's request, every
 * later attempt is the same request re-sent — including the full prompt, since
 * the local server remembers nothing between calls.
 */
export async function withLLMRetry<T>(
  fn: (ctx: LLMAttemptContext) => Promise<T>,
  options: LLMRetryOptions = {},
): Promise<T> {
  const { signal, background = false } = options;
  let previousKind: LLMFailureKind | null = null;

  for (let attempt = 0; ; attempt++) {
    const context: LLMAttemptContext = {
      attempt,
      previousKind,
      temperature: (base) =>
        attempt > 0 && deservesResample(previousKind) ? retryTemperature(base, attempt) : base,
    };
    try {
      return await fn(context);
    } catch (err) {
      // A cancel outranks the failure: report it as the cancellation it was.
      if (signal?.aborted) throw err;
      const kind = classifyLLMFailure(err);
      const totalAttempts = maxLLMAttempts(kind, background);
      if (!isRetryableLLMFailure(kind) || attempt + 1 >= totalAttempts) throw err;
      const delayMs = llmRetryDelayMs(kind, attempt + 1, background);
      options.onRetry?.({ attempt: attempt + 1, kind, delayMs, totalAttempts });
      previousKind = kind;
      await sleepAbortable(delayMs, signal);
      if (signal?.aborted) throw abortReason(signal);
    }
  }
}

/**
 * The reader-facing line for a retry already under way. Each kind says what is
 * actually happening, because "retrying…" on its own tells the reader nothing
 * about whether they should keep waiting.
 */
export function retryNotice(info: LLMRetryInfo): string {
  const count = `${info.attempt} of ${info.totalAttempts - 1}`;
  switch (info.kind) {
    case 'busy':
      return `The local server is busy with another request — retrying (${count})…`;
    case 'warming':
      return `The local model is still loading — retrying (${count})…`;
    case 'unreachable':
      return `Can't reach the local server — retrying (${count})…`;
    case 'gateway':
      return `The local server hiccuped — retrying (${count})…`;
    case 'empty':
      return `The model returned nothing — asking again (${count})…`;
    case 'bad-json':
      return `The model's answer wasn't valid JSON — asking again (${count})…`;
    default:
      return `Retrying (${count})…`;
  }
}
