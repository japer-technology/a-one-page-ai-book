/**
 * main.ts — the orchestrator. Owns the one AppApi implementation: state,
 * routing, the single mutation funnel (update → autosave → re-render), and
 * the generation pipeline. Views stay declarative; every tree invariant lives
 * in core/tree.ts behind the api mutators.
 */
import type {
  Book,
  ChatMessage,
  EndpointSettings,
  Library,
  SeedOptions,
  Settings,
  StoryBible,
  StoryNode,
  TitleOption,
  TurnInput,
} from './core/types';
import { DEFAULT_TURN } from './core/types';
import {
  addNode,
  appendPageVersion,
  appendTitleOptions,
  appendVersionTo,
  attachBible,
  attachSummary,
  childrenOf,
  finishBook,
  getNode,
  makeBook,
  titleOf,
  makeEndingNode,
  makePageNode,
  makePrologueNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
  removeSubtree,
  setBookRules,
  setChosenVersion,
  setFrontier,
  setVersionPinned,
  cloneSubtree,
  prologueOf,
  writableTip,
} from './core/tree';
import {
  defaultLibrary,
  emptySeedOptions,
  normalizeBookBundle,
  normalizeLibrary,
} from './core/schema';
import { chat, chatJSON } from './llm/client';
import {
  announcesRetry,
  retryNotice,
  withLLMRetry,
  type LLMAttemptContext,
  type LLMRetryInfo,
} from './llm/retry';
import { redactUrl } from './llm/endpoints';
import { compileBook } from './core/compile';
import {
  loadLibrary,
  peekStoredLibrary,
  requestPersistence,
  saveLibrary,
  stashUnreadableDocument,
  type LoadResult,
} from './store/db';
import { readOpfsLibrary, writeMdLibrary, writeOpfsLibrary } from './store/files';
import { newId } from './core/id';
import type { AppApi, ToastKind, ViewName } from './ui/ctx';
import { renderShell, renderToastStack, type Toast } from './ui/shell';
import { renderLibrary } from './ui/views/library';
import { genStates } from './ui/genpage';
import { audit, auditLog } from './ui/audit';
import { renderSeed, resetSeedSession } from './ui/views/seed';
import { maybeAutoGenerate, renderTitles } from './ui/views/titles';
import { clearSpanToolbar, renderPage } from './ui/views/page';
import { renderTurn } from './ui/views/turn';
import { renderSettings } from './ui/views/settings';
import { renderReader, stopReaderSpeech } from './ui/views/reader';
import { renderTheEnd } from './ui/views/theend';
import { renderArchive, stopReplay } from './ui/views/archive';
import { renderAbout } from './ui/views/about';
import { renderHelp } from './ui/views/help';

interface AppState {
  lib: Library;
  book: Book | null;
  view: ViewName;
  params: Record<string, string>;
  toasts: Toast[];
  genCounter: number;
  renderCount: number;
  abort: AbortController | null;
  /** Foreground requests — aborted by navigation and by a newer generation. */
  controllers: Set<AbortController>;
  /**
   * Background upkeep (the living cast, the rolling summary). These must
   * survive navigation: they are started by "keep this page" and by the moment
   * a page lands, immediately before the view moves on. Aborting them made the
   * app's own happy path report "Generation cancelled." and silently disabled
   * both features in the main loop (keep → turn → generate → page).
   */
  backgroundControllers: Set<AbortController>;
  activeRequests: number;
}

/**
 * Hard ceiling for one LLM call. Local CPU inference genuinely needs minutes:
 * a page request carries ~2600 words of context plus a few hundred output
 * words, which a 7–13B model on a laptop CPU can take 5–10 minutes to finish.
 * The probe ("Reply with exactly: OK") finishes in seconds — which is exactly
 * why Settings can say "Connected" while a real generation still needs time.
 * There is always a Cancel button and navigation aborts, so a generous
 * ceiling costs nothing.
 */
const GENERATION_TIMEOUT_MS = 600_000;

/** How long a toast stays on screen. */
const TOAST_MS = 5000;

/** Views that make sense as deep links (#/settings, #/library, …). */
const HASH_VIEWS: ReadonlySet<string> = new Set([
  'library',
  'seed',
  'settings',
  'reader',
  'theend',
  'archive',
  'about',
  'help',
]);

