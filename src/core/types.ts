/**
 * core/types.ts — the domain model. Pure data, no DOM, no I/O.
 *
 * The book is a graph of immutable-ish StoryNodes (append-only data inside).
 * Every seed, title, page version and page-turn decision is a node, so any
 * moment can be re-entered and re-branched. See docs/ARCHITECTURE.md.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LengthPreference = 'shorter' | 'standard' | 'longer';

export type Tone =
  | 'inherit'
  | 'darker'
  | 'lighter'
  | 'warmer'
  | 'colder'
  | 'funnier'
  | 'more-serious'
  | 'more-poetic'
  | 'more-plain';

/** Optional seed-level settings (light defaults; none are locked in). */
export interface SeedOptions {
  genre: string;
  perspective: 'first' | 'third' | 'second' | '';
  tense: 'past' | 'present' | '';
  tone: 'warm' | 'dark' | 'funny' | 'literary' | 'pulpy' | '';
  audience: 'kid-safe' | 'teen' | 'adult' | '';
  lengthHint: 'short-story' | 'novella' | 'let-it-run' | '';
}

export interface TitleOption {
  title: string;
  tagline: string;
}

export interface PageVersion {
  v: number;
  text: string;
  by: 'ai' | 'user';
  at: number;
  model?: string;
}

/** What the reader asked for at a page turn. Recorded verbatim, forever. */
export interface TurnInput {
  /** Free-text direction; '' means "continue naturally". */
  direction: string;
  length: LengthPreference;
  tone: Tone;
  /** Bring the story to a close with this page. */
  ending: boolean;
}

export const DEFAULT_TURN: TurnInput = {
  direction: '',
  length: 'standard',
  tone: 'inherit',
  ending: false,
};

export type NodeData =
  | { kind: 'seed'; text: string; options: SeedOptions; titles: TitleOption[] }
  | { kind: 'title'; title: string; tagline: string }
  | {
      kind: 'page';
      versions: PageVersion[];
      chosenVersion: number;
      direction: TurnInput;
      model: string;
    }
  | { kind: 'turn'; input: TurnInput }
  | { kind: 'ending'; note: string };

export interface StoryNode {
  id: string;
  kind: NodeData['kind'];
  parentId: string | null;
  createdAt: number;
  data: NodeData;
}

export interface Book {
  id: string;
  seedNodeId: string;
  chosenTitleId: string;
  /** The node where the reader currently is; new work grows from here. */
  frontierId: string;
  status: 'in-progress' | 'finished';
  /** Model this book was started with (metadata per page records per-page model). */
  model: string;
  createdAt: number;
  updatedAt: number;
}

export type EndpointVendor = 'openai-compat' | 'ollama';

export interface EndpointSettings {
  name: string;
  /** e.g. "http://127.0.0.1:1234" — no trailing slash, no /v1. */
  baseUrl: string;
  vendor: EndpointVendor;
  model: string;
  temperature: number;
}

export interface Settings {
  endpoint: EndpointSettings;
  defaultLength: LengthPreference;
}

export interface Library {
  schemaVersion: number;
  books: Book[];
  nodes: Record<string, StoryNode>;
  settings: Settings;
}

export const LIBRARY_SCHEMA_VERSION = 1;
