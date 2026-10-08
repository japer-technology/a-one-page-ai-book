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
  PageVersion,
  SeedOptions,
  StoryBible,
  StoryNode,
  TitleOption,
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
    lanSubnet: '',
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
    meta: { updatedAt: 0 },
  };
}

const KINDS: ReadonlySet<string> = new Set(['seed', 'title', 'page', 'turn', 'ending', 'prologue']);

function fail(reason: string): never {
  throw new Error(`Invalid Page Turn file: ${reason}`);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * A finite number or a default. `typeof x === 'number'` alone admits Infinity
 * and NaN (`JSON.parse('1e999')` is Infinity), which later blow up in
 * `new Date(v).toISOString()` with a RangeError and take a whole export down.
 */
function finiteOr(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

/**
 * Coerce a cast group into well-formed entries. The elements used to be passed
 * through untouched, so a `null` (or a bare string) in an imported file
 * reached `castMarkdown`/`pdfBytes` and threw "Cannot read properties of null"
 * long after the import had been accepted and saved.
 */
function coerceBibleEntries(raw: unknown): StoryBible['people'] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .map((entry): StoryBible['people'][number] | null => {
      if (typeof entry === 'string') {
        const name = entry.trim();
        return name.length > 0 ? { name, note: '' } : null;
      }
      if (!isRecord(entry)) return null;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (name.length === 0) return null;
      return {
        name,
        note: typeof entry.note === 'string' ? entry.note : '',
        ...(typeof entry.details === 'string' ? { details: entry.details } : {}),
        ...(typeof entry.at === 'number' && Number.isFinite(entry.at) ? { at: entry.at } : {}),
      };
    })
    .filter((entry): entry is StoryBible['people'][number] => entry !== null);
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
      // The prompt builder calls string methods on these (`lengthHint
      // .replaceAll(…)`), so an imported option that is a number used to make
      // every title generation for the book throw, with no way back.
      data.options = normalizeSeedOptions(data.options);
      if (!Array.isArray(data.titles)) fail(`node "${id}" seed titles must be an array`);
      // Validate the ELEMENTS too, not just the container: a `null` element
      // made the library's search haystack (`t.title`) throw, which took the
      // whole shelf down with no way back — the same failure the page branch
      // below was fixed for.
      data.titles = (data.titles as unknown[])
        .map((option): TitleOption | null => {
          if (!isRecord(option)) return null;
          if (typeof option.title !== 'string') return null;
          return {
            title: option.title,
            tagline: typeof option.tagline === 'string' ? option.tagline : '',
          };
        })
        .filter((option): option is TitleOption => option !== null);
      // JSON `null` is the idiomatic "absent" — treat it like undefined rather
      // than rejecting the whole library over one cosmetic field.
      if (data.brief === undefined || data.brief === null) data.brief = '';
      else asString(data.brief, `node "${id}" seed brief`);
      break;
    case 'title':
      asString(data.title, `node "${id}" title`);
      // JSON `null` is the idiomatic "absent" — treat it like undefined rather
      // than rejecting the whole library over one cosmetic field.
      if (data.tagline === undefined || data.tagline === null) data.tagline = '';
      else asString(data.tagline, `node "${id}" title tagline`);
      break;
    case 'page': {
      if (!Array.isArray(data.versions) || data.versions.length === 0) {
        fail(`node "${id}" page has no versions`);
      }
      data.versions = coerceVersions(data.versions);
      if (data.versions.length === 0) fail(`node "${id}" page has no usable versions`);
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
          data.bible.people = coerceBibleEntries(data.bible.people);
          data.bible.places = coerceBibleEntries(data.bible.places);
          data.bible.things = coerceBibleEntries(data.bible.things);
          data.bible.threads = coerceBibleEntries(data.bible.threads);
          if (!Array.isArray(data.bible.relations)) {
            data.bible.relations = [];
          } else {
            data.bible.relations = (data.bible.relations as unknown[])
              .map((raw): StoryBible['relations'][number] | null => {
                if (typeof raw === 'string') {
                  // Split on an em/en dash when one is present (the canonical
                  // form). Only fall back to a bare hyphen — which is
                  // legitimately part of names like "Anna-Maria" — when the
                  // string contains no dash, and then require spaces around
                  // it.
                  const parts = /[—–]/.test(raw) ? raw.split(/\s*[—–]\s*/) : raw.split(/\s+-\s+/);
                  const [from, kind, to] = parts;
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
      // The same ELEMENT validation as a page: a prologue with a numeric or
      // missing `text` used to normalize cleanly and then throw inside
      // `countWords` in compileBook — killing the reader, the ending view and
      // every export for that book.
      data.versions = coerceVersions(data.versions);
      if (data.versions.length === 0) fail(`node "${id}" prologue has no usable versions`);
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
      // The same hardening as a page's `text`: every export calls string
      // methods on the note (`endingNote.trim()`, `.split()`), so an imported
      // number — or a missing note — used to make the whole book permanently
      // unexportable, and quietly stopped the OPFS markdown mirror.
      data.note = typeof data.note === 'string' ? data.note : '';
      if (data.portrait !== undefined && typeof data.portrait !== 'string') delete data.portrait;
      break;
  }
  return { id, kind: kind as StoryNode['kind'], parentId, createdAt: raw.createdAt, data };
}

/**
 * Keep only the versions that are actually usable. A version whose `text` is a
 * number (or missing) used to import cleanly and then throw in `countWords`,
 * i.e. the shelf never painted again, with no way back.
 */
function coerceVersions(raw: unknown[]): PageVersion[] {
  return (
    raw
      .map((version): Omit<PageVersion, 'v'> | null => {
        if (!isRecord(version)) return null;
        if (typeof version.text !== 'string') return null;
        return {
          text: version.text,
          by: version.by === 'user' ? 'user' : 'ai',
          at: finiteOr(version.at, 0),
          ...(typeof version.model === 'string' ? { model: version.model } : {}),
          ...(version.pinned === true ? { pinned: true } : {}),
        };
      })
      .filter((version): version is Omit<PageVersion, 'v'> => version !== null)
      // `v` is a LABEL and the key the pin UI matches on (`setVersionPinned`),
      // while every consumer addresses versions by array position. An imported
      // document with gaps or duplicates (e.g. the middle version's text was not
      // a string) made a row pin nothing at all, with the toast naming the wrong
      // version. Renumber to the position AFTER filtering so the two agree.
      .map((version, index) => ({ ...version, v: index + 1 }))
  );
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
  // The pointers must not merely exist — they must point at the right KIND of
  // node. A file whose chosenTitleId pointed at a page imported cleanly and
  // then made `titleNodeOf` throw during render, so the shelf never painted
  // again. Untitled-but-usable is strictly better than bricked.
  if (nodes[seedNodeId]?.kind !== 'seed') fail(`book "${id}" seed node is not a seed`);
  if (nodes[chosenTitleId]?.kind !== 'title') fail(`book "${id}" title node is not a title`);
  if (!nodes[frontierId]) fail(`book "${id}" frontier node missing`);
  // Owning your nodes matters too: a frontier that merely EXISTS can point
  // into ANOTHER book's subtree (hand-merged files, duplicated seeds), and the
  // book then compiled, exported and even wrote inside that other story. The
  // title must belong to this book's seed; a foreign frontier is repaired to
  // the title so the book stays usable without leaking another book's pages.
  const rootedAtSeed = (nodeId: string): boolean => {
    const seen = new Set<string>();
    let cursor: StoryNode | undefined = nodes[nodeId];
    while (cursor && !seen.has(cursor.id)) {
      if (cursor.id === seedNodeId) return true;
      if (cursor.parentId === null) return false;
      seen.add(cursor.id);
      cursor = nodes[cursor.parentId];
    }
    return false;
  };
  if (!rootedAtSeed(chosenTitleId)) fail(`book "${id}" title node is not part of this book`);
  const frontier = rootedAtSeed(frontierId) ? frontierId : chosenTitleId;
  const status = raw.status === 'finished' ? 'finished' : 'in-progress';
  return {
    id,
    seedNodeId,
    chosenTitleId,
    frontierId: frontier,
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
            raw.guests
              .filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
              // Trim BEFORE deduping, like tags/rules: ' Mara ' and 'Mara' are
              // the same co-writer and must not survive as two.
              .map((g) => g.trim()),
          ),
        ]
      : [],
    createdAt: finiteOr(raw.createdAt, Date.now()),
    updatedAt: finiteOr(raw.updatedAt, Date.now()),
  };
}

/** A real calendar day, not just a well-shaped string ("2026-02-30" rolls over). */
function isRealDay(day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

function normalizeSettings(raw: unknown): Library['settings'] {
  const base = defaultSettings();
  if (!isRecord(raw)) return base;
  const endpoint = isRecord(raw.endpoint) ? raw.endpoint : {};
  const vendor = endpoint.vendor === 'ollama' ? 'ollama' : 'openai-compat';
  return {
    endpoint: {
      name: typeof endpoint.name === 'string' ? endpoint.name : base.endpoint.name,
      baseUrl: ((): string => {
        // Strip FIRST, then fall back: '/' (or '///') passed the non-empty
        // guard and was then stripped to '' — an empty URL that every
        // generation would fetch as a relative path.
        if (typeof endpoint.baseUrl !== 'string') return base.endpoint.baseUrl;
        const stripped = endpoint.baseUrl.trim().replace(/\/+$/, '');
        return stripped.length > 0 ? stripped : base.endpoint.baseUrl;
      })(),
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
    // Only a real three-octet base survives: the value is interpolated into
    // scan URLs ("<base>.1–254"), so an imported file must not be able to
    // point the sweep at an arbitrary string.
    lanSubnet:
      typeof raw.lanSubnet === 'string' &&
      /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(raw.lanSubnet.trim()) &&
      raw.lanSubnet
        .trim()
        .split('.')
        .every((octet) => Number(octet) <= 255)
        ? raw.lanSubnet.trim()
        : '',
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
    // Keys must be real `YYYY-MM-DD` days: `computeStreak` parses every key as
    // a date, and one junk key from an imported file threw a RangeError that
    // took the whole shelf render down with it. Shape is not enough —
    // "2026-02-30" is well-shaped but not a day (it parses by rolling over to
    // March), and it used to be counted as a one-day streak.
    activityDays: isRecord(raw.activityDays)
      ? Object.fromEntries(
          Object.entries(raw.activityDays).filter(
            (entry): entry is [string, number] =>
              /^\d{4}-\d{2}-\d{2}$/.test(entry[0]) &&
              isRealDay(entry[0]) &&
              typeof entry[1] === 'number' &&
              Number.isFinite(entry[1]),
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
  const books = Array.isArray(raw.books)
    ? raw.books.map((b) => normalizeBook(b, nodes))
    : raw.books === undefined || raw.books === null
      ? []
      : // A present-but-not-array `books` was silently read as "no books": the
        // load reported ok:true, so boot never stashed or adopted the OPFS
        // mirror, and the next autosave persisted `books: []` for good —
        // every book pointer lost though their nodes still sit in storage.
        // Fail like every other structural field, so recovery can run.
        fail('"books" must be an array');
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
    meta: {
      updatedAt: isRecord(raw.meta)
        ? typeof raw.meta.updatedAt === 'number' && Number.isFinite(raw.meta.updatedAt)
          ? raw.meta.updatedAt
          : 0
        : 0,
    },
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

/**
 * The seed's options as the rest of the app expects them: every field a string
 * from the allowed set, nothing else.
 *
 * `options` reaches the prompt builders verbatim, and one of them does
 * `options.lengthHint.replaceAll('-', ' ')`. An imported library whose
 * `lengthHint` was a number therefore threw on every title generation for that
 * book — the titles screen showed an error the reader could never clear.
 */
export function normalizeSeedOptions(raw: unknown): SeedOptions {
  const input = (isRecord(raw) ? raw : {}) as Record<string, unknown>;
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | '' =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : '';
  return {
    // `genre` is free text: the seed form offers presets but accepts anything.
    genre: typeof input.genre === 'string' ? input.genre : '',
    perspective: oneOf(input.perspective, ['first', 'third', 'second'] as const),
    tense: oneOf(input.tense, ['past', 'present'] as const),
    tone: oneOf(input.tone, ['warm', 'dark', 'funny', 'literary', 'pulpy'] as const),
    audience: oneOf(input.audience, ['kid-safe', 'teen', 'adult'] as const),
    lengthHint: oneOf(input.lengthHint, ['short-story', 'novella', 'let-it-run'] as const),
  };
}

/** Merge imported nodes into a library without clobbering existing ids. */
export function mergeNodes(
  target: Record<string, StoryNode>,
  incoming: Record<string, StoryNode>,
): Record<string, StoryNode> {
  return { ...incoming, ...target };
}
