/**
 * tests/helpers/view-harness.ts — run the REAL view modules against a stub
 * AppApi.
 *
 * The views (src/ui/views/*.ts, src/ui/cast.ts, …) had no automated coverage
 * at all: every regression in them was found by hand or by a review pass, and
 * the fixes for earlier ones (the "Check this direction" button that typing
 * deleted, the cast form that stayed open and duplicated on a second Save)
 * were only ever verified in a live browser. This harness makes those flows
 * testable: mount a view, poke the DOM, assert on the rendered tree and on the
 * stub's recorded calls.
 *
 * Usage (needs a DOM — put `// @vitest-environment happy-dom` at the top of
 * the test file):
 *
 *   const app = new StubApp(libOf([...nodes], [book]), book);
 *   const el = mountView(app, renderArchive);
 *   click(findButton(el, 'Enter'));
 *   expect(app.state.book?.frontierId).toBe('p2');
 *
 * The stub stores mutations where the tests need them (openPageAt, saveBible,
 * chooseVersion) and no-ops the rest, recording every call so a test can
 * assert on what the view asked for.
 */
import { setFrontier } from '../../src/core/tree';
import type { Book, Library, StoryNode, TurnInput } from '../../src/core/types';
import type { AppApi, ToastKind, ViewName } from '../../src/ui/ctx';

type Lib = Library;

export class StubApp {
  state: { lib: Lib; book: Book | null; view: ViewName; params: Record<string, string> };
  /** Every api call worth asserting on, in order: [name, ...args]. */
  calls: Array<[string, ...unknown[]]> = [];
  toasts: Array<{ message: string; kind: string }> = [];
  refreshes = 0;
  aborts = 0;
  onRefresh: (() => void) | null = null;
  /** What the next generateJSON/generateText resolves with. */
  genJsonReply: unknown = '[]';
  genTextReply = 'A stub model reply.';
  private gen = 0;

  constructor(lib: Lib, book: Book | null, view: ViewName = 'page') {
    this.state = { lib, book, view, params: {} };
  }

