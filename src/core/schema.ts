/**
 * core/schema.ts — the library document: defaults, validation, and import
 * normalization for files read from disk. The whole library serializes to one
 * JSON document, which makes IndexedDB, OPFS and file import/export trivial.
 */
import type {
  Book,
  EndpointSettings,
  Library,
  NodeData,
  SeedOptions,
  StoryBible,
  StoryNode,
  TurnInput,
} from './types';
import { DEFAULT_TURN, EMOTION_NAMES, LIBRARY_SCHEMA_VERSION } from './types';

export const DEFAULT_ENDPOINT: EndpointSettings = {
  name: 'LM Studio (default)',
  baseUrl: 'http://127.0.0.1:1234',
  vendor: 'openai-compat',
  model: '',
  temperature: 0.9,
  apiKey: '',
};

const DOC_FORMATS = ['story', 'letter', 'diary', 'newspaper', 'mapnote', 'recipe'] as const;
type DocFormat = (typeof DOC_FORMATS)[number];

function defaultDocumentFonts(
  raw: unknown,
): Record<DocFormat, 'auto' | 'georgia' | 'palatino' | 'charter' | 'serif' | 'sans'> {
  const base: Record<DocFormat, 'auto' | 'georgia' | 'palatino' | 'charter' | 'serif' | 'sans'> = {
    story: 'auto',
    letter: 'auto',
    diary: 'auto',
    newspaper: 'auto',
    mapnote: 'auto',
    recipe: 'auto',
  };
  if (!raw || typeof raw !== 'object') return base;
  const record = raw as Record<string, unknown>;
  for (const format of DOC_FORMATS) {
    const value = record[format];
    if (
      value === 'auto' ||
      value === 'georgia' ||
      value === 'palatino' ||
      value === 'charter' ||
      value === 'serif' ||
      value === 'sans'
    ) {
      base[format] = value;
    }
  }
  return base;
}

export function defaultSettings() {
  return {
    endpoint: { ...DEFAULT_ENDPOINT },
    defaultLength: 'standard' as const,
    autoBible: true,
    autoSummary: true,
    autoSuggest: false,
    templates: [],
    fastModel: '',
    theme: 'dark' as const,
    readingFont: 'georgia' as const,
    documentFonts: defaultDocumentFonts(undefined),
    fontScale: 1,
    seenOnboarding: false,
    readingPositions: {},
    activityDays: {},
    exportMeter: { lastExportAt: 0, pages: 0 },
  };
}

export function defaultLibrary(): Library {
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    books: [],
    nodes: {},
    settings: defaultSettings(),
  };
}

const KINDS: ReadonlySet<string> = new Set(['seed', 'title', 'page', 'turn', 'ending', 'prologue']);

