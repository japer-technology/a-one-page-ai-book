/**
 * core/schema.ts — the library document: defaults, validation, and import
 * normalization for files read from disk. The whole library serializes to one
 * JSON document, which makes IndexedDB, OPFS and file import/export trivial.
 */
import type { Book, EndpointSettings, Library, NodeData, SeedOptions, StoryNode } from './types';
import { LIBRARY_SCHEMA_VERSION } from './types';

export const DEFAULT_ENDPOINT: EndpointSettings = {
  name: 'LM Studio (default)',
  baseUrl: 'http://127.0.0.1:1234',
  vendor: 'openai-compat',
  model: '',
  temperature: 0.9,
  apiKey: '',
};

export function defaultSettings() {
  return { endpoint: { ...DEFAULT_ENDPOINT }, defaultLength: 'standard' as const };
}

export function defaultLibrary(): Library {
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    books: [],
    nodes: {},
    settings: defaultSettings(),
  };
}

const KINDS: ReadonlySet<string> = new Set(['seed', 'title', 'page', 'turn', 'ending']);

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
  const data = raw.data as unknown as NodeData;
  if (data.kind !== kind) fail(`node "${id}" kind field disagrees with data.kind`);
  switch (data.kind) {
    case 'seed':
      asString(data.text, `node "${id}" seed text`);
      if (!isRecord(data.options)) fail(`node "${id}" seed options missing`);
      if (!Array.isArray(data.titles)) fail(`node "${id}" seed titles must be an array`);
      break;
    case 'title':
      asString(data.title, `node "${id}" title`);
      break;
    case 'page':
      if (!Array.isArray(data.versions) || data.versions.length === 0) {
        fail(`node "${id}" page has no versions`);
      }
      if (typeof data.chosenVersion !== 'number') fail(`node "${id}" page chosenVersion missing`);
      break;
    case 'turn':
      if (!isRecord(data.input)) fail(`node "${id}" turn input missing`);
      break;
    case 'ending':
      break;
  }
  return { id, kind: kind as StoryNode['kind'], parentId, createdAt: raw.createdAt, data };
}

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
      nodes[id] = normalizeNode(node);
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