function viewFromHash(): ViewName | null {
  if (typeof location === 'undefined') return null;
  const hash = location.hash.replace(/^#\/?/, '');
  return HASH_VIEWS.has(hash) ? (hash as ViewName) : null;
}

/**
 * Why a queued request was dropped before it could be sent. `signal.reason` is
 * the DOMException the abort was created with (`AbortError` for a cancel, or
 * the `TimeoutError` the generation ceiling passes), which is exactly what
 * `genError` already translates into "Generation cancelled." / "timed out".
 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Generation cancelled', 'AbortError');
}

/** One armed generation: its abort controller, its queue slot and its ceiling. */
interface ArmedGeneration {
  controller: AbortController;
  background: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Arm the generation ceiling — called the moment the request starts. */
  start: () => void;
}

let toastSeq = 0;

class App implements AppApi {
  private state: AppState;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Boot races storage against a short grace period. If storage loses that
   * race the app starts from a fallback library, and nothing may be written
   * until the real read settles — one beforeunload at that moment would
   * replace the reader's whole shelf with an empty one.
   */
  private storageSettled = true;
  /**
   * Has the reader changed anything yet? A late-arriving stored document
   * supersedes those changes (they were made against a placeholder shelf), and
   * this is what decides whether the reader is told so.
   */
  private pristine = true;
  /**
   * Where Help was opened from. Recorded here rather than only in the `?` key
   * handler: Help is also reachable from the header button and from the
   * "? crafting help" / "? what is all this" links, and Escape from those used
   * to drop the reader on the Library instead of back where they were — while
   * the help copy promised "Esc returns to what you were doing".
   */
  private returnView: ViewName | null = null;

  constructor(lib: Library, initialView: ViewName = 'library') {
    this.state = {
      lib,
      book: null,
      view: initialView,
      params: {},
      toasts: [],
      genCounter: 0,
      renderCount: 0,
      abort: null,
      controllers: new Set(),
      backgroundControllers: new Set(),
      activeRequests: 0,
    };
  }

  get lib(): Library {
    return this.state.lib;
  }
  get nodes(): Record<string, StoryNode> {
    return this.state.lib.nodes;
  }
  get book(): Book | null {
    return this.state.book;
  }
  get view(): ViewName {
    return this.state.view;
  }
  get params(): Readonly<Record<string, string>> {
    return this.state.params;
  }

  // ---- Routing & rendering ------------------------------------------------

  navigate(view: ViewName, params: Record<string, string> = {}): void {
    audit(`navigate→${view}`);
    // The story map and the About view are opened FOR a book that may not be the
    // session's (`{ book: id }`), and the views they lead to — the ending, the
    // turn console, a page — render only the session book. Without adopting it,
    // "🏁 The frontier" on another book's map showed THIS book's ending, or
    // "No book open." — silently, under the other book's title.
    const target = params.book
      ? this.state.lib.books.find((candidate) => candidate.id === params.book)
      : undefined;
    if (target) this.state.book = target;
    if (view === 'help' && this.state.view !== 'help') this.returnView = this.state.view;
    clearSpanToolbar();
    stopReplay();
    stopReaderSpeech();
    this.abortGeneration();
    this.state.view = view;
    this.state.params = params;
    // Keep deep-linkable views in sync with the URL hash (no history noise).
    if (HASH_VIEWS.has(view) && typeof history !== 'undefined') {
      history.replaceState(null, '', `#/${view}`);
    }
    this.render();
  }

  refresh(): void {
    this.render();
  }

  openBook(bookId: string): void {
    const book = this.state.lib.books.find((b) => b.id === bookId);
    if (!book) {
      this.toast('That book is gone.', 'error');
      this.navigate('library');
      return;
    }
    this.state.book = book;
    if (book.status === 'finished') {
      this.navigate('theend');
      return;
    }
    const frontier = getNode(this.state.lib.nodes, book.frontierId);
    // A prologue (or an ending) can be the stored frontier of a book that is
    // still marked in-progress — `branchTip` follows the newest child, and The
    // End screen attaches the prologue to the title after the pages. Neither is
    // a node the writing view can render, so such a book used to bounce back to
    // the Library on every attempt to continue it: repair the frontier here,
    // once, and the reader is writing again.
    if (frontier && (frontier.kind === 'prologue' || frontier.kind === 'ending')) {
      const repaired =
        writableTip(this.state.lib.nodes, book.chosenTitleId) ??
        writableTip(this.state.lib.nodes, book.seedNodeId);
      if (repaired) {
        const target = repaired;
        this.update((lib) => ({
          ...lib,
          books: replaceBook(lib, setFrontier(book, target.id)),
        }));
        this.navigate(target.kind === 'turn' ? 'turn' : 'page');
        return;
      }
    }
    if (!frontier || frontier.kind === 'title') this.navigate('page');
    else if (frontier.kind === 'page') this.navigate('page');
    else if (frontier.kind === 'turn')
      this.navigate('turn', { from: frontier.parentId ?? book.chosenTitleId });
    else this.navigate('library');
  }

  toast(message: string, kind: ToastKind = 'info'): void {
    // De-duplicate: a failure that BOTH the generation funnel and the calling
    // view report lands here twice (the funnel guarantees a notice, the view
    // keeps its retry panel), and a double-clicked button reports the same
    // thing twice. Stacking identical toasts reads as "two things broke".
    const existing = this.state.toasts.find((t) => t.message === message && t.kind === kind);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.dropToast(existing.id), TOAST_MS);
      this.state.toasts = [...this.state.toasts.filter((t) => t.id !== existing.id), existing];
      renderToastStack(this.state.toasts);
      return;
    }
    const toast: Toast = { id: ++toastSeq, message, kind };
    toast.timer = setTimeout(() => this.dropToast(toast.id), TOAST_MS);
    this.state.toasts.push(toast);
    if (this.state.toasts.length > 4) this.state.toasts.shift();
    // Overlay-only update: a full re-render here would detach live view DOM
    // (form inputs, scan progress) and silently reset what the user is doing.
    renderToastStack(this.state.toasts);
  }

  private dropToast(id: number): void {
    const next = this.state.toasts.filter((t) => t.id !== id);
    if (next.length === this.state.toasts.length) return;
    this.state.toasts = next;
    renderToastStack(this.state.toasts);
  }

  update(recipe: (lib: Library) => Library): void {
    this.pristine = false;
    const next = recipe(this.state.lib);
    // The revision stamp is what lets a save detect that ANOTHER tab wrote a
    // newer document: without it, a stale tab's next save silently replaced
    // everything the newer tab had written.
    next.meta = { updatedAt: Date.now() };
    this.state.lib = next;
    // The living shelf: every mutation marks today in the activity calendar
    // (streaks), and every new page/version nudges the backup meter.
    try {
      const today = new Date().toISOString().slice(0, 10);
      this.state.lib.settings.activityDays = {
        ...this.state.lib.settings.activityDays,
        [today]: (this.state.lib.settings.activityDays[today] ?? 0) + 1,
      };
    } catch {
      // activity tracking is best-effort
    }
    // Book mutations replace the Book object inside lib.books (new frontier,
    // status, …). Keep the session's open-book pointer in sync, or views would
    // render against a stale frontier — the classic "generated but nothing
    // changed" bug.
    const open = this.state.book;
    // A recipe that REPLACES the shelf (a library import, "wipe everything")
    // takes the open book with it. Keeping the session's pointer to a book that
    // no longer exists left the header offering "Story map / Read" for a
    // deleted book, and following either link landed on an empty reader.
    this.state.book = open ? (this.state.lib.books.find((b) => b.id === open.id) ?? null) : null;
    this.scheduleSave();
    this.render();
  }

  setBook(book: Book | null): void {
    this.state.book = book;
    this.render();
  }

  /** Where to go when Help is dismissed (defaults to the shelf). */
  helpReturnView(): ViewName {
    return this.returnView ?? 'library';
  }

  /** Support/debug snapshot (exposed as window.__PAGE_TURN__). */
  debug(): {
    genCounter: number;
    renderCount: number;
    view: ViewName;
    params: Record<string, string>;
    bookId: string | null;
  } {
    return {
      genCounter: this.state.genCounter,
      renderCount: this.state.renderCount,
      view: this.state.view,
      params: { ...this.state.params },
      bookId: this.state.book?.id ?? null,
    };
  }

  // ---- Generation ---------------------------------------------------------

  generateText(
    messages: ChatMessage[],
    opts: {
      model?: string;
      endpoint?: EndpointSettings;
      onToken?: (token: string) => void;
      onRetry?: () => void;
      parallel?: boolean;
      background?: boolean;
      quiet?: boolean;
    } = {},
  ): Promise<string> {
    const endpoint = opts.endpoint ?? this.state.lib.settings.endpoint;
    const model = opts.model ?? endpoint.model;
    const armed = this.armGeneration(opts.parallel === true, opts.background === true);
    this.state.activeRequests++;
    this.renderActiveState();
    const started = performance.now();
    audit(`llm start model=${model || '(none)'} host=${redactUrl(endpoint.baseUrl)}`);
    return this.enqueue(
      opts.background === true,
      armed.controller.signal,
      () =>
        this.withRetry(
          (attempt) =>
            chat(
              {
                endpoint,
                model,
                // `attempt.temperature` nudges the sampling only after a
                // failure where the model answered but unusably (an empty page,
                // or prose where JSON was asked for): a near-greedy local model
                // otherwise reproduces the same unusable answer on a
                // byte-identical re-send. Transport failures re-send unchanged.
                temperature: attempt.temperature(endpoint.temperature),
                signal: armed.controller.signal,
                onToken: opts.onToken,
              },
              messages,
            ),
          endpoint.baseUrl,
          armed.controller.signal,
          opts.onRetry,
          opts.quiet === true,
          opts.background === true,
        ),
      armed.start,
    )
      .then((text) => {
        audit(`llm ok ms=${Math.round(performance.now() - started)} chars=${text.length}`);
        return text;
      })
      .catch((err) => {
        audit(
          `llm err ms=${Math.round(performance.now() - started)} err=${String(err).slice(0, 200)}`,
        );
        throw err;
      })
      .catch((err) => {
        // Surface a notice AND rethrow — views still get their retry panels.
        // Quiet callers (fire-and-forget upkeep) report through their own
        // panel instead: a failed cast refresh is not a failure of the page
        // the reader just wrote, and a red toast about it reads as one.
        if (!opts.quiet) this.toast(this.genError(err), 'error');
        throw err;
      })
      .finally(() => {
        this.state.activeRequests = Math.max(0, this.state.activeRequests - 1);
        this.disarmGeneration(armed);
        this.renderActiveState();
      });
  }

  generateJSON<T>(
    messages: ChatMessage[],
    opts: {
      model?: string;
      endpoint?: EndpointSettings;
      parallel?: boolean;
      background?: boolean;
      quiet?: boolean;
    } = {},
  ): Promise<T> {
    const endpoint = opts.endpoint ?? this.state.lib.settings.endpoint;
    const model = opts.model ?? endpoint.model;
    const armed = this.armGeneration(opts.parallel === true, opts.background === true);
    this.state.activeRequests++;
    this.renderActiveState();
    const started = performance.now();
    audit(`llm-json start model=${model || '(none)'} host=${redactUrl(endpoint.baseUrl)}`);
    return this.enqueue(
      opts.background === true,
      armed.controller.signal,
      () =>
        this.withRetry(
          (attempt) =>
            chatJSON<T>(
              {
                endpoint,
                model,
                temperature: attempt.temperature(endpoint.temperature),
                signal: armed.controller.signal,
              },
              messages,
            ),
          endpoint.baseUrl,
          armed.controller.signal,
          undefined,
          opts.quiet === true,
          opts.background === true,
        ),
      armed.start,
    )
      .then((value) => {
        audit(`llm-json ok ms=${Math.round(performance.now() - started)}`);
        return value;
      })
      .catch((err) => {
        audit(
          `llm-json err ms=${Math.round(performance.now() - started)} err=${String(err).slice(0, 200)}`,
        );
        throw err;
      })
      .catch((err) => {
        // Surface a notice AND rethrow — views still get their retry panels.
        if (!opts.quiet) this.toast(this.genError(err), 'error');
        throw err;
      })
      .finally(() => {
        this.state.activeRequests = Math.max(0, this.state.activeRequests - 1);
        this.disarmGeneration(armed);
        this.renderActiveState();
      });
  }

  /**
   * The one-generation-slot gate. Every model request the app issues — page
   * writes, rewrites, the title batch, the pre-writing chat, "Test connection",
   * and the background upkeep (living cast + rolling summary) — waits its turn
   * here.
   *
   * Why: LM Studio's default, llama.cpp with `-np 1` and older Ollama builds
   * serve ONE generation at a time and answer a second concurrent request with
   * an error (LM Studio: HTTP 400 "Only one request at a time is allowed";
   * others 429/503) rather than queueing it. The app used to fire the cast
   * refresh and the memory refresh in the same tick as the page it had just
   * kept, so writing page 1 reliably produced two red "LLM server responded
   * …" notices about calls the reader never made — and any housekeeping call
   * still in flight could make the reader's OWN next page fail the same way.
   * Queueing costs nothing on a multi-slot server (a single model processes
   * one request at a time there anyway) and is the only correct behaviour on a
   * one-slot server.
   *
   * Foreground work always goes ahead of background upkeep: housekeeping must
   * never make the reader wait.
   */
  private foregroundQueue: Array<() => void> = [];
  private backgroundQueue: Array<() => void> = [];
  private requestInFlight = false;
  /** Every model request this session has QUEUED (not counting the LAN scan). */
  private requestTotal = 0;
  /** Requests that had to wait for the single slot behind another one. */
  private requestQueued = 0;

  private enqueue<T>(
    background: boolean,
    signal: AbortSignal,
    run: () => Promise<T>,
    onStart?: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          reject(abortReason(signal));
          return;
        }
        this.requestInFlight = true;
        onStart?.();
        // Free the slot and start the next waiter BEFORE the caller's
        // continuation runs: otherwise a caller that immediately queues
        // follow-up work (a page lands, then the cast refresh is requested)
        // would enqueue against a slot that still looked busy.
        const releaseSlot = () => {
          this.requestInFlight = false;
          this.pumpQueue();
        };
        run().then(
          (value) => {
            releaseSlot();
            resolve(value);
          },
          (err: unknown) => {
            releaseSlot();
            reject(err);
          },
        );
      };
      // A request that is aborted while still queued must leave the queue
      // immediately: otherwise a cancel (or a navigation) would leave it
      // waiting behind a long generation, and it would still be sent to the
      // server minutes later.
      const onAbort = () => {
        const queue = background ? this.backgroundQueue : this.foregroundQueue;
        const index = queue.indexOf(start);
        if (index >= 0) {
          queue.splice(index, 1);
          reject(abortReason(signal));
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.requestTotal++;
      if (this.requestInFlight) this.requestQueued++;
      (background ? this.backgroundQueue : this.foregroundQueue).push(start);
      this.pumpQueue();
    });
  }

  private pumpQueue(): void {
    if (this.requestInFlight) return;
    const next = this.foregroundQueue.shift() ?? this.backgroundQueue.shift();
    if (next) next();
    else this.renderActiveState();
  }

  /**
   * Send a request to the local model, re-sending it while the failure is one a
   * fresh request could survive.
   *
   * How many times, and how long to wait between attempts, is `llm/retry.ts`'s
   * decision (a tested table, not a guess made here). Two things this method
   * owns:
   *
   *   - the reader is told about a LONG wait, and kept quiet about a quick
   *     re-ask — see `announcesRetry`;
   *   - `onRetry` lets a streaming view clear its half-rendered preview, so the
   *     second attempt does not render concatenated onto the first one.
   *
   * Every attempt is a complete request: a local server keeps no session, so
   * `fn` re-sends the whole system prompt, the whole story context and the whole
   * message list. Nothing is "continued".
   *
   * Cancels and timeouts are never retried — the signal is dead, so a retry
   * would fail instantly with a misleading "cancelled" error.
   */
  private async withRetry<T>(
    fn: (ctx: LLMAttemptContext) => Promise<T>,
    baseUrl: string,
    signal: AbortSignal,
    onRetry?: () => void,
    quiet = false,
    background = false,
  ): Promise<T> {
    return withLLMRetry(fn, {
      signal,
      background,
      onRetry: (info: LLMRetryInfo) => {
        audit(
          `llm-retry attempt=${info.attempt}/${info.totalAttempts - 1} kind=${info.kind} delay=${info.delayMs}ms host=${redactUrl(baseUrl)}`,
        );
        // Streaming views must reset their preview before the next attempt, or
        // the retried stream renders concatenated onto the first one.
        onRetry?.();
        // Background upkeep stays silent: a retry it performs on its own is not
        // something the reader has to watch, and its panel reports the outcome.
        // A quick re-ask (a re-sampled structured answer) stays silent too.
        if (!quiet && announcesRetry(info.kind, background)) {
          this.toast(retryNotice(info), 'info');
        }
      },
    });
  }

  /** Update ONLY the header's working light (never a full re-render). */
  private renderActiveState(): void {
    if (typeof document === 'undefined') return;
    const chip = document.getElementById('nav-working');
    if (!chip) return;
    // `''` only clears the INLINE style — it falls straight back to the
    // stylesheet's `display: none`, so the light could never appear at all.
    // The rule declares flex properties, so it wants `inline-flex`.
    chip.style.display = this.state.activeRequests > 0 ? 'inline-flex' : 'none';
  }

  genActive(): number {
    return this.state.activeRequests;
  }

  /** Request accounting for the support snapshot (see window.__PAGE_TURN__). */
  requestCounts(): { total: number; queued: number; backlog: number } {
    return {
      total: this.requestTotal,
      queued: this.requestQueued,
      backlog: this.foregroundQueue.length + this.backgroundQueue.length,
    };
  }

  /**
   * One in-flight request at a time by default (a new request supersedes the
   * old one); `parallel: true` registers alongside instead of superseding —
   * used by the multi-candidate fan-out.
   *
   * The generation ceiling is NOT armed here: it is armed by `start()` when the
   * request actually reaches the server. A request waiting for the single
   * generation slot used to burn its whole 10-minute budget while queued and
   * then fail with "Generation timed out" without ever having been sent.
   */
  private armGeneration(parallel = false, background = false): ArmedGeneration {
    if (!parallel && !background) {
      for (const controller of this.state.controllers) controller.abort();
      this.state.controllers.clear();
    }
    const controller = new AbortController();
    if (background) {
      this.state.backgroundControllers.add(controller);
    } else {
      this.state.controllers.add(controller);
      this.state.abort = controller;
    }
    const armed: ArmedGeneration = {
      controller,
      background,
      timer: null,
      start: () => {
        clearTimeout(armed.timer ?? undefined);
        armed.timer = setTimeout(
          () => controller.abort(new DOMException('Generation timed out', 'TimeoutError')),
          GENERATION_TIMEOUT_MS,
        );
      },
    };
    return armed;
  }

  private disarmGeneration(armed: ArmedGeneration): void {
    // Clear OUR timer only — a newer request may have armed its own by now.
    if (armed.timer !== null) clearTimeout(armed.timer);
    if (armed.background) this.state.backgroundControllers.delete(armed.controller);
    else this.state.controllers.delete(armed.controller);
    if (this.state.abort === armed.controller) this.state.abort = null;
  }

  beginGen(): number {
    audit('beginGen');
    return ++this.state.genCounter;
  }

  staleGen(token: number): boolean {
    return token !== this.state.genCounter;
  }

  abortGeneration(): void {
    // Incrementing the token marks every in-flight generation as stale, so
    // cancel/navigation can never leave a stuck "busy" panel behind.
    audit('abortGeneration');
    this.state.genCounter++;
    for (const controller of this.state.controllers) controller.abort();
    this.state.controllers.clear();
    this.state.abort = null;
    // Background upkeep is deliberately left running: it was started by the
    // action that is navigating away, writes only idempotent derived data, and
    // has no UI of its own to strand.
  }

  genError(err: unknown): string {
    if (err instanceof DOMException && err.name === 'AbortError') return 'Generation cancelled.';
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      const minutes = Math.round(GENERATION_TIMEOUT_MS / 60_000);
      return `Generation timed out after ${minutes} minutes — the model may be busy or the request too large. Try again, or pick a smaller model.`;
    }
    const message = err instanceof Error ? err.message : String(err);
    const base = redactUrl(this.state.lib.settings.endpoint.baseUrl);
    if (
      message.includes('Failed to fetch') ||
      message.includes('NetworkError') ||
      message.includes('Load failed')
    ) {
      return `Can't reach ${base}. Is the server running? If it is, it may be refusing this page's origin (CORS) — see the help note in Settings.`;
    }
    if (message.includes('No model selected')) return 'No model selected — pick one in Settings.';
    if (message.includes('API key')) return message; // already actionable
    return message;
  }

  // ---- Tree mutations -----------------------------------------------------

  newSeed(text: string, options: SeedOptions, brief = ''): StoryNode {
    const node = makeSeedNode(text, options, brief);
    this.update((lib) => ({ ...lib, nodes: addNode(lib.nodes, node) }));
    return node;
  }

  appendTitles(seedNodeId: string, options: TitleOption[]): void {
    this.update((lib) => {
      const node = getNode(lib.nodes, seedNodeId);
      if (!node || node.kind !== 'seed') return lib;
      return { ...lib, nodes: { ...lib.nodes, [node.id]: appendTitleOptions(node, options) } };
    });
  }

  pickTitle(seedNodeId: string, option: TitleOption): Book {
    audit(`pickTitle seed=${seedNodeId}`);
    // Reuse (or create) ONE title node per distinct title — and ONE book per
    // seed. Re-picking a title after walking back used to spawn duplicate
    // title nodes AND duplicate books on the shelf.
    const titleNode = this.ensureTitleNode(seedNodeId, option);
    const existing = this.state.lib.books.find((b) => b.seedNodeId === seedNodeId);
    if (existing) {
      // The seed already has a book: re-entering through the titles moves
      // the frontier onto this title instead of duplicating the book.
      const book: Book = {
        ...setFrontier(existing, titleNode.id),
        chosenTitleId: titleNode.id,
        status: 'in-progress',
      };
      this.state.book = book;
      this.update((lib) => ({ ...lib, books: replaceBook(lib, book) }));
      return book;
    }
    const book = makeBook(seedNodeId, titleNode.id, this.state.lib.settings.endpoint.model);
    this.state.book = book;
    this.update((lib) => ({ ...lib, books: [...lib.books, book] }));
    return book;
  }

  markExported(): void {
    this.update((lib) => ({
      ...lib,
      settings: {
        ...lib.settings,
        exportMeter: { lastExportAt: Date.now(), pages: 0 },
      },
    }));
  }

  setTags(book: Book, tags: string[]): void {
    this.update((lib) => ({
      ...lib,
      books: replaceBook(lib, {
        ...book,
        tags: [...new Set(tags.map((t) => t.trim()).filter(Boolean))],
        updatedAt: Date.now(),
      }),
    }));
  }

  writePrologue(book: Book, text: string, model: string): void {
    const existing = prologueOf(this.state.lib.nodes, book);
    this.update((lib) => {
      if (existing && lib.nodes[existing.id]) {
        return {
          ...lib,
          nodes: { ...lib.nodes, [existing.id]: appendVersionTo(existing, text, 'ai', model) },
        };
      }
      const node = makePrologueNode(book.chosenTitleId, DEFAULT_TURN, model, text);
      return { ...lib, nodes: addNode(lib.nodes, node) };
    });
  }

  setIronMode(book: Book, mode: 'none' | 'three' | 'iron'): void {
    this.update((lib) => ({
      ...lib,
      books: replaceBook(lib, { ...book, ironMode: mode, updatedAt: Date.now() }),
    }));
    this.toast(
      mode === 'iron'
        ? '⚔ Iron Author: no re-rolls — the page is final'
        : mode === 'three'
          ? '⚔ Three strikes: three re-rolls per page'
          : 'Normal mode: unlimited re-rolls',
      'info',
    );
  }

  savePortrait(book: Book, text: string): void {
    this.update((lib) => {
      const node = getNode(lib.nodes, book.frontierId);
      if (!node || node.kind !== 'ending' || node.data.kind !== 'ending') return lib;
      return {
        ...lib,
        nodes: { ...lib.nodes, [node.id]: { ...node, data: { ...node.data, portrait: text } } },
      };
    });
  }

  async importDropped(payload: unknown): Promise<void> {
    try {
      audit('importDropped');
      if (
        payload &&
        typeof payload === 'object' &&
        (payload as { format?: unknown }).format === 'page-turn-book'
      ) {
        const { book, nodes } = normalizeBookBundle(payload);
        const duplicate = this.state.lib.books.some(
          (b) => b.seedNodeId === book.seedNodeId || b.id === book.id,
        );
        if (
          duplicate &&
          !window.confirm('This book is already on the shelf — import a copy anyway?')
        )
          return;
        // Shared ids corrupt the tree: if the incoming nodes collide with
        // anything on the shelf (or this is a deliberate copy), clone the
        // subtree to fresh ids so the imported book is fully independent.
        let incomingBook = book;
        let incomingNodes = nodes;
        const collides = Object.keys(incomingNodes).some((id) => id in this.state.lib.nodes);
        if (duplicate || collides) {
          const clone = cloneSubtree(incomingNodes, book.seedNodeId);
          incomingNodes = clone.nodes;
          incomingBook = {
            ...book,
            id: newId(),
            seedNodeId: clone.rootId,
            chosenTitleId: clone.remap.get(book.chosenTitleId) ?? clone.rootId,
            frontierId: clone.remap.get(book.frontierId) ?? clone.rootId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        }
        this.update((lib) => ({
          ...lib,
          nodes: { ...incomingNodes, ...lib.nodes },
          books: [...lib.books, incomingBook],
        }));
        this.toast('Dropped book added to the shelf', 'success');
        this.navigate('library');
        return;
      }
      const lib = normalizeLibrary(payload);
      // Replacing a NON-EMPTY shelf must always ask — the empty-library file
      // (which a fresh profile exports) used to bypass the confirm entirely
      // and destroy every book with a green success toast.
      const replacing = this.state.lib.books.length > 0;
      if (
        !replacing ||
        window.confirm(
          `Import ${lib.books.length} book(s) from the dropped file? It will REPLACE the current library${lib.books.length === 0 ? ' (the file is empty)' : ''}. Your endpoint and settings stay as they are.`,
        )
      ) {
        audit(`importLibrary books=${lib.books.length} replacing=${replacing}`);
        // The file's settings (endpoint, API key, theme) belong to the sender's
        // machine: adopting them silently repointed every future generation at
        // a host the reader never configured, key included. Keep local ones.
        this.update((cur) => ({ ...lib, settings: cur.settings }));
        this.toast(
          lib.books.length > 0
            ? 'Imported ' + lib.books.length + ' book(s)'
            : 'Imported an empty library',
          'success',
        );
        this.navigate('library');
      }
    } catch (err) {
      this.toast(err instanceof Error ? err.message : 'That file is not a Page Turn file', 'error');
    }
  }

  attachPage(
    book: Book,
    parentId: string,
    direction: TurnInput,
    text: string,
    model: string,
    by: 'ai' | 'user' = 'ai',
  ): StoryNode {
    audit(`attachPage book=${book.id} parent=${parentId} by=${by}`);
    const node = makePageNode(parentId, direction, model, text, by);
    this.update((lib) => ({
      ...lib,
      nodes: addNode(lib.nodes, node),
      books: replaceBook(lib, setFrontier(book, node.id)),
      settings: {
        ...lib.settings,
        exportMeter: {
          ...lib.settings.exportMeter,
          pages: (lib.settings.exportMeter.pages ?? 0) + 1,
        },
      },
    }));
    return node;
  }

  appendVersion(pageId: string, text: string, by: 'ai' | 'user', model?: string): void {
    // NOTE: versions do NOT bump the backup meter — it counts PAGES WRITTEN.
    // Counting rewrites meant a single-page book could accumulate dozens of
    // "pages since export" and a fan-out of candidates inflated it the same
    // way; the nudge's job is to say "you have written N pages nobody has
    // backed up".
    this.update((lib) => {
      const node = getNode(lib.nodes, pageId);
      if (!node || node.kind !== 'page') return lib;
      return {
        ...lib,
        nodes: { ...lib.nodes, [node.id]: appendPageVersion(node, text, by, model) },
      };
    });
  }

  chooseVersion(pageId: string, version: number): void {
    this.update((lib) => {
      const node = getNode(lib.nodes, pageId);
      if (!node || node.kind !== 'page') return lib;
      return { ...lib, nodes: { ...lib.nodes, [node.id]: setChosenVersion(node, version) } };
    });
  }

  attachTurn(book: Book, pageId: string, input: TurnInput): StoryNode {
    const node = makeTurnNode(pageId, input);
    this.update((lib) => ({
      ...lib,
      nodes: addNode(lib.nodes, node),
      books: replaceBook(lib, setFrontier(book, node.id)),
    }));
    return node;
  }

  finishBook(book: Book, pageId: string, note: string): void {
    const ending = makeEndingNode(pageId, note);
    this.update((lib) => ({
      ...lib,
      nodes: addNode(lib.nodes, ending),
      books: replaceBook(lib, finishBook(book, ending.id)),
    }));
  }

  unfinishBook(book: Book): void {
    const frontier = getNode(this.state.lib.nodes, book.frontierId);
    const parentId = frontier?.parentId ?? book.frontierId;
    this.update((lib) => ({
      ...lib,
      books: replaceBook(lib, {
        ...book,
        status: 'in-progress',
        frontierId: parentId,
        updatedAt: Date.now(),
      }),
    }));
  }

  openPageAt(book: Book, pageNodeId: string): void {
    const node = getNode(this.state.lib.nodes, pageNodeId);
    if (!node || node.kind !== 'page') return;
    audit(`openPageAt book=${book.id} page=${pageNodeId}`);
    const reopened = book.status === 'finished';
    this.update((lib) => ({
      ...lib,
      books: replaceBook(lib, {
        ...setFrontier(book, pageNodeId),
        status: 'in-progress', // walking back re-opens the book for branching
      }),
    }));
    // Sync the session's open-book pointer: the story map / about views can
    // target a book that is not currently open, and the page view must render
    // THAT book after the jump.
    this.state.book = this.state.lib.books.find((b) => b.id === book.id) ?? book;
    this.navigate('page');
    if (reopened) {
      this.toast(
        'Back in the story — the finished path is kept; keeping a page here forks a new branch.',
        'info',
      );
    }
  }

  saveBible(pageNodeId: string, bible: StoryBible): void {
    this.update((lib) => {
      const node = getNode(lib.nodes, pageNodeId);
      if (!node || node.kind !== 'page') return lib;
      return { ...lib, nodes: { ...lib.nodes, [node.id]: attachBible(node, bible) } };
    });
  }

  saveSummary(pageNodeId: string, summary: string): void {
    this.update((lib) => {
      const node = getNode(lib.nodes, pageNodeId);
      if (!node || node.kind !== 'page') return lib;
      return { ...lib, nodes: { ...lib.nodes, [node.id]: attachSummary(node, summary) } };
    });
  }

  /** Find the title node for a proposed option, creating it on first entry. */
  ensureTitleNode(seedNodeId: string, option: TitleOption): StoryNode {
    const existing = childrenOf(this.state.lib.nodes, seedNodeId).find(
      (n) => n.kind === 'title' && n.data.kind === 'title' && n.data.title === option.title,
    );
    if (existing) return existing;
    const node = makeTitleNode(seedNodeId, option);
    this.update((lib) => ({ ...lib, nodes: addNode(lib.nodes, node) }));
    return node;
  }

  /**
   * Re-enter the book from any proposed title (§5): the frontier moves to
   * wherever writing last stopped under that title — or to the title itself,
   * ready for page 1. Nothing on any other branch is touched.
   */
  openBranch(book: Book, option: TitleOption): void {
    // Adopt the book BEFORE re-frontiering and navigating: the story map's
    // "Enter" doors work on a book that is not open, and every view they land on
    // reads the session book — so the frontier moved while the reader was left
    // on "No book open." (or inside whatever other book WAS open).
    this.state.book = this.state.lib.books.find((b) => b.id === book.id) ?? book;
    const titleNode = this.ensureTitleNode(book.seedNodeId, option);
    audit(`openBranch book=${book.id} title=${titleNode.id}`);
    // Re-enter at the newest node that can actually be written — never at an
    // ending or at the prologue The End screen attached after the pages (see
    // `writableTip`).
    const tip = writableTip(this.state.lib.nodes, titleNode.id) ?? titleNode;
    this.update((lib) => ({
      ...lib,
      books: replaceBook(lib, {
        ...setFrontier(book, tip.id),
        // The chosen title must follow the frontier. `writePrologue` stores the
        // prologue on `book.chosenTitleId` while `compileBook` reads it from the
        // title ON THE PATH, so writing one after entering a different title
        // put the text on the OTHER branch's prologue: invisible in the book
        // being written, and silently overwriting what that branch had.
        chosenTitleId: titleNode.id,
        status: 'in-progress',
      }),
    }));
    if (tip.kind === 'page') this.navigate('page');
    else if (tip.kind === 'turn') this.navigate('turn', { from: tip.parentId ?? titleNode.id });
    else this.navigate('page', { auto: '1' });
  }

  setRules(book: Book, rules: string[]): void {
    this.update((lib) => ({
      ...lib,
      books: replaceBook(lib, setBookRules(book, rules)),
    }));
  }

  togglePin(pageId: string, version: number): void {
    this.update((lib) => {
      const node = getNode(lib.nodes, pageId);
      if (!node || node.kind !== 'page' || node.data.kind !== 'page') return lib;
      const current = node.data.versions[version - 1];
      if (!current) return lib;
      const pinned = !current.pinned;
      return {
        ...lib,
        nodes: { ...lib.nodes, [node.id]: setVersionPinned(node, version, pinned) },
      };
    });
    void this.pinToast(pageId, version);
  }

  private pinToast(pageId: string, version: number): void {
    const node = getNode(this.state.lib.nodes, pageId);
    const isPinned =
      node && node.data.kind === 'page' ? node.data.versions[version - 1]?.pinned === true : false;
    this.toast(
      isPinned ? `📌 Version ${version} pinned` : `Version ${version} unpinned`,
      'success',
    );
  }

  seedFromBook(bookId: string): void {
    const book = this.state.lib.books.find((b) => b.id === bookId);
    if (!book) return;
    const title = titleOf(this.state.lib.nodes, book);
    const compiled = compileBook(this.state.lib.nodes, book);
    const cast = compiled.cast;
    const castLines: string[] = [];
    if (cast) {
      const names = (list: Array<{ name: string }>) => list.map((e) => e.name).join(', ');
      if (cast.people.length > 0) castLines.push(`The cast carries over: ${names(cast.people)}.`);
      if (cast.places.length > 0) castLines.push(`Places: ${names(cast.places)}.`);
      if (cast.things.length > 0) castLines.push(`Significant things: ${names(cast.things)}.`);
      if (cast.threads.length > 0)
        castLines.push(`Threads the sequel may pick up: ${names(cast.threads)}.`);
    }
    const brief =
      `This is a sequel to "${title}" (a book directed page by page in Page Turn). Original seed: ${compiled.seed}. ${castLines.join(' ')} Continue the story onward — same world, new pages, the reader directs every turn.`.trim();
    const node = makeSeedNode(`Sequel to "${title}"`, emptySeedOptions(), brief);
    this.update((lib) => ({ ...lib, nodes: addNode(lib.nodes, node) }));
    // A new book was just born, so the NEXT new book must not inherit this
    // session's pre-writing conversation: its brief would steer a different
    // story. The seed view's own "Begin" path resets itself; every other path
    // that mints a seed node comes through here.
    resetSeedSession();
    this.navigate('titles', { seed: node.id });
    this.toast('Sequel seeded — the cast rides along as the brief', 'success');
  }

  setReadingPosition(bookId: string, position: number): void {
    const existing = this.state.lib.settings.readingPositions ?? {};
    if (position <= 0) {
      const { [bookId]: _dropped, ...rest } = existing;
      void _dropped;
      this.update((lib) => ({
        ...lib,
        settings: { ...lib.settings, readingPositions: rest },
      }));
      return;
    }
    this.update((lib) => ({
      ...lib,
      settings: {
        ...lib.settings,
        readingPositions: { ...(lib.settings.readingPositions ?? {}), [bookId]: position },
      },
    }));
  }

  applyAppearance(
    overrides?: Partial<Pick<Settings, 'theme' | 'readingFont' | 'fontScale' | 'documentFonts'>>,
  ): void {
    const settings = { ...this.state.lib.settings, ...overrides };
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    let theme = settings.theme;
    if (theme === 'system') {
      try {
        theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      } catch {
        theme = 'dark';
      }
    }
    root.dataset.theme = theme;
    root.dataset.font = settings.readingFont;
    // The <meta name="theme-color"> was hardcoded near-black, so a sepia or
    // light reader kept a dark URL bar / status bar around a light page.
    const themeColor = document.getElementById('theme-color');
    if (themeColor) {
      const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
      if (bg) themeColor.setAttribute('content', bg);
    }
    root.style.setProperty('--font-scale', String(settings.fontScale));
    // Share the reading font stacks with the per-format document wardrobe.
    for (const format of ['story', 'letter', 'diary', 'newspaper', 'mapnote', 'recipe']) {
      const choice =
        settings.documentFonts?.[format as keyof typeof settings.documentFonts] ?? 'auto';
      root.style.setProperty(
        `--doc-font-${format}`,
        choice === 'auto'
          ? format === 'mapnote'
            ? 'var(--mono)' // map notes default to monospace, matching the CSS
            : 'var(--serif)'
          : `var(--font-${choice}, var(--serif))`,
      );
    }
  }

  renameTitle(book: Book, title: string): void {
    const clean = title.trim();
    if (!clean) return;
    this.update((lib) => {
      const node = getNode(lib.nodes, book.chosenTitleId);
      if (!node || node.kind !== 'title' || node.data.kind !== 'title') return lib;
      return {
        ...lib,
        nodes: {
          ...lib.nodes,
          [node.id]: { ...node, data: { ...node.data, title: clean } },
        },
      };
    });
    this.toast('Title renamed', 'success');
  }

  removeBook(bookId: string): void {
    const book = this.state.lib.books.find((b) => b.id === bookId);
    if (!book) return;
    if (this.state.book?.id === bookId) this.state.book = null;
    this.update((lib) => ({
      ...lib,
      books: lib.books.filter((b) => b.id !== bookId),
      nodes: removeSubtree(lib.nodes, book.seedNodeId),
    }));
  }

  duplicateBook(bookId: string): Book | null {
    const book = this.state.lib.books.find((b) => b.id === bookId);
    if (!book) return null;
    const clone = cloneSubtree(this.state.lib.nodes, book.seedNodeId);
    const copy: Book = {
      ...book,
      id: newId(),
      seedNodeId: clone.rootId,
      chosenTitleId: clone.remap.get(book.chosenTitleId) ?? clone.rootId,
      frontierId: clone.remap.get(book.frontierId) ?? clone.rootId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.update((lib) => ({
      ...lib,
      nodes: { ...clone.nodes, ...lib.nodes },
      books: [...lib.books, copy],
    }));
    this.toast('Duplicated', 'success');
    return copy;
  }

  // ---- Persistence --------------------------------------------------------

  scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persistNow();
    }, 300);
  }

  /** Serializes saves: two overlapping saves raced on the shared OPFS .tmp file. */
  private saving: Promise<void> | null = null;
  /**
   * The revision of the stored document as this tab last READ or WROTE it.
   * Saves are compare-and-swap: if the stored revision moved on (another tab
   * committed), this tab adopts the stored document instead of overwriting it
   * with stale content — the pre-fix behaviour silently erased every page the
   * other tab had written.
   */
  private knownStoredRevision = -1;

  /** Call once at boot with the revision of the loaded document. */
  setBaselineRevision(revision: number): void {
    this.knownStoredRevision = revision;
  }

  async persistNow(): Promise<void> {
    if (this.saving) {
      // A save is already running, but ITS snapshot predates the edit that
      // asked for this one. Returning the older promise dropped the newest
      // state (nothing re-ran it until the next edit or a page unload), so
      // mark the document dirty and re-save as soon as the current write
      // finishes. `persistNowInner` snapshots `state.lib` itself, so the
      // follow-up write carries the newest content.
      this.dirtyWhileSaving = true;
      return this.saving;
    }
    this.saving = this.persistNowInner().finally(() => {
      this.saving = null;
      if (this.dirtyWhileSaving) {
        this.dirtyWhileSaving = false;
        void this.persistNow();
      }
    });
    return this.saving;
  }

  /** Set when a save was requested while another was already running. */
  private dirtyWhileSaving = false;

  private async persistNowInner(): Promise<void> {
    // Storage has not answered yet: the in-memory library is a placeholder and
    // writing it would destroy the real one. It is saved on arrival instead.
    if (!this.storageSettled) return;
    // Snapshot ONCE. Reading `this.state.lib` at each await would let an edit
    // made mid-save land in the OPFS mirror while IndexedDB kept the older
    // document — and IndexedDB is what boot prefers, so the newer pages would
    // silently disappear on the next launch.
    const lib = this.state.lib;
    try {
      // Cross-tab guard: serialize writers where the platform supports it and
      // re-check the stored revision inside. A stale tab must never overwrite
      // a newer document with its boot-time copy.
      const locked =
        typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks?.request
          ? await navigator.locks.request('page-turn-save', () => this.saveLocked(lib))
          : await this.saveLocked(lib);
      await locked;
      this.saveFailedNoticeShown = false;
    } catch (err) {
      // Persistence is best-effort; the app keeps working in memory. But the
      // reader must KNOW: a full quota (QuotaExceededError) or a dead database
      // used to fail here invisibly, so hours of writing could evaporate with
      // the app still claiming everything was saved.
      this.notifySaveFailure(err);
    }
  }

  private async saveLocked(lib: Library): Promise<void> {
    let peek = await peekStoredLibrary();
    if (!peek.ok) {
      // One retry: a transient read failure (a connection that just closed)
      // usually reopens cleanly, exactly like loadLibrary's reopen path.
      peek = await peekStoredLibrary();
    }
    // A read that keeps failing must NOT be treated as “nothing stored”: that
    // skipped the guard below and let a stale tab overwrite another tab's
    // newer document. Refuse this write instead — the caller notifies, and
    // nothing is silently lost.
    if (!peek.ok) {
      audit('persistNow skipped: the stored document could not be read to verify revisions');
      throw new Error('Could not verify the stored library before saving');
    }
    const stored = peek.stored;
    // Compare-and-swap: a plain "is the stored stamp newer than mine" check
    // fails precisely for the stale tab — its own mutation bumps ITS stamp
    // while its content is older. The only reliable signal is that the stored
    // revision no longer matches the revision this tab last read.
    if (
      this.knownStoredRevision !== -1 &&
      stored !== null &&
      stored.updatedAt !== this.knownStoredRevision
    ) {
      // Another tab committed since we last saw the document. Adopt theirs:
      // overwriting it used to be silent, permanent loss of their pages.
      const loaded = await loadLibrary();
      if (!loaded.ok) {
        // The revision moved but the newer document cannot be read: writing
        // ours now would destroy it unseen. Refuse, like an unreadable peek.
        audit('persistNow skipped: the stored document changed but could not be re-read');
        throw new Error('The stored library changed but could not be read for adoption');
      }
      audit('persistNow adopted document written by another tab');
      this.state.lib = loaded.lib;
      // Re-derive the session's open book, exactly as `update()` does: the
      // adopted document is a different object graph, and a pointer to the
      // discarded one left views rendering a book that is no longer in
      // `lib.books` — and the next mutator wrote THAT object back
      // (`replaceBook(lib, setFrontier(book, …))`), silently reverting every
      // book-level change the other tab had just saved.
      const open = this.state.book;
      this.state.book = open ? (loaded.lib.books.find((b) => b.id === open.id) ?? null) : null;
      this.knownStoredRevision = loaded.lib.meta.updatedAt;
      this.render();
      this.toast(
        'Another Page Turn tab saved newer changes — they were loaded and this tab is in sync. The change that triggered this save was superseded.',
        'info',
      );
      return; // their document is already stored; nothing to write
    }
    await saveLibrary(lib);
    this.knownStoredRevision = lib.meta.updatedAt;
    await writeOpfsLibrary(lib);
    // The .md mirror: the same books as plain, readable markdown files.
    await writeMdLibrary(lib);
    audit('persistNow ok');
  }

  private saveFailedNoticeShown = false;

  private notifySaveFailure(err: unknown): void {
    audit(`persistNow failed err=${String(err)}`);
    const quotaFull =
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' || err.name === 'QuotaExceededErr');
    // One notice per session is enough — the saves keep failing, and a toast
    // on every keystroke-debounce would be spam. (It re-arms after a success.)
    if (this.saveFailedNoticeShown) return;
    this.saveFailedNoticeShown = true;
    this.toast(
      quotaFull
        ? '⚠ Storage is full — your latest changes are only in memory and may be lost on close. Export your library, then delete some books.'
        : '⚠ Saving to local storage failed — your latest changes are only in memory. Export a backup and reload.',
      'error',
    );
  }

  /**
   * Called when boot gave up waiting on the database. The app is usable
   * immediately, but stays write-locked until the real read lands: then the
   * late library is adopted — it is the reader's shelf, and the placeholder is
   * empty — and normal saving resumes.
   *
   * A late read that FAILED must keep the write lock. Taking `?.lib ?? null`
   * here threw away `LoadResult.ok`, so a failed read looked like "nothing was
   * stored": saving was switched back on and the placeholder library was
   * written straight over the reader's intact-but-unreadable document.
   */
  holdPersistenceUntil(load: Promise<LoadResult | null>): void {
    this.storageSettled = false;
    void load.then(
      (late) => {
        if (!late) {
          // Nothing usable came back and we know nothing about storage: stay
          // write-locked rather than guess.
          return;
        }
        if (!late.ok) {
          audit(`boot: the late read failed — saving stays off (${late.error ?? 'unknown'})`);
          void stashUnreadableDocument(late.raw).then(
            (key) =>
              this.toast(
                `Your saved library could not be read (${late.error ?? 'unknown error'}). It has NOT been overwritten, and saving is off for this session so nothing can replace it${key ? ' — a recovery copy was kept' : ''}. Open the browser console for details.`,
                'error',
              ),
            () => undefined,
          );
          return; // storageSettled stays false: saves are refused from here on
        }
        if (late.lib.books.length > 0) {
          // Their shelf wins, whether or not they have touched something in the
          // meantime. Dropping the document when `pristine` was false and then
          // re-baselining to its revision (below) made the compare-and-swap see
          // "nothing moved", so the very next save wrote this EMPTY fallback
          // library over every book — no error, no toast, nothing to undo on
          // file://. The in-window change is superseded instead, and said so.
          const superseded = !this.pristine;
          this.state.lib = late.lib;
          this.state.book = null;
          this.knownStoredRevision = late.lib.meta.updatedAt;
          this.storageSettled = true;
          this.render();
          if (superseded) {
            this.toast(
              'Your saved library was loaded — the change made while it was still loading was not kept.',
              'info',
            );
          }
          return;
        }
        // No BOOKS are stored — but the record itself may still exist, and an
        // empty-but-real document carries the reader's settings: endpoint,
        // model, API key, theme, fonts, templates, reading positions. Writing
        // the in-memory fallback (default settings) over it silently reset all
        // of that — the same class of loss the books branch above refuses.
        // Keep their settings; the shelf keeps whatever is in memory (a fresh
        // profile has none, and a book created during the boot window stays).
        this.state.lib = {
          ...this.state.lib,
          settings: late.lib.settings,
          // …and the STORED revision, not the placeholder's 0. Writing a
          // backwards revision made any other tab whose baseline was the real
          // stamp see a "moved" document and adopt it — discarding the edit
          // that triggered its save, with a toast blaming another tab.
          meta: { ...this.state.lib.meta, updatedAt: late.lib.meta.updatedAt },
        };
        // The baseline must be the revision of the document that is ACTUALLY
        // stored. Boot set it to the fallback document's stamp (0 on a fresh
        // profile), so the very next save saw a "moved" revision, adopted the
        // stored copy and discarded the reader's words — with a toast blaming
        // another tab.
        this.knownStoredRevision = late.lib.meta.updatedAt;
        this.storageSettled = true;
        void this.persistNow();
        // The adopted settings are the ones on screen from now on (theme,
        // fonts, endpoint) — repaint so the reader sees them.
        this.render();
      },
      () => {
        // The read rejected outright: we still know nothing about storage.
      },
    );
  }

  // ---- Render -------------------------------------------------------------

  render(): void {
    this.state.renderCount++;
    this.applyAppearance();
    const content = dispatchView(this);
    renderShell(this, content, this.state.toasts);
    // The shell was just rebuilt, which recreated the working light WITHOUT the
    // inline style `renderActiveState` sets (and the stylesheet hides it by
    // default) — so any re-render mid-request put the light out while the model
    // was still writing, which is exactly when the reader looks for it.
    this.renderActiveState();
  }
}