  get lib(): Lib {
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

  navigate(view: ViewName, params: Record<string, string> = {}): void {
    this.calls.push(['navigate', view, params]);
    this.state.view = view;
    this.state.params = params;
  }
  openBook(bookId: string): void {
    this.calls.push(['openBook', bookId]);
    const found = this.state.lib.books.find((b) => b.id === bookId);
    if (found) this.state.book = found;
  }
  refresh(): void {
    this.refreshes++;
    this.onRefresh?.();
  }
  toast(message: string, kind: ToastKind = 'info'): void {
    this.toasts.push({ message, kind });
  }
  update(recipe: (lib: Lib) => Lib): void {
    this.state.lib = recipe(this.state.lib);
    const open = this.state.book;
    this.state.book = open
      ? (this.state.lib.books.find((b) => b.id === open.id) ?? this.state.book)
      : null;
    // The real `update()` re-renders the view (main.ts update() -> render()).
    // Several view bugs only appear because a mutation repaints BEFORE the
    // handler's own state cleanup runs, so the harness must repaint too.
    this.onRefresh?.();
  }
  setBook(book: Book | null): void {
    this.state.book = book;
  }

  // ---- Generation ---------------------------------------------------------
  async generateText(messages?: unknown): Promise<string> {
    this.calls.push(['generateText', messages]);
    return this.genTextReply;
  }
  async generateJSON<T>(): Promise<T> {
    this.calls.push(['generateJSON']);
    return this.genJsonReply as T;
  }
  beginGen(): number {
    return ++this.gen;
  }
  staleGen(token: number): boolean {
    return token !== this.gen;
  }
  abortGeneration(): void {
    this.aborts++;
    this.gen++;
  }
  genError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
  genActive(): number {
    return 0;
  }

  // ---- Mutations the view tests exercise ----------------------------------
  openPageAt(_book: Book, pageId: string): void {
    this.calls.push(['openPageAt', pageId]);
    const node = this.state.lib.nodes[pageId];
    if (!node || node.kind !== 'page') return;
    const book = this.state.book;
    if (!book) return;
    this.update((lib) => ({
      ...lib,
      books: lib.books.map((b) =>
        b.id === book.id ? { ...setFrontier(book, pageId), status: 'in-progress' } : b,
      ),
    }));
    this.navigate('page');
  }
  chooseVersion(pageId: string, version: number): void {
    this.calls.push(['chooseVersion', pageId, version]);
    this.update((lib) => ({
      ...lib,
      nodes: {
        ...lib.nodes,
        [pageId]: {
          ...lib.nodes[pageId]!,
          data: {
            ...(lib.nodes[pageId]!.data as object),
            chosenVersion: version,
          } as StoryNode['data'],
        },
      },
    }));
  }
  saveBible(pageNodeId: string, bible: unknown): void {
    this.calls.push(['saveBible', pageNodeId, bible]);
    this.update((lib) => ({
      ...lib,
      nodes: {
        ...lib.nodes,
        [pageNodeId]: {
          ...lib.nodes[pageNodeId]!,
          data: { ...(lib.nodes[pageNodeId]!.data as object), bible } as StoryNode['data'],
        },
      },
    }));
  }

  // ---- Recorded no-ops ----------------------------------------------------
  newSeed(): StoryNode {
    this.calls.push(['newSeed']);
    throw new Error('not stubbed');
  }
  appendTitles(): void {
    this.calls.push(['appendTitles']);
  }
  pickTitle(): Book {
    this.calls.push(['pickTitle']);
    throw new Error('not stubbed');
  }
  attachPage(): void {
    this.calls.push(['attachPage']);
  }
  appendVersion(pageId: string, text: string): void {
    this.calls.push(['appendVersion', pageId, text]);
  }
  attachTurn(): StoryNode {
    this.calls.push(['attachTurn']);
    throw new Error('not stubbed');
  }
  finishBook(): void {
    this.calls.push(['finishBook']);
  }
  unfinishBook(): void {
    this.calls.push(['unfinishBook']);
  }
  removeBook(): void {
    this.calls.push(['removeBook']);
  }
  duplicateBook(): Book | null {
    this.calls.push(['duplicateBook']);
    return null;
  }
  saveSummary(pageNodeId: string, summary: string): void {
    this.calls.push(['saveSummary', pageNodeId, summary]);
  }
  ensureTitleNode(): StoryNode {
    this.calls.push(['ensureTitleNode']);
    throw new Error('not stubbed');
  }
  openBranch(book: Book, option: unknown): void {
    this.calls.push(['openBranch', book.id, option]);
  }
  setRules(): void {
    this.calls.push(['setRules']);
  }
  renameTitle(): void {
    this.calls.push(['renameTitle']);
  }
  togglePin(pageId: string, version: number): void {
    this.calls.push(['togglePin', pageId, version]);
  }
  seedFromBook(): void {
    this.calls.push(['seedFromBook']);
  }
  applyAppearance(): void {
    this.calls.push(['applyAppearance']);
  }
  setReadingPosition(bookId: string, position: number): void {
    this.calls.push(['setReadingPosition', bookId, position]);
  }
  setTags(): void {
    this.calls.push(['setTags']);
  }
  markExported(): void {
    this.calls.push(['markExported']);
  }
  async importDropped(): Promise<void> {
    this.calls.push(['importDropped']);
  }
  writePrologue(): void {
    this.calls.push(['writePrologue']);
  }
  setIronMode(): void {
    this.calls.push(['setIronMode']);
  }
  savePortrait(): void {
    this.calls.push(['savePortrait']);
  }
}

/** The stub as the views' AppApi. */
export function api(app: StubApp): AppApi {
  return app as unknown as AppApi;
}

/**
 * Mount a view the way the shell does: the view owns a div, and `refresh()`
 * replaces its children (so interaction-triggered re-renders are exercised
 * for real).
 */
export function mountView(
  app: StubApp,
  render: (a: AppApi) => HTMLElement,
  into?: HTMLElement,
): HTMLElement {
  const root = into ?? document.createElement('div');
  // One mounted view at a time, exactly like the shell (renderShell replaces
  // the app subtree): views that look themselves up through `document`
  // (e.g. the conflict area) must find THEIR node, not a previous test's.
  if (!into) document.body.replaceChildren(root);
  const paint = (): void => root.replaceChildren(render(api(app)));
  app.onRefresh = paint;
  app.refresh = () => {
    app.calls.push(['refresh']);
    app.refreshes++;
    app.onRefresh?.();
  };
  root.replaceChildren(render(api(app)));
  return root;
}

export function all(root: Element, selector: string): HTMLElement[] {
  return [...root.querySelectorAll(selector)] as HTMLElement[];
}

export function texts(root: Element, selector: string): string[] {
  return all(root, selector).map((el) => el.textContent.trim());
}

export function findButton(root: Element, needle: string): HTMLElement | undefined {
  return all(root, 'button').find((b) => b.textContent.includes(needle));
}

export function click(el: Element | undefined): void {
  if (!el) throw new Error('click: element missing');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

/** Type into an input/textarea the way a reader does (input event + value). */
export function type(input: HTMLInputElement | HTMLTextAreaElement | null, value: string): void {
  if (!input) throw new Error('type: input missing');
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** A mutable turn input for fixtures. */
export function turnInput(patch: Partial<TurnInput> = {}): TurnInput {
  return {
    direction: '',
    tone: 'inherit',
    length: 'standard',
    emotions: {},
    ending: false,
    ...patch,
  } as TurnInput;
}

/** Wait a macrotask so an `await` inside a view callback can settle. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
