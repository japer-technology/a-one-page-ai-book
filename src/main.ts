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
  StoryBible,
  StoryNode,
  TitleOption,
  TurnInput,
} from './core/types';
import {
  addNode,
  appendPageVersion,
  appendTitleOptions,
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
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
  removeSubtree,
  setBookRules,
  setChosenVersion,
  setFrontier,
  setVersionPinned,
  cloneSubtree,
} from './core/tree';
import { defaultLibrary, emptySeedOptions, normalizeLibrary } from './core/schema';
import { chat, chatJSON } from './llm/client';
import { compileBook } from './core/compile';
import { loadLibrary, requestPersistence, saveLibrary } from './store/db';
import { readOpfsLibrary, writeOpfsLibrary } from './store/files';
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
import { renderReader } from './ui/views/reader';
import { renderTheEnd } from './ui/views/theend';
import { renderArchive } from './ui/views/archive';
import { renderAbout } from './ui/views/about';

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
    return chat(
      {
        endpoint,
        model,
        temperature: endpoint.temperature,
        signal: armed.controller.signal,
        onToken: opts.onToken,
      },
      messages,
    ).finally(() => this.disarmGeneration(armed));
  }

  generateJSON<T>(
    messages: ChatMessage[],
    opts: { model?: string; endpoint?: EndpointSettings; parallel?: boolean } = {},
  ): Promise<T> {
    const endpoint = opts.endpoint ?? this.state.lib.settings.endpoint;
    const model = opts.model ?? endpoint.model;
    const armed = this.armGeneration(opts.parallel === true);
    return chatJSON<T>(
      { endpoint, model, temperature: endpoint.temperature, signal: armed.controller.signal },
      messages,
    ).finally(() => this.disarmGeneration(armed));
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
    const titleNode = makeTitleNode(seedNodeId, option);
    const book = makeBook(seedNodeId, titleNode.id, this.state.lib.settings.endpoint.model);
    this.state.book = book;
    this.update((lib) => ({
      ...lib,
      nodes: addNode(lib.nodes, titleNode),
      books: [...lib.books, book],
    }));
    return book;
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
    }));
    return node;
  }

  appendVersion(pageId: string, text: string, by: 'ai' | 'user', model?: string): void {
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

  applyAppearance(): void {
    const settings = this.state.lib.settings;
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty('--font-scale', String(settings.fontScale));
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

  window.addEventListener('hashchange', () => {
    const view = viewFromHash();
    if (view && view !== app.view) app.navigate(view);
  });

  void requestPersistence();
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