function fail(reason: string): never {
  throw new Error(`Invalid Page Turn file: ${reason}`);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function asString(x: unknown, what: string): string {
  if (typeof x !== 'string') fail(`${what} must be a string`);
  return x;
}

function normalizeNode(raw: unknown): StoryNode {
  if (!isRecord(raw)) fail('node is not an object');
  const id = asString(raw.id, 'node.id');
  const kind = asString(raw.kind, 'node.kind');
  if (!KINDS.has(kind)) fail(`node "${id}" has unknown kind "${kind}"`);
  const parentId =
    raw.parentId === null || raw.parentId === undefined
      ? null
      : asString(raw.parentId, 'node.parentId');
  if (typeof raw.createdAt !== 'number') fail(`node "${id}" createdAt must be a number`);
  if (!isRecord(raw.data)) fail(`node "${id}" data is missing`);
  // Work on a clone: normalization must never mutate (or alias) the caller's object.
  const data = structuredClone(raw.data) as NodeData;
  if (data.kind !== kind) fail(`node "${id}" kind field disagrees with data.kind`);
  switch (data.kind) {
    case 'seed':
      asString(data.text, `node "${id}" seed text`);
      if (!isRecord(data.options)) fail(`node "${id}" seed options missing`);
      if (!Array.isArray(data.titles)) fail(`node "${id}" seed titles must be an array`);
      if (data.brief === undefined) data.brief = '';
      else asString(data.brief, `node "${id}" seed brief`);
      break;
    case 'title':
      asString(data.title, `node "${id}" title`);
      break;
    case 'page': {
      if (!Array.isArray(data.versions) || data.versions.length === 0) {
        fail(`node "${id}" page has no versions`);
      }
      if (typeof data.chosenVersion !== 'number') fail(`node "${id}" page chosenVersion missing`);
      data.chosenVersion = Math.max(
        1,
        Math.min(data.versions.length, Math.floor(data.chosenVersion)),
      );
      data.direction = normalizeTurnInput(data.direction);
      // The living-cast snapshot is optional derived data; pass it through,
      // filling the threads group for bibles saved before it existed.
      if (data.bible !== undefined) {
        if (!isRecord(data.bible)) delete data.bible;
        else {
          if (!Array.isArray(data.bible.people)) data.bible.people = [];
          if (!Array.isArray(data.bible.places)) data.bible.places = [];
          if (!Array.isArray(data.bible.things)) data.bible.things = [];
          if (!Array.isArray(data.bible.threads)) data.bible.threads = [];
          if (!Array.isArray(data.bible.relations)) {
            data.bible.relations = [];
          } else {
            data.bible.relations = (data.bible.relations as unknown[])
              .map((raw): StoryBible['relations'][number] | null => {
                if (typeof raw === 'string') {
                  const [from, kind, to] = raw.split(/\s*[—–-]\s*/);
                  if (from?.trim() && to?.trim() && kind?.trim()) {
                    return { from: from.trim(), to: to.trim(), kind: kind.trim() };
                  }
                  return null;
                }
                if (!isRecord(raw)) return null;
                const from = typeof raw.from === 'string' ? raw.from.trim() : '';
                const to = typeof raw.to === 'string' ? raw.to.trim() : '';
                const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
                if (!from || !to || !kind) return null;
                return { from, to, kind };
              })
              .filter((r): r is NonNullable<typeof r> => r !== null);
          }
          if (typeof data.bible.summary !== 'string') data.bible.summary = '';
        }
      }
      // The rolling summary is optional derived data; drop non-string values.
      if (data.summary !== undefined && typeof data.summary !== 'string') delete data.summary;
      break;
    }
    case 'turn': {
      if (!isRecord(data.input)) fail(`node "${id}" turn input missing`);
      data.input = normalizeTurnInput(data.input);
      break;
    }
    case 'prologue': {
      if (!Array.isArray(data.versions) || data.versions.length === 0) {
        fail(`node "${id}" prologue has no versions`);
      }
      if (typeof data.chosenVersion !== 'number')
        fail(`node "${id}" prologue chosenVersion missing`);
      data.chosenVersion = Math.max(
        1,
        Math.min(data.versions.length, Math.floor(data.chosenVersion)),
      );
      data.direction = normalizeTurnInput(data.direction);
      break;
    }
    case 'ending':
      if (data.portrait !== undefined && typeof data.portrait !== 'string') delete data.portrait;
      break;
  }
  return { id, kind: kind as StoryNode['kind'], parentId, createdAt: raw.createdAt, data };
}

/** Tolerate old files and sloppy shapes: fill every TurnInput field safely. */
export function normalizeTurnInput(raw: unknown): TurnInput {
  const input = (isRecord(raw) ? raw : {}) as Record<string, unknown>;
  const length: TurnInput['length'] =
    input.length === 'shorter' || input.length === 'longer' || input.length === 'standard'
      ? input.length
      : DEFAULT_TURN.length;
  const tone: TurnInput['tone'] =
    typeof input.tone === 'string' && TONE_NAMES.has(input.tone)
      ? (input.tone as TurnInput['tone'])
      : DEFAULT_TURN.tone;
  const chapter: TurnInput['chapter'] =
    input.chapter === 'start' || input.chapter === 'close' || input.chapter === 'none'
      ? input.chapter
      : 'none';
  let sizeTarget: TurnInput['sizeTarget'] = null;
  if (isRecord(input.sizeTarget)) {
    const kind = input.sizeTarget.kind;
    const value = input.sizeTarget.value;
    if (
      (kind === 'words' || kind === 'paragraphs' || kind === 'chars') &&
      typeof value === 'number' &&
      Number.isFinite(value)
    ) {
      const clamped = Math.max(1, Math.min(200000, Math.round(value)));
      sizeTarget = { kind, value: clamped };
    }
  }
  const emotions: TurnInput['emotions'] = {};
  if (isRecord(input.emotions)) {
    for (const name of EMOTION_NAMES) {
      const value = input.emotions[name];
      if (typeof value === 'number' && Number.isFinite(value)) {
        const clamped = Math.max(-3, Math.min(3, Math.round(value)));
        if (clamped !== 0) emotions[name] = clamped;
      }
    }
  }
  const pace: TurnInput['pace'] =
    input.pace === 'slow' || input.pace === 'propulsive' ? input.pace : 'inherit';
  const beat: TurnInput['beat'] =
    input.beat === 'cliffhanger' || input.beat === 'resting' ? input.beat : 'inherit';
  const document: TurnInput['document'] =
    typeof input.document === 'string' &&
    (input.document === 'story' ||
      input.document === 'letter' ||
      input.document === 'diary' ||
      input.document === 'newspaper' ||
      input.document === 'mapnote' ||
      input.document === 'recipe')
      ? input.document
      : 'story';
  return {
    direction: typeof input.direction === 'string' ? input.direction : '',
    length,
    sizeTarget,
    tone,
    ending: input.ending === true,
    emotions,
    chapter,
    document,
    pace,
    beat,
  };
}

const TONE_NAMES: ReadonlySet<string> = new Set([
  'inherit',
  'darker',
  'lighter',
  'warmer',
  'colder',
  'funnier',
  'more-serious',
  'more-poetic',
  'more-plain',
]);

function normalizeBook(raw: unknown, nodes: Record<string, StoryNode>): Book {
  if (!isRecord(raw)) fail('book is not an object');
  const id = asString(raw.id, 'book.id');
  const seedNodeId = asString(raw.seedNodeId, 'book.seedNodeId');
  const chosenTitleId = asString(raw.chosenTitleId, 'book.chosenTitleId');
  const frontierId = asString(raw.frontierId, 'book.frontierId');
  if (!nodes[seedNodeId]) fail(`book "${id}" seed node missing`);
  if (!nodes[chosenTitleId]) fail(`book "${id}" title node missing`);
  if (!nodes[frontierId]) fail(`book "${id}" frontier node missing`);
  const status = raw.status === 'finished' ? 'finished' : 'in-progress';
  return {
    id,
    seedNodeId,
    chosenTitleId,
    frontierId,
    status,
    model: typeof raw.model === 'string' ? raw.model : '',
    rules: Array.isArray(raw.rules)
      ? raw.rules.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : [],
    tags: Array.isArray(raw.tags)
      ? [
          ...new Set(
            raw.tags
              .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
              .map((t) => t.trim()),
          ),
        ]
      : [],
    ironMode: raw.ironMode === 'three' || raw.ironMode === 'iron' ? raw.ironMode : 'none',
    guests: Array.isArray(raw.guests)
      ? [
          ...new Set(
            raw.guests.filter((g): g is string => typeof g === 'string' && g.trim().length > 0),
          ),
        ]
      : [],
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

function normalizeSettings(raw: unknown): Library['settings'] {
  const base = defaultSettings();
  if (!isRecord(raw)) return base;
  const endpoint = isRecord(raw.endpoint) ? raw.endpoint : {};
  const vendor = endpoint.vendor === 'ollama' ? 'ollama' : 'openai-compat';
  return {
    endpoint: {
      name: typeof endpoint.name === 'string' ? endpoint.name : base.endpoint.name,
      baseUrl:
        typeof endpoint.baseUrl === 'string' && endpoint.baseUrl.length > 0
          ? endpoint.baseUrl.replace(/\/+$/, '')
          : base.endpoint.baseUrl,
      vendor,
      model: typeof endpoint.model === 'string' ? endpoint.model : base.endpoint.model,
      temperature:
        typeof endpoint.temperature === 'number' &&
        endpoint.temperature >= 0 &&
        endpoint.temperature <= 2
          ? endpoint.temperature
          : base.endpoint.temperature,
      apiKey: typeof endpoint.apiKey === 'string' ? endpoint.apiKey : '',
    },
    defaultLength:
      raw.defaultLength === 'shorter' || raw.defaultLength === 'longer'
        ? raw.defaultLength
        : 'standard',
    autoBible: raw.autoBible !== false,
    autoSummary: raw.autoSummary !== false,
    autoSuggest: raw.autoSuggest === true,
    fastModel: typeof raw.fastModel === 'string' ? raw.fastModel.trim() : '',
    theme:
      raw.theme === 'sepia' || raw.theme === 'light' || raw.theme === 'system' ? raw.theme : 'dark',
    readingFont:
      raw.readingFont === 'palatino' ||
      raw.readingFont === 'charter' ||
      raw.readingFont === 'serif' ||
      raw.readingFont === 'sans'
        ? raw.readingFont
        : 'georgia',
    documentFonts: defaultDocumentFonts(raw.documentFonts),
    fontScale:
      typeof raw.fontScale === 'number' && Number.isFinite(raw.fontScale)
        ? Math.max(0.8, Math.min(1.4, raw.fontScale))
        : 1,
    seenOnboarding: raw.seenOnboarding === true,
    activityDays: isRecord(raw.activityDays)
      ? Object.fromEntries(
          Object.entries(raw.activityDays).filter(
            (entry): entry is [string, number] =>
              typeof entry[0] === 'string' && typeof entry[1] === 'number',
          ),
        )
      : {},
    exportMeter: isRecord(raw.exportMeter)
      ? {
          lastExportAt:
            typeof raw.exportMeter.lastExportAt === 'number' ? raw.exportMeter.lastExportAt : 0,
          pages: typeof raw.exportMeter.pages === 'number' ? raw.exportMeter.pages : 0,
        }
      : { lastExportAt: 0, pages: 0 },
    readingPositions: isRecord(raw.readingPositions)
      ? Object.fromEntries(
          Object.entries(raw.readingPositions).filter(
            (entry): entry is [string, number] =>
              typeof entry[0] === 'string' &&
              typeof entry[1] === 'number' &&
              Number.isFinite(entry[1]),
          ),
        )
      : {},
    templates: Array.isArray(raw.templates)
      ? raw.templates
          .map((t): Library['settings']['templates'][number] | null => {
            if (!isRecord(t)) return null;
            const name = typeof t.name === 'string' ? t.name.trim() : '';
            if (!name) return null;
            return { name, input: normalizeTurnInput(t.input) };
          })
          .filter((t): t is NonNullable<typeof t> => t !== null)
      : [],
  };
}

/** Validate and normalize a full library document (schemaVersion-tolerant). */
export function normalizeLibrary(raw: unknown): Library {
  if (!isRecord(raw)) fail('not a JSON object');
  const nodesRaw = isRecord(raw.nodes) ? raw.nodes : fail('"nodes" object missing');
  const nodes: Record<string, StoryNode> = {};
  for (const [id, node] of Object.entries(nodesRaw)) {
    if (node === undefined) continue;
    try {
      const normalized = normalizeNode(node);
      // The map key must agree with the node's own id — a mismatched pair
      // would silently store the node under a key nothing references.
      if (normalized.id !== id) fail(`node key "${id}" disagrees with node.id "${normalized.id}"`);
      nodes[id] = normalized;
    } catch (err) {
      fail(err instanceof Error ? err.message : 'bad node');
    }
  }
  const books = Array.isArray(raw.books) ? raw.books.map((b) => normalizeBook(b, nodes)) : [];
  // Drop books whose seed node is already owned by another book (guards shared-seed duplicates).
  const seenSeeds = new Set<string>();
  const kept: Book[] = [];
  for (const book of books) {
    if (seenSeeds.has(book.seedNodeId)) continue;
    seenSeeds.add(book.seedNodeId);
    kept.push(book);
  }
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    books: kept,
    nodes,
    settings: normalizeSettings(raw.settings),
  };
}

/** A single-book share file: { format, version, book, nodes }. */
export interface BookBundle {
  format: 'page-turn-book';
  version: number;
  book: Book;
  nodes: Record<string, StoryNode>;
}

export function isBookBundle(raw: unknown): raw is BookBundle {
  return (
    isRecord(raw) && raw.format === 'page-turn-book' && isRecord(raw.book) && isRecord(raw.nodes)
  );
}

export function normalizeBookBundle(raw: unknown): {
  book: Book;
  nodes: Record<string, StoryNode>;
} {
  if (!isRecord(raw) || raw.format !== 'page-turn-book') fail('not a page-turn book file');
  const lib = normalizeLibrary({
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    books: [raw.book],
    nodes: raw.nodes,
    settings: {},
  });
  const book = lib.books[0];
  if (!book) fail('book file contains no book');
  return { book, nodes: lib.nodes };
}

export function emptySeedOptions(): SeedOptions {
  return { genre: '', perspective: '', tense: '', tone: '', audience: '', lengthHint: '' };
}

/** Merge imported nodes into a library without clobbering existing ids. */
export function mergeNodes(
  target: Record<string, StoryNode>,
  incoming: Record<string, StoryNode>,
): Record<string, StoryNode> {
  return { ...incoming, ...target };
}
