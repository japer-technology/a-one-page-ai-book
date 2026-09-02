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
  StoryNode,
  TitleOption,
  TurnInput,
} from '../core/types';

export type ViewName =
  'library' | 'seed' | 'titles' | 'page' | 'turn' | 'settings' | 'reader' | 'theend';

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
    opts?: { model?: string; endpoint?: EndpointSettings; onToken?: (token: string) => void },
  ): Promise<string>;
  generateJSON<T>(
    messages: ChatMessage[],
    opts?: { model?: string; endpoint?: EndpointSettings },
  ): Promise<T>;
  /** Generation token: increment before an await, check after, to ignore stale results. */
  beginGen(): number;
  staleGen(token: number): boolean;
  /** Cancel the in-flight LLM request, if any. */
  abortGeneration(): void;
  /** Human-readable message for a generation error. */
  genError(err: unknown): string;

  // Tree mutations (implemented in main.ts with core/tree.ts) ---------------
  newSeed(text: string, options: SeedOptions): StoryNode;
  appendTitles(seedNodeId: string, options: TitleOption[]): void;
  pickTitle(seedNodeId: string, option: TitleOption): Book;
  /** Create a page node under parentId, move the book frontier there. */
  attachPage(
    book: Book,
    parentId: string,
    direction: TurnInput,
    text: string,
    model: string,
  ): StoryNode;
  appendVersion(pageId: string, text: string, by: 'ai' | 'user', model?: string): void;
  chooseVersion(pageId: string, version: number): void;
  attachTurn(book: Book, pageId: string, input: TurnInput): StoryNode;
  finishBook(book: Book, pageId: string, note: string): void;
  unfinishBook(book: Book): void;
  removeBook(bookId: string): void;
  duplicateBook(bookId: string): Book | null;
}
