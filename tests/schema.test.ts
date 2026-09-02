import { describe, expect, it } from 'vitest';
import {
  defaultLibrary,
  isBookBundle,
  mergeNodes,
  normalizeBookBundle,
  normalizeLibrary,
} from '../src/core/schema';
import { emptySeedOptions } from '../src/core/schema';
import { finishBook, makeBook, makePageNode, makeSeedNode, makeTitleNode } from '../src/core/tree';
import { DEFAULT_TURN } from '../src/core/types';
import type { StoryNode } from '../src/core/types';

function goodLibrary() {
  const seed = makeSeedNode('seed', emptySeedOptions());
  const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
  const page = makePageNode(title.id, DEFAULT_TURN, 'm', 'text');
  const book = finishBook(makeBook(seed.id, title.id, 'm'), page.id);
  return {
    schemaVersion: 1,
    books: [book],
    nodes: { [seed.id]: seed, [title.id]: title, [page.id]: page },
    settings: defaultLibrary().settings,
  };
}

describe('normalizeLibrary', () => {
  it('accepts a well-formed library', () => {
    const lib = normalizeLibrary(goodLibrary());
    expect(lib.books).toHaveLength(1);
    expect(Object.keys(lib.nodes).length).toBe(3);
    expect(lib.settings.endpoint.vendor).toBe('openai-compat');
  });

  it('fills defaults for missing settings', () => {
    const lib = normalizeLibrary({ books: [], nodes: {} });
    expect(lib.books).toEqual([]);
    expect(lib.settings.defaultLength).toBe('standard');
    expect(lib.settings.endpoint.baseUrl).toContain('127.0.0.1');
  });

  it('rejects books pointing at missing nodes', () => {
    const raw = goodLibrary();
    raw.books[0]!.frontierId = 'missing';
    expect(() => normalizeLibrary(raw)).toThrow(/frontier node missing/);
  });

  it('rejects non-objects and bad nodes', () => {
    expect(() => normalizeLibrary('nope')).toThrow(/not a JSON object/);
    expect(() =>
      normalizeLibrary({ books: [], nodes: { x: { id: 'x', kind: 'warp', data: {} } } }),
    ).toThrow(/unknown kind/);
  });

  it('normalizes temperature into range', () => {
    const lib = normalizeLibrary({
      books: [],
      nodes: {},
      settings: { endpoint: { temperature: 99 } },
    });
    expect(lib.settings.endpoint.temperature).toBeGreaterThanOrEqual(0);
    expect(lib.settings.endpoint.temperature).toBeLessThanOrEqual(2);
  });
});

describe('book bundles', () => {
  it('detects and normalizes a single-book file', () => {
    const lib = goodLibrary();
    const book = lib.books[0]!;
    const bundle = { format: 'page-turn-book', version: 1, book, nodes: lib.nodes };
    expect(isBookBundle(bundle)).toBe(true);
    expect(isBookBundle(lib)).toBe(false);
    const normalized = normalizeBookBundle(bundle);
    expect(normalized.book.id).toBe(book.id);
  });

  it('rejects malformed bundles', () => {
    expect(() => normalizeBookBundle({ format: 'page-turn-book', book: {}, nodes: {} })).toThrow();
  });
});

describe('mergeNodes', () => {
  it('prefers the target library on id collision', () => {
    const target = { a: { id: 'a' } };
    const incoming = { a: { id: 'a' }, b: { id: 'b' } };
    const merged = mergeNodes(
      target as unknown as Record<string, StoryNode>,
      incoming as unknown as Record<string, StoryNode>,
    );
    expect(Object.keys(merged)).toHaveLength(2);
  });
});

describe('defaultLibrary', () => {
  it('starts empty with sensible settings', () => {
    const lib = defaultLibrary();
    expect(lib.books).toEqual([]);
    expect(lib.nodes).toEqual({});
    expect(lib.schemaVersion).toBe(1);
  });
});
