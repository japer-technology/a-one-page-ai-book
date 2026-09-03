/**
 * ui/ctx.ts — the AppApi contract: everything a view may touch.
 *
 * Views are pure functions of (api, params) → DOM. All tree mutations flow
 * through the api mutators so the graph invariants live in one place (main.ts)
 * and every change triggers autosave + re-render.
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
} from '../core/types';

export type ViewName =
  | 'library'
  | 'seed'
  | 'titles'
  | 'page'
  | 'turn'
  | 'settings'
  | 'reader'
  | 'theend'
  | 'archive'
  | 'about';

export type ToastKind = 'info' | 'error' | 'success';

export interface AppApi {
  /** Live views of state — always read them fresh, never destructure-and-forget. */
  readonly lib: Library;
  readonly nodes: Record<string, StoryNode>;
  readonly book: Book | null;
  readonly view: ViewName;
  readonly params: Readonly<Record<string, string>>;

  navigate(view: ViewName, params?: Record<string, string>): void;
  openBook(bookId: string): void;
  /** Re-render the current view (state unchanged). */
  refresh(): void;
  toast(message: string, kind?: ToastKind): void;

  /** The one mutation funnel: apply a recipe to the library, autosave, re-render. */
  update(recipe: (lib: Library) => Library): void;
  setBook(book: Book | null): void;

  // Generation -------------------------------------------------------------
  /** Stream-capable LLM call using the app's endpoint settings (or an override). */
  generateText(
    messages: ChatMessage[],
    opts?: {
      model?: string;
      endpoint?: EndpointSettings;
      onToken?: (token: string) => void;
      /** Keep other in-flight requests alive (parallel candidates). */
      parallel?: boolean;
    },
  ): Promise<string>;
  generateJSON<T>(
    messages: ChatMessage[],
    opts?: { model?: string; endpoint?: EndpointSettings; parallel?: boolean },
  ): Promise<T>;
  /** Generation token: increment before an await, check after, to ignore stale results. */
  beginGen(): number;
  staleGen(token: number): boolean;
  /** Cancel the in-flight LLM request, if any. */
  abortGeneration(): void;
  /** Human-readable message for a generation error. */
  genError(err: unknown): string;

  // Tree mutations (implemented in main.ts with core/tree.ts) ---------------
  newSeed(text: string, options: SeedOptions, brief?: string): StoryNode;
  appendTitles(seedNodeId: string, options: TitleOption[]): void;
  pickTitle(seedNodeId: string, option: TitleOption): Book;
  /** Create a page node under parentId, move the book frontier there. */
  attachPage(
    book: Book,
    parentId: string,
    direction: TurnInput,
    text: string,
    model: string,
    by?: 'ai' | 'user',
  ): StoryNode;
  appendVersion(pageId: string, text: string, by: 'ai' | 'user', model?: string): void;
  chooseVersion(pageId: string, version: number): void;
  attachTurn(book: Book, pageId: string, input: TurnInput): StoryNode;
  finishBook(book: Book, pageId: string, note: string): void;
  unfinishBook(book: Book): void;
  removeBook(bookId: string): void;
  duplicateBook(bookId: string): Book | null;
  /** Move the frontier to an existing page (walk back in time to re-enter/fork). */
  openPageAt(book: Book, pageNodeId: string): void;
  /** Store the living cast snapshot on a page node. */
  saveBible(pageNodeId: string, bible: StoryBible): void;
  /** Store the rolling story summary on a page node. */
  saveSummary(pageNodeId: string, summary: string): void;
  /** Create (or find) the title node for a proposed option, so it can be entered. */
  ensureTitleNode(seedNodeId: string, option: TitleOption): StoryNode;
  /** Re-enter the book from any proposed title (frontier moves to that branch's tip). */
  openBranch(book: Book, option: TitleOption): void;
  /** Replace the book's standing rules. */
  setRules(book: Book, rules: string[]): void;
  /** Rename the chosen title of a book (updates the title node in place). */
  renameTitle(book: Book, title: string): void;
  /** Pin (or unpin) a page version so it sorts first and is never lost. */
  togglePin(pageId: string, version: number): void;
  /** Start a sequel book from a finished one (inherits the cast as a brief). */
  seedFromBook(bookId: string): void;
  /** Apply the reading theme + font scale from settings to the document. */
  applyAppearance(): void;
  /** Remember where the reader left off in a book (title page = 0). */
  setReadingPosition(bookId: string, position: number): void;
}
