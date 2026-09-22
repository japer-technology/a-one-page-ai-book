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

  it('carries the API key through normalization and defaults it when absent', () => {
    const lib = normalizeLibrary({
      books: [],
      nodes: {},
      settings: { endpoint: { apiKey: 'sk-test' } },
    });
    expect(lib.settings.endpoint.apiKey).toBe('sk-test');
    const fresh = normalizeLibrary({ books: [], nodes: {} });
    expect(fresh.settings.endpoint.apiKey).toBe('');
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
    expect(lib.schemaVersion).toBe(8);
    expect(lib.settings.autoBible).toBe(true);
    expect(lib.settings.autoSummary).toBe(true);
    expect(lib.settings.autoSuggest).toBe(false);
  });
});

describe('schema v2 fields', () => {
  it('normalizes turn inputs with emotion dials and chapter intent', () => {
    const lib = normalizeLibrary({
      books: [],
      nodes: {
        t: {
          id: 't',
          kind: 'turn',
          parentId: null,
          createdAt: 1,
          data: {
            kind: 'turn',
            input: {
              direction: 'go',
              length: 'longer',
              tone: 'funnier',
              ending: true,
              emotions: { dread: 9, joy: -2, bogus: 4 },
              chapter: 'start',
            },
          },
        },
      },
    });
    const input = lib.nodes.t?.data;
    expect(input && input.kind === 'turn' ? input.input : null).toEqual({
      direction: 'go',
      length: 'longer',
      sizeTarget: null,
      tone: 'funnier',
      ending: true,
      emotions: { dread: 3, joy: -2 }, // clamped; bogus dropped; 0s dropped
      chapter: 'start',
      document: 'story',
      pace: 'inherit',
      beat: 'inherit',
    });
  });

  it('tolerates old turn inputs without emotions or chapter', () => {
    const lib = normalizeLibrary({
      books: [],
      nodes: {
        t: {
          id: 't',
          kind: 'turn',
          parentId: null,
          createdAt: 1,
          data: { kind: 'turn', input: { direction: 'old', length: 'standard', tone: 'inherit' } },
        },
      },
    });
    const input = lib.nodes.t?.data;
    expect(input && input.kind === 'turn' ? input.input : null).toMatchObject({
      emotions: {},
      chapter: 'none',
    });
  });

  it('keeps page bible snapshots and fills default book rules', () => {
    const raw = goodLibrary();
    const pageId = raw.books[0]!.frontierId;
    const page = raw.nodes[pageId]!;
    page.data = {
      ...page.data,
      kind: 'page',
      bible: {
        people: [{ name: 'K', note: 'keeper' }],
        places: [],
        things: [],
        at: 1,
        updatedAt: 2,
      },
    } as never;
    delete (raw.books[0] as { rules?: unknown }).rules;
    const lib = normalizeLibrary(raw);
    expect(lib.books[0]?.rules).toEqual([]);
    const normalizedPage = lib.nodes[pageId]?.data;
    expect(
      normalizedPage && normalizedPage.kind === 'page' && normalizedPage.bible?.people[0]?.name,
    ).toBe('K');
  });

  it('carries rules and writing toggles through normalization', () => {
    const lib = normalizeLibrary({
      books: [],
      nodes: {},
      settings: { autoBible: false, autoSuggest: true },
    });
    expect(lib.settings.autoBible).toBe(false);
    expect(lib.settings.autoSuggest).toBe(true);
    const raw = goodLibrary();
    raw.books[0]!.rules = ['  ', 'Don’t reveal the letter'];
    const withRules = normalizeLibrary(raw);
    expect(withRules.books[0]?.rules).toEqual(['Don’t reveal the letter']);
  });
});

