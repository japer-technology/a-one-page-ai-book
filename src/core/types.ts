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

/** The emotion dials (§7.3 of the product spec): −3…+3, 0/missing = inherit. */
export const EMOTION_NAMES = [
  'tension',
  'wonder',
  'warmth',
  'dread',
  'humor',
  'sadness',
  'romance',
  'joy',
  'mystery',
  'menace',
] as const;
export type EmotionName = (typeof EMOTION_NAMES)[number];
export type EmotionDials = Partial<Record<EmotionName, number>>;

/** Compact icons for the mood map (the calibration tables live in prompt.ts). */
export const EMOTION_ICONS: Record<EmotionName, string> = {
  tension: '🕯️',
  wonder: '✨',
  warmth: '🤍',
  dread: '🕳️',
  humor: '😏',
  sadness: '🌧️',
  romance: '🖤',
  joy: '☀️',
  mystery: '❓',
  menace: '⚠️',
};

export type ChapterIntent = 'none' | 'start' | 'close';

/** Diegetic document formats — the page IS a letter, a diary entry, a clipping… */
export const DOCUMENT_FORMATS = [
  'story',
  'letter',
  'diary',
  'newspaper',
  'mapnote',
  'recipe',
] as const;
export type PageDocument = (typeof DOCUMENT_FORMATS)[number];

export const DOCUMENT_META: Record<PageDocument, { icon: string; label: string }> = {
  story: { icon: '📄', label: 'story page' },
  letter: { icon: '✉️', label: 'a letter' },
  diary: { icon: '📓', label: 'a diary entry' },
  newspaper: { icon: '📰', label: 'a newspaper clipping' },
  mapnote: { icon: '🗺️', label: 'map marginalia' },
  recipe: { icon: '🍲', label: 'a recipe' },
};

/** Precise page sizing: a numeric target in words, paragraphs, or characters. */
export interface PageSizeTarget {
  kind: 'words' | 'paragraphs' | 'chars';
  value: number;
}

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
  /** Pinned versions sort first and can never be lost in the shuffle. */
  pinned?: boolean;
}

/** One entry in the living cast — a person, place, or significant thing. */
export interface BibleEntry {
  name: string;
  note: string;
  /** Optional longer free-form character/place sheet, written by the reader. */
  details?: string;
}

/** The story bible: everything established up to a page, viewable any time. */
export interface StoryBible {
  people: BibleEntry[];
  places: BibleEntry[];
  things: BibleEntry[];
  /** Open story threads — questions/mysteries the book must eventually resolve. */
  threads: BibleEntry[];
  /** 1-based page number this cast reflects. */
  at: number;
  updatedAt: number;
}

/** What the reader asked for at a page turn. Recorded verbatim, forever. */
export interface TurnInput {
  /** Free-text direction; '' means "continue naturally". */
  direction: string;
  length: LengthPreference;
  /** Precise numeric target; overrides the length preset when set. */
  sizeTarget: PageSizeTarget | null;
  tone: Tone;
  /** Bring the story to a close with this page. */
  ending: boolean;
  /** Emotion dials, only the ones the reader touched. */
  emotions: EmotionDials;
  /** Chapter structure: none / start a new chapter / close this chapter. */
  chapter: ChapterIntent;
  /** Diegetic document format for the page. */
  document: PageDocument;
}

export const DEFAULT_TURN: TurnInput = {
  direction: '',
  length: 'standard',
  sizeTarget: null,
  tone: 'inherit',
  ending: false,
  emotions: {},
  chapter: 'none',
  document: 'story',
};

export type NodeData =
  | {
      kind: 'seed';
      text: string;
      options: SeedOptions;
      titles: TitleOption[];
      /** The distilled pre-writing brief (from the chat), if any. */
      brief: string;
    }
  | { kind: 'title'; title: string; tagline: string }
  | {
      kind: 'page';
      versions: PageVersion[];
      chosenVersion: number;
      direction: TurnInput;
      model: string;
      /** The living cast as known after this page (updated lazily). */
      bible?: StoryBible;
      /** The rolling story summary as of this page (updated lazily in the background). */
      summary?: string;
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
  /** Standing rules ("don't touch" constraints) — persist until removed. */
  rules: string[];
  createdAt: number;
  updatedAt: number;
}

export type EndpointVendor = 'openai-compat' | 'ollama';

export interface EndpointSettings {
  name: string;
  /** e.g. "http://127.0.0.1:1234" — no trailing slash, no /v1. May include a path prefix. */
  baseUrl: string;
  vendor: EndpointVendor;
  model: string;
  temperature: number;
  /** Optional bearer key, sent as Authorization only to this endpoint. */
  apiKey: string;
}

export interface Settings {
  endpoint: EndpointSettings;
  defaultLength: LengthPreference;
  /** Update the living cast in the background after each page. */
  autoBible: boolean;
  /** Update the rolling story summary in the background after each page. */
  autoSummary: boolean;
  /** Propose next-beat suggestions automatically at each turn. */
  autoSuggest: boolean;
  /** Saved turn-console templates ("mood recipes"). */
  templates: TurnTemplate[];
  /** Optional fast model for cheap phases (titles, suggestions, cast, chat). */
  fastModel: string;
  /** Reading theme: dark (default), sepia, or light. */
  theme: 'dark' | 'sepia' | 'light';
  /** Typography scale for the reading pages. */
  fontScale: number;
  /** The library onboarding tour has been seen. */
  seenOnboarding: boolean;
  /** Last reading position per book id (title page = 0). */
  readingPositions: Record<string, number>;
}

/** A saved turn-console setup, reusable at any turn. */
export interface TurnTemplate {
  name: string;
  input: TurnInput;
}

export interface Library {
  schemaVersion: number;
  books: Book[];
  nodes: Record<string, StoryNode>;
  settings: Settings;
}

export const LIBRARY_SCHEMA_VERSION = 6;