function dispatchView(api: AppApi): HTMLElement {
  switch (api.view) {
    case 'seed':
      return renderSeed(api);
    case 'titles': {
      const el = renderTitles(api);
      setTimeout(() => maybeAutoGenerate(api), 0);
      return el;
    }
    case 'page':
      return renderPage(api);
    case 'turn':
      return renderTurn(api);
    case 'settings':
      return renderSettings(api);
    case 'reader':
      return renderReader(api);
    case 'theend':
      return renderTheEnd(api);
    case 'archive':
      return renderArchive(api);
    case 'about':
      return renderAbout(api);
    case 'help':
      return renderHelp(api);
    case 'library':
    default:
      return renderLibrary(api);
  }
}

function replaceBook(lib: Library, book: Book): Book[] {
  return lib.books.map((b) => (b.id === book.id ? book : b));
}

// ---- Boot -----------------------------------------------------------------

/** Storage must NEVER block boot: race it and fall back after a short grace period. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function boot(): Promise<void> {
  // Race storage — but remember whether it actually answered in time, and
  // whether it SUCCEEDED. A timed-out read means "slow", and a failed read
  // means "unreadable": neither is "empty", and neither may ever be saved back
  // over the real document.
  const dbLoad = loadLibrary();
  const first = await withTimeout(dbLoad, 1500, null);
  let lib: Library | null = first?.lib ?? null;
  const opfs = await withTimeout(readOpfsLibrary(), 1500, null);
  let opfsStamp: string | null = null;
  // The mirror is a RECOVERY copy, never an override. It used to be adopted
  // whenever the loaded library had no books — but a successfully read, empty
  // library is a deliberate "I deleted everything", and adopting a stale
  // mirror resurrected the deleted books and wrote them back into IndexedDB.
  // Use it only when the database could not be read at all, or when the mirror
  // is demonstrably newer than what we loaded.
  const dbUnreadable = first === null || !first.ok;
  if (opfs && opfs.lib.books.length > 0 && (!lib || (dbUnreadable && !lib.books.length))) {
    lib = opfs.lib;
    opfsStamp = opfs.mirroredAt;
  } else if (
    opfs &&
    lib &&
    lib.books.length === 0 &&
    !dbUnreadable &&
    opfs.lib.meta.updatedAt > lib.meta.updatedAt + 1000
  ) {
    audit('boot: adopted a newer OPFS mirror over an empty stored library');
    lib = opfs.lib;
    opfsStamp = opfs.mirroredAt;
  }
  try {
    lib = lib ? normalizeLibrary(lib) : defaultLibrary();
  } catch {
    lib = defaultLibrary();
  }

  const app = new App(lib, viewFromHash() ?? 'library');
  app.setBaselineRevision(lib.meta.updatedAt);
  if (first === null) {
    // The race timed out — we know nothing about storage yet. Pass the whole
    // LoadResult: a late FAILURE must keep saving disabled, and a late success
    // is adopted by holdPersistenceUntil. (Sampling an "answered" flag AFTER
    // the OPFS await was the bug: a read that settled just past the grace
    // period took neither this path nor the unreadable one, so the empty
    // fallback library was painted and then saved over a real document.)
    app.holdPersistenceUntil(dbLoad);
  } else if (!first.ok) {
    // The stored library exists but could not be read. Park a copy under a
    // SEPARATE key — which cannot damage the original.
    const recoveredFromOpfs = lib.books.length > 0;
    const stampNote = opfsStamp
      ? ` (mirror copy from ${new Date(opfsStamp).toLocaleString()})`
      : '';
    if (!recoveredFromOpfs) {
      // Nothing usable to show: keep saving disabled forever, so the fallback
      // on screen can never be written over the real thing.
      app.holdPersistenceUntil(new Promise<never>(() => {}));
    }
    // When the OPFS mirror DID have a working copy, saving is left ENABLED on
    // purpose: the next save repairs the corrupt record with real data (the
    // corrupt one stays parked under the stash key). Write-locking here would
    // have stranded the reader in a working app that can never save again.
    void stashUnreadableDocument(first.raw).then(
      (key) => {
        console.error(
          `Page Turn: the stored library failed to load.${
            recoveredFromOpfs
              ? ' The OPFS mirror had a working copy, so the app is usable and saving will repair the record.'
              : ' Saving is disabled so it cannot be overwritten.'
          }${key ? ` A recovery copy is preserved in IndexedDB under "${key}".` : ''}`,
          first.error,
        );
        if (key) {
          console.warn(
            `Page Turn: the unreadable stored document is parked in IndexedDB under "${key}" — ${recoverySize(first.raw)}. It was NOT printed here because it contains your book text.`,
          );
        } else {
          // Last resort: the park copy failed too. Print WITHOUT the key.
          console.warn(
            'Page Turn: the unreadable stored document could not be parked; a key-free copy follows.',
            redactKeyInJson(first.raw),
          );
        }
        setTimeout(
          () =>
            app.toast(
              recoveredFromOpfs
                ? `Your saved library could not be read (${first.error ?? 'unknown error'}) — the mirror copy${stampNote} was loaded instead, and your next changes will repair the record${key ? ' (a backup was kept)' : ''}.`
                : `Your saved library could not be read (${first.error ?? 'unknown error'}). It has NOT been overwritten, and saving is off for this session so nothing can replace it${key ? ' — a recovery copy was kept' : ''}. Open the browser console for details.`,
              recoveredFromOpfs ? 'info' : 'error',
            ),
          0,
        );
      },
      () => undefined,
    );
  }
  app.render();

  window.addEventListener('keydown', (event) => {
    if (event.key !== '?' && event.key !== 'Escape') return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.closest('input, textarea, select, [contenteditable="true"]') ||
        target.isContentEditable)
    )
      return;
    if (event.key === '?' && app.view !== 'help') {
      event.preventDefault();
      app.navigate('help');
    } else if (event.key === 'Escape' && app.view === 'help') {
      event.preventDefault();
      app.navigate(app.helpReturnView());
    }
  });

  window.addEventListener('hashchange', () => {
    const view = viewFromHash();
    if (view && view !== app.view) app.navigate(view);
  });

  void requestPersistence();
  // Drag-and-drop import: drop a .ptlibrary.json / .ptbook.json anywhere.
  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    event.preventDefault();
    void file.text().then((text) => {
      try {
        void app.importDropped(JSON.parse(text));
      } catch {
        app.toast('That file is not a Page Turn file', 'error');
      }
    });
  });
  window.addEventListener('beforeunload', () => void app.persistNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void app.persistNow();
  });

  const build = (window as unknown as { __BUILD__?: Record<string, string> }).__BUILD__;
  console.info(
    `%c📖 Page Turn ${build?.version ?? ''}`,
    'font-family: Georgia, serif; font-size: 16px; color: #e8c47a;',
  );

  // Debug affordance for support: inspect live app state from the console.
  (window as unknown as { __PAGE_TURN__?: unknown }).__PAGE_TURN__ = {
    version: build?.version ?? '',
    view: () => app.view,
    params: () => ({ ...app.params }),
    bookId: () => app.book?.id ?? null,
    // Mask the bearer secret: the debug handle is exposed to anything that can
    // run code in this page's console, and the key should never be returned
    // from a support snapshot by accident.
    model: () => ({
      ...app.lib.settings.endpoint,
      apiKey: app.lib.settings.endpoint.apiKey ? '<set>' : '',
    }),
    genCounter: () => app.debug().genCounter,
    renders: () => app.debug().renderCount,
    genStateKeys: () => [...genStates.keys()],
    /** Model requests, for "why is my server busy / how much has this cost me?" */
    requests: () => ({
      total: app.requestCounts().total,
      queued: app.requestCounts().queued,
      inFlight: app.genActive(),
      backlog: app.requestCounts().backlog,
    }),
    audit: () => [...auditLog],
  };
  console.info(
    'Everything lives in this browser profile: IndexedDB + an OPFS file. The story never leaves your machine except to the local LLM endpoint you choose.',
  );
  if (!lib.settings.endpoint.model) {
    console.info('No model selected yet — open Settings and scan for your local LLM.');
  }
}

/** Rough size of the unreadable document, for the console summary. */
function recoverySize(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const lib = raw as { books?: unknown[]; nodes?: Record<string, unknown> };
    return `${lib.books?.length ?? 0} book(s), ${Object.keys(lib.nodes ?? {}).length} node(s)`;
  }
  return 'a stored document';
}

/** Best-effort JSON redaction of the apiKey field for a console dump. */
function redactKeyInJson(raw: unknown): unknown {
  try {
    const text = JSON.stringify(raw, null, 2);
    return JSON.parse(text.replace(/"apiKey"\s*:\s*"[^"]*"/g, '"apiKey": "<redacted>"'));
  } catch {
    return raw;
  }
}

void boot();
