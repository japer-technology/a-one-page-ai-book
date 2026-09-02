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
  StoryNode,
  TitleOption,
  TurnInput,
} from './core/types';
import {
  addNode,
  appendPageVersion,
  appendTitleOptions,
  finishBook,
  getNode,
  makeBook,
  makeEndingNode,
  makePageNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
  removeSubtree,
  setChosenVersion,
  setFrontier,
  cloneSubtree,
} from './core/tree';
import { defaultLibrary, normalizeLibrary } from './core/schema';
import { chat, chatJSON } from './llm/client';
import { loadLibrary, requestPersistence, saveLibrary } from './store/db';
import { readOpfsLibrary, writeOpfsLibrary } from './store/files';
import { newId } from './core/id';
import type { AppApi, ToastKind, ViewName } from './ui/ctx';
import { renderShell, type Toast } from './ui/shell';
import { renderLibrary } from './ui/views/library';
import { renderSeed } from './ui/views/seed';
import { maybeAutoGenerate, renderTitles } from './ui/views/titles';
import { renderPage } from './ui/views/page';
import { renderTurn } from './ui/views/turn';
import { renderSettings } from './ui/views/settings';
import { renderReader } from './ui/views/reader';
import { renderTheEnd } from './ui/views/theend';

interface AppState {
  lib: Library;
  book: Book | null;
  view: ViewName;
  params: Record<string, string>;
  toasts: Toast[];
  genCounter: number;
  abort: AbortController | null;
}

let toastSeq = 0;

class App implements AppApi {
  private state: AppState;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(lib: Library) {
    this.state = {
      lib,
      book: null,
      view: 'library',
      params: {},
      toasts: [],
      genCounter: 0,
      abort: null,
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
    this.abortGeneration();
    this.state.view = view;
    this.state.params = params;
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
    this.render();
    setTimeout(() => {
      this.state.toasts = this.state.toasts.filter((t) => t.id !== toast.id);
      this.render();
    }, 5000);
  }

  update(recipe: (lib: Library) => Library): void {
    this.state.lib = recipe(this.state.lib);
    this.scheduleSave();
    this.render();
  }

  setBook(book: Book | null): void {
    this.state.book = book;
    this.render();
  }

  // ---- Generation ---------------------------------------------------------

  generateText(
    messages: ChatMessage[],
    opts: { model?: string; endpoint?: EndpointSettings; onToken?: (token: string) => void } = {},
  ): Promise<string> {
    const endpoint = opts.endpoint ?? this.state.lib.settings.endpoint;
    const model = opts.model ?? endpoint.model;
    this.state.abort = new AbortController();
    return chat(
      {
        endpoint,
        model,
        temperature: endpoint.temperature,
        signal: this.state.abort.signal,
        onToken: opts.onToken,
      },
      messages,
    );
  }

  generateJSON<T>(
    messages: ChatMessage[],
    opts: { model?: string; endpoint?: EndpointSettings } = {},
  ): Promise<T> {
    const endpoint = opts.endpoint ?? this.state.lib.settings.endpoint;
    const model = opts.model ?? endpoint.model;
    this.state.abort = new AbortController();
    return chatJSON<T>(
      { endpoint, model, temperature: endpoint.temperature, signal: this.state.abort.signal },
      messages,
    );
  }

  beginGen(): number {
    return ++this.state.genCounter;
  }

  staleGen(token: number): boolean {
    return token !== this.state.genCounter;
  }

  abortGeneration(): void {
    this.state.abort?.abort();
    this.state.abort = null;
  }

  genError(err: unknown): string {
    if (err instanceof DOMException && err.name === 'AbortError') return 'Generation cancelled.';
    const message = err instanceof Error ? err.message : String(err);
    const base = this.state.lib.settings.endpoint.baseUrl;
    if (
      message.includes('Failed to fetch') ||
      message.includes('NetworkError') ||
      message.includes('Load failed')
    ) {
      return `Can't reach ${base}. Is your local LLM server running? If it is, it may be refusing this page's origin (CORS) — see the help note in Settings.`;
    }
    if (message.includes('No model selected')) return 'No model selected — pick one in Settings.';
    return message;
  }

  // ---- Tree mutations -----------------------------------------------------

  newSeed(text: string, options: SeedOptions): StoryNode {
    const node = makeSeedNode(text, options);
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
  ): StoryNode {
    const node = makePageNode(parentId, direction, model, text);
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
    case 'library':
    default:
      return renderLibrary(api);
  }
}

function replaceBook(lib: Library, book: Book): Book[] {
  return lib.books.map((b) => (b.id === book.id ? book : b));
}

// ---- Boot -----------------------------------------------------------------

async function boot(): Promise<void> {
  let lib: Library | null = null;
  try {
    lib = await loadLibrary();
  } catch {
    lib = null;
  }
  try {
    const opfs = await readOpfsLibrary();
    if (opfs && (!lib || lib.books.length === 0) && opfs.books.length > 0) lib = opfs;
  } catch {
    // OPFS optional
  }
  try {
    lib = lib ? normalizeLibrary(lib) : defaultLibrary();
  } catch {
    lib = defaultLibrary();
  }

  const app = new App(lib);
  app.render();

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
  console.info(
    'Everything lives in this browser profile: IndexedDB + an OPFS file. The story never leaves your machine except to the local LLM endpoint you choose.',
  );
  if (!lib.settings.endpoint.model) {
    console.info('No model selected yet — open Settings and scan for your local LLM.');
  }
}

void boot();
