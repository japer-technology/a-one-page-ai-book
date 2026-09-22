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
  branchTip,
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
} from './core/tree';
import {
  defaultLibrary,
  emptySeedOptions,
  normalizeBookBundle,
  normalizeLibrary,
} from './core/schema';
import { chat, chatJSON, isTransientLLMError } from './llm/client';
import { compileBook } from './core/compile';
import { loadLibrary, requestPersistence, saveLibrary } from './store/db';
import { readOpfsLibrary, writeMdLibrary, writeOpfsLibrary } from './store/files';
import { newId } from './core/id';
import type { AppApi, ToastKind, ViewName } from './ui/ctx';
import { renderShell, renderToastStack, type Toast } from './ui/shell';
import { renderLibrary } from './ui/views/library';
import { genStates } from './ui/genpage';
import { audit, auditLog } from './ui/audit';
import { renderSeed } from './ui/views/seed';
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
  controllers: Set<AbortController>;
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

let toastSeq = 0;

class App implements AppApi {
  private state: AppState;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (!frontier || frontier.kind === 'title') this.navigate('page');
    else if (frontier.kind === 'page') this.navigate('page');
    else if (frontier.kind === 'turn')
      this.navigate('turn', { from: frontier.parentId ?? book.chosenTitleId });
    else this.navigate('library');
  }

  toast(message: string, kind: ToastKind = 'info'): void {
    const toast: Toast = { id: ++toastSeq, message, kind };
    this.state.toasts.push(toast);
    if (this.state.toasts.length > 4) this.state.toasts.shift();
    // Overlay-only update: a full re-render here would detach live view DOM
    // (form inputs, scan progress) and silently reset what the user is doing.
    renderToastStack(this.state.toasts);
    setTimeout(() => {
      this.state.toasts = this.state.toasts.filter((t) => t.id !== toast.id);
      renderToastStack(this.state.toasts);
    }, 5000);
  }

  update(recipe: (lib: Library) => Library): void {
    this.state.lib = recipe(this.state.lib);
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
    if (open) {
      this.state.book = this.state.lib.books.find((b) => b.id === open.id) ?? open;
    }
    this.scheduleSave();
    this.render();
  }

  setBook(book: Book | null): void {
    this.state.book = book;
    this.render();
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
      parallel?: boolean;
    } = {},
  ): Promise<string> {
    const endpoint = opts.endpoint ?? this.state.lib.settings.endpoint;
    const model = opts.model ?? endpoint.model;
    const armed = this.armGeneration(opts.parallel === true);
    this.state.activeRequests++;
    this.renderActiveState();
    return this.withRetry(
      () =>
        chat(
          {
            endpoint,
            model,
            temperature: endpoint.temperature,
            signal: armed.controller.signal,
            onToken: opts.onToken,
          },
          messages,
        ),
      endpoint.baseUrl,
      armed.controller.signal,
    )
      .catch((err) => {
        // Surface a notice AND rethrow — views still get their retry panels.
        this.toast(this.genError(err), 'error');
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
    opts: { model?: string; endpoint?: EndpointSettings; parallel?: boolean } = {},
  ): Promise<T> {
    const endpoint = opts.endpoint ?? this.state.lib.settings.endpoint;
    const model = opts.model ?? endpoint.model;
    const armed = this.armGeneration(opts.parallel === true);
    this.state.activeRequests++;
    this.renderActiveState();
    return this.withRetry(
      () =>
        chatJSON<T>(
          { endpoint, model, temperature: endpoint.temperature, signal: armed.controller.signal },
          messages,
        ),
      endpoint.baseUrl,
      armed.controller.signal,
    )
      .catch((err) => {
        // Surface a notice AND rethrow — views still get their retry panels.
        this.toast(this.genError(err), 'error');
        throw err;
      })
      .finally(() => {
        this.state.activeRequests = Math.max(0, this.state.activeRequests - 1);
        this.disarmGeneration(armed);
        this.renderActiveState();
      });
  }

  /**
   * One automatic retry for connection hiccups. Deliberately skipped when the
   * request was aborted or timed out: the signal is dead, so a retry would
   * fail instantly with a misleading "cancelled" error.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted || !isTransientLLMError(err)) throw err;
      audit(`withRetry retrying against ${baseUrl}`);
      this.toast('The local server hiccuped — retrying once…', 'info');
      return fn();
    }
  }

  /** Update ONLY the header's working light (never a full re-render). */
  private renderActiveState(): void {
    if (typeof document === 'undefined') return;
    const chip = document.getElementById('nav-working');
    if (!chip) return;
    chip.style.display = this.state.activeRequests > 0 ? '' : 'none';
  }

  genActive(): number {
    return this.state.activeRequests;
  }

  /**
   * One in-flight request at a time by default (a new request supersedes the
   * old one); `parallel: true` registers alongside instead of superseding —
   * used by the multi-candidate fan-out.
   */
  private armGeneration(parallel = false): {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } {
    if (!parallel) {
      for (const controller of this.state.controllers) controller.abort();
      this.state.controllers.clear();
    }
    const controller = new AbortController();
    this.state.controllers.add(controller);
    this.state.abort = controller;
    const timer = setTimeout(
      () => controller.abort(new DOMException('Generation timed out', 'TimeoutError')),
      GENERATION_TIMEOUT_MS,
    );
    return { controller, timer };
  }

  private disarmGeneration(armed: {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  }): void {
    // Clear OUR timer only — a newer request may have armed its own by now.
    clearTimeout(armed.timer);
    this.state.controllers.delete(armed.controller);
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
  }

  genError(err: unknown): string {
    if (err instanceof DOMException && err.name === 'AbortError') return 'Generation cancelled.';
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      const minutes = Math.round(GENERATION_TIMEOUT_MS / 60_000);
      return `Generation timed out after ${minutes} minutes — the model may be busy or the request too large. Try again, or pick a smaller model.`;
    }
    const message = err instanceof Error ? err.message : String(err);
    const base = this.state.lib.settings.endpoint.baseUrl;
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
      if (
        lib.books.length === 0 ||
        window.confirm(
          'Import ' +
            lib.books.length +
            ' book(s) from the dropped file? It will REPLACE the current library.',
        )
      ) {
        this.update(() => lib);
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
    // Backup nudge: every new version is new writing worth protecting.
    this.update((lib) => ({
      ...lib,
      settings: {
        ...lib.settings,
        exportMeter: {
          ...lib.settings.exportMeter,
          pages: (lib.settings.exportMeter.pages ?? 0) + 1,
        },
      },
    }));
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
    const titleNode = this.ensureTitleNode(book.seedNodeId, option);
    audit(`openBranch book=${book.id} title=${titleNode.id}`);
    let tip = branchTip(this.state.lib.nodes, titleNode.id);
    if (tip.kind === 'ending') {
      const parent = getNode(this.state.lib.nodes, tip.parentId ?? '');
      if (parent) tip = parent;
    }
    this.update((lib) => ({
      ...lib,
      books: replaceBook(lib, { ...setFrontier(book, tip.id), status: 'in-progress' }),
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
    const toast: Toast = {
      id: ++toastSeq,
      message: isPinned ? `📌 Version ${version} pinned` : `Version ${version} unpinned`,
      kind: 'success',
    };
    this.state.toasts.push(toast);
    if (this.state.toasts.length > 4) this.state.toasts.shift();
    renderToastStack(this.state.toasts);
    setTimeout(() => {
      this.state.toasts = this.state.toasts.filter((t) => t.id !== toast.id);
      renderToastStack(this.state.toasts);
    }, 5000);
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
    root.style.setProperty('--font-scale', String(settings.fontScale));
    // The document wardrobe: per-format typography (auto = the reading font).
    const FONT_STACKS: Record<string, string> = {
      georgia: "Georgia, 'Iowan Old Style', serif",
      palatino: "'Palatino Linotype', Palatino, 'Book Antiqua', serif",
      charter: "Charter, 'Bitstream Charter', 'Sitka Text', Georgia, serif",
      serif: 'ui-serif, Georgia, serif',
      sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    };
    for (const format of ['story', 'letter', 'diary', 'newspaper', 'mapnote', 'recipe']) {
      const choice =
        settings.documentFonts?.[format as keyof typeof settings.documentFonts] ?? 'auto';
      root.style.setProperty(
        `--doc-font-${format}`,
        choice === 'auto'
          ? format === 'mapnote'
            ? 'var(--mono)' // map notes default to monospace, matching the CSS
            : 'var(--serif)'
          : (FONT_STACKS[choice] ?? 'var(--serif)'),
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

  async persistNow(): Promise<void> {
    try {
      await saveLibrary(this.state.lib);
      await writeOpfsLibrary(this.state.lib);
      // The .md mirror: the same books as plain, readable markdown files.
      await writeMdLibrary(this.state.lib);
    } catch {
      // Persistence is best-effort; the app keeps working in memory.
    }
  }

  // ---- Render -------------------------------------------------------------

  render(): void {
    this.state.renderCount++;
    this.applyAppearance();
    const content = dispatchView(this);
    renderShell(this, content, this.state.toasts);
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
  let lib: Library | null = null;
  lib = await withTimeout(loadLibrary(), 1500, null);
  const opfs = await withTimeout(readOpfsLibrary(), 1500, null);
  if (opfs && (!lib || lib.books.length === 0) && opfs.books.length > 0) lib = opfs;
  try {
    lib = lib ? normalizeLibrary(lib) : defaultLibrary();
  } catch {
    lib = defaultLibrary();
  }

  const app = new App(lib, viewFromHash() ?? 'library');
  app.render();

  let beforeHelp: ViewName | null = null;
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
      beforeHelp = app.view;
      app.navigate('help');
    } else if (event.key === 'Escape' && app.view === 'help') {
      event.preventDefault();
      app.navigate(beforeHelp ?? 'library');
      beforeHelp = null;
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
    model: () => app.lib.settings.endpoint,
    genCounter: () => app.debug().genCounter,
    renders: () => app.debug().renderCount,
    genStateKeys: () => [...genStates.keys()],
    audit: () => [...auditLog],
  };
  console.info(
    'Everything lives in this browser profile: IndexedDB + an OPFS file. The story never leaves your machine except to the local LLM endpoint you choose.',
  );
  if (!lib.settings.endpoint.model) {
    console.info('No model selected yet — open Settings and scan for your local LLM.');
  }
}

void boot();