describe('schema v3 fields', () => {
  it('normalizes precise page-size targets', () => {
    const lib = normalizeLibrary({
      books: [],
      nodes: {
        t: {
          id: 't',
          kind: 'turn',
          parentId: null,
          createdAt: 1,
          data: { kind: 'turn', input: { sizeTarget: { kind: 'words', value: 412.7 } } },
        },
      },
    });
    const input = lib.nodes.t?.data;
    expect(input && input.kind === 'turn' ? input.input.sizeTarget : null).toEqual({
      kind: 'words',
      value: 413,
    });
    const bad = normalizeLibrary({
      books: [],
      nodes: {
        t: {
          id: 't',
          kind: 'turn',
          parentId: null,
          createdAt: 1,
          data: { kind: 'turn', input: { sizeTarget: { kind: 'pixels', value: 5 } } },
        },
      },
    });
    const badInput = bad.nodes.t?.data;
    expect(badInput && badInput.kind === 'turn' ? badInput.input.sizeTarget : null).toBeNull();
  });

  it('carries seed briefs and turn templates through normalization', () => {
    const raw = goodLibrary();
    const seed = Object.values(raw.nodes).find((n) => n.kind === 'seed');
    if (seed && seed.data.kind === 'seed') seed.data.brief = 'A quiet gothic mystery.';
    const lib = normalizeLibrary({
      ...raw,
      settings: {
        templates: [{ name: 'noir sting', input: { tone: 'darker', emotions: { dread: 2 } } }],
      },
    });
    const normSeed = Object.values(lib.nodes).find((n) => n.kind === 'seed');
    expect(normSeed && normSeed.data.kind === 'seed' ? normSeed.data.brief : '').toBe(
      'A quiet gothic mystery.',
    );
    expect(lib.settings.templates).toHaveLength(1);
    expect(lib.settings.templates[0]?.name).toBe('noir sting');
    expect(lib.settings.templates[0]?.input.emotions.dread).toBe(2);
    // Templates from files without a sizeTarget still normalize safely.
    const plain = normalizeLibrary({
      books: [],
      nodes: {},
      settings: { templates: [{ name: 'old', input: { direction: 'x' } }] },
    });
    expect(plain.settings.templates[0]?.input.sizeTarget).toBeNull();
  });

  it('fills the threads group for bibles saved before it existed', () => {
    const raw = goodLibrary();
    const pageId = raw.books[0]!.frontierId;
    const page = raw.nodes[pageId]!;
    page.data = {
      ...page.data,
      kind: 'page',
      bible: { people: [], places: [], things: [], at: 1, updatedAt: 2 },
    } as never;
    const lib = normalizeLibrary(raw);
    const data = lib.nodes[pageId]?.data;
    expect(data && data.kind === 'page' ? data.bible?.threads : undefined).toEqual([]);
  });
});

describe('schema v4 fields', () => {
  it('normalizes appearance, fast model and onboarding state', () => {
    const lib = normalizeLibrary({
      books: [],
      nodes: {},
      settings: { theme: 'sepia', fontScale: 1.2, fastModel: ' tiny-1b ', seenOnboarding: true },
    });
    expect(lib.settings.theme).toBe('sepia');
    expect(lib.settings.fontScale).toBe(1.2);
    expect(lib.settings.fastModel).toBe('tiny-1b');
    expect(lib.settings.seenOnboarding).toBe(true);
    const clamped = normalizeLibrary({ books: [], nodes: {}, settings: { fontScale: 9 } });
    expect(clamped.settings.fontScale).toBeLessThanOrEqual(1.4);
    expect(clamped.settings.fontScale).toBeGreaterThanOrEqual(0.8);
    const fresh = normalizeLibrary({ books: [], nodes: {} });
    expect(fresh.settings.theme).toBe('dark');
    expect(fresh.settings.seenOnboarding).toBe(false);
  });

  it('round-trips pinned versions', () => {
    const raw = goodLibrary();
    const pageId = raw.books[0]!.frontierId;
    const page = raw.nodes[pageId]!;
    if (page.data.kind === 'page') page.data.versions[0]!.pinned = true;
    const lib = normalizeLibrary(raw);
    const data = lib.nodes[pageId]?.data;
    expect(data && data.kind === 'page' ? data.versions[0]?.pinned : false).toBe(true);
  });
});

describe('schema v5 fields', () => {
  it('normalizes reading positions and document formats', () => {
    const lib = normalizeLibrary({
      books: [],
      nodes: {
        t: {
          id: 't',
          kind: 'turn',
          parentId: null,
          createdAt: 1,
          data: { kind: 'turn', input: { document: 'letter' } },
        },
      },
      settings: { readingPositions: { b1: 4, bad: 'x' } },
    });
    const input = lib.nodes.t?.data;
    expect(input && input.kind === 'turn' ? input.input.document : 'story').toBe('letter');
    expect(lib.settings.readingPositions).toEqual({ b1: 4 });
    const fresh = normalizeLibrary({ books: [], nodes: {} });
    expect(fresh.settings.readingPositions).toEqual({});
  });
});

describe('schema v6 fields', () => {
  it('carries the rolling story summary through normalization and drops junk', () => {
    const raw = goodLibrary();
    const pageId = raw.books[0]!.frontierId;
    const page = raw.nodes[pageId]!;
    page.data = {
      ...page.data,
      kind: 'page',
      summary: 'The keeper finds a letter; a storm gathers.',
    } as never;
    const lib = normalizeLibrary(raw);
    const data = lib.nodes[pageId]?.data;
    expect(data && data.kind === 'page' ? data.summary : undefined).toBe(
      'The keeper finds a letter; a storm gathers.',
    );
    // (re-read the raw node: the previous `as never` cast poisons the type)
    const pageAgain = raw.nodes[pageId]!;
    pageAgain.data = { ...pageAgain.data, kind: 'page', summary: 42 } as never;
    const dropped = normalizeLibrary(raw);
    const droppedData = dropped.nodes[pageId]?.data;
    expect(
      droppedData && droppedData.kind === 'page' ? droppedData.summary : undefined,
    ).toBeUndefined();
  });

  it('defaults the summary toggle on and preserves an explicit off', () => {
    const fresh = normalizeLibrary({ books: [], nodes: {} });
    expect(fresh.settings.autoSummary).toBe(true);
    const off = normalizeLibrary({ books: [], nodes: {}, settings: { autoSummary: false } });
    expect(off.settings.autoSummary).toBe(false);
  });
});

describe('schema v6 fields', () => {
  it('normalizes pace and beat intents', () => {
    const lib = normalizeLibrary({
      books: [],
      nodes: {
        t: {
          id: 't',
          kind: 'turn',
          parentId: null,
          createdAt: 1,
          data: { kind: 'turn', input: { pace: 'propulsive', beat: 'cliffhanger' } },
        },
      },
    });
    const input = lib.nodes.t?.data;
    expect(input && input.kind === 'turn' ? input.input.pace : null).toBe('propulsive');
    expect(input && input.kind === 'turn' ? input.input.beat : null).toBe('cliffhanger');
    const bad = normalizeLibrary({
      books: [],
      nodes: {
        t: {
          id: 't',
          kind: 'turn',
          parentId: null,
          createdAt: 1,
          data: { kind: 'turn', input: { pace: 'ludicrous', beat: 4 } },
        },
      },
    });
    const badInput = bad.nodes.t?.data;
    expect(badInput && badInput.kind === 'turn' ? badInput.input.pace : null).toBe('inherit');
    expect(badInput && badInput.kind === 'turn' ? badInput.input.beat : null).toBe('inherit');
  });

  it('normalizes bible relations and summary', () => {
    const raw = goodLibrary();
    const pageId = raw.books[0]!.frontierId;
    const page = raw.nodes[pageId]!;
    page.data = {
      ...page.data,
      kind: 'page',
      bible: {
        people: [],
        places: [],
        things: [],
        threads: [],
        relations: [
          { from: 'Elin', to: 'Mara', kind: 'sisters' },
          { from: '', to: 'x', kind: '' },
          'Elin — mentor — Joss',
        ],
        summary: 'A keeper finds a letter.',
        at: 1,
        updatedAt: 2,
      },
    } as never;
    const lib = normalizeLibrary(raw);
    const data = lib.nodes[pageId]?.data;
    const bible = data && data.kind === 'page' ? data.bible : undefined;
    expect(bible?.relations.map((r) => r.kind)).toEqual(['sisters', 'mentor']);
    expect(bible?.summary).toBe('A keeper finds a letter.');
  });
});

describe('schema v7 appearance fields', () => {
  it('normalizes system theme and reading font', () => {
    const lib = normalizeLibrary({
      books: [],
      nodes: {},
      settings: { theme: 'system', readingFont: 'charter' },
    });
    expect(lib.settings.theme).toBe('system');
    expect(lib.settings.readingFont).toBe('charter');
    const fresh = normalizeLibrary({ books: [], nodes: {} });
    expect(fresh.settings.theme).toBe('dark');
    expect(fresh.settings.readingFont).toBe('georgia');
    const bad = normalizeLibrary({
      books: [],
      nodes: {},
      settings: { theme: 'neon', readingFont: 'wingdings' },
    });
    expect(bad.settings.theme).toBe('dark');
    expect(bad.settings.readingFont).toBe('georgia');
  });

  it('normalizes book tags, activity days and the export meter', () => {
    const raw = goodLibrary();
    raw.books[0]!.tags = ['gothic', 'gothic', '  bedtime  '];
    const lib = normalizeLibrary({
      ...raw,
      settings: {
        ...raw.settings,
        activityDays: { '2026-01-01': 3, bad: 'x' },
        exportMeter: { lastExportAt: 9, pages: 12 },
      },
    });
    expect(lib.books[0]?.tags).toEqual(['gothic', 'bedtime']);
    expect(lib.settings.activityDays).toEqual({ '2026-01-01': 3 });
    expect(lib.settings.exportMeter).toEqual({ lastExportAt: 9, pages: 12 });
  });
});

describe('schema v8 round-5 fields', () => {
  it('normalizes prologue nodes, iron mode, guests and portraits', () => {
    const raw = goodLibrary();
    raw.nodes.pro = {
      id: 'pro',
      kind: 'prologue',
      parentId: raw.books[0]!.chosenTitleId,
      createdAt: 2,
      data: {
        kind: 'prologue',
        versions: [{ v: 1, text: 'Before all of it.', by: 'ai', at: 1 }],
        chosenVersion: 9,
        model: 'm',
        direction: DEFAULT_TURN,
      },
    };
    raw.books[0]!.ironMode = 'three';
    raw.books[0]!.guests = ['Mara', 'Mara'];
    const lib = normalizeLibrary(raw);
    const pro = lib.nodes.pro?.data;
    expect(pro && pro.kind === 'prologue' ? pro.chosenVersion : null).toBe(1);
    expect(lib.books[0]?.ironMode).toBe('three');
    expect(lib.books[0]?.guests).toEqual(['Mara']);
    const fresh = normalizeLibrary(goodLibrary());
    expect(fresh.books[0]?.ironMode).toBe('none');
  });

  it('normalizes the document wardrobe', () => {
    const lib = normalizeLibrary({
      books: [],
      nodes: {},
      settings: {
        documentFonts: {
          letter: 'palatino',
          diary: 'sans',
          story: 'charter',
          newspaper: 'auto',
          mapnote: 'serif',
          recipe: 'georgia',
        },
      },
    });
    expect(lib.settings.documentFonts.letter).toBe('palatino');
    expect(lib.settings.documentFonts.diary).toBe('sans');
    const fresh = normalizeLibrary({ books: [], nodes: {} });
    expect(fresh.settings.documentFonts.newspaper).toBe('auto');
  });
});
