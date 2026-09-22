import { describe, expect, it } from 'vitest';
import { pdfBytes } from '../src/core/pdf';
import { epubBytes } from '../src/core/epub';
import { diffWords } from '../src/core/diff';
import { parseBible } from '../src/core/parsers';
import { paragraphsOf, joinParagraphs } from '../src/core/compile';
import { normalizeLibrary } from '../src/core/schema';

const base = (pages: Array<{ number: number; text: string; words: number }>) => ({
  title: 'T',
  seed: 's',
  pages,
  words: 1,
  endingNote: '',
});

describe('fuzz edge inputs', () => {
  it('pdf/epub survive weird pages', () => {
    const weird = base([
      { number: 1, text: '🕳️😏 emoji — “quotes” and 漢字', words: 3 },
      { number: 2, text: '', words: 0 },
      { number: 3, text: '\n\n\n   \n\n', words: 0 },
      { number: 4, text: 'x'.repeat(20000), words: 1 },
    ]);
    expect(() => pdfBytes(weird)).not.toThrow();
    expect(() => epubBytes(weird)).not.toThrow();
  });
  it('diff survives empty and identical', () => {
    expect(diffWords('', '')).toEqual([]);
    expect(diffWords('a', '')).toHaveLength(1);
    expect(diffWords('', 'b')).toHaveLength(1);
  });
  it('paragraphs survive whitespace-only pages', () => {
    expect(paragraphsOf('   ')).toEqual(['']);
    expect(joinParagraphs(paragraphsOf('a\n\nb'))).toBe('a\n\nb');
  });
  it('parseBible survives garbage and partial objects', () => {
    const prev = {
      people: [],
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
      at: 1,
      updatedAt: 1,
    };
    expect(parseBible('not json at all', prev).summary).toBe('');
    expect(parseBible('{"people":[{"name":"X"}]}', prev).people[0]?.name).toBe('X');
    expect(parseBible('{"people":[]}', prev).people).toEqual([]);
  });
  it('normalizeLibrary survives a page bible with junk relations', () => {
    const seed = {
      id: 's',
      kind: 'seed',
      parentId: null,
      createdAt: 1,
      data: { kind: 'seed', text: 'x', options: {}, titles: [], brief: '' },
    };
    const title = {
      id: 't',
      kind: 'title',
      parentId: 's',
      createdAt: 2,
      data: { kind: 'title', title: 'T', tagline: '' },
    };
    const page = {
      id: 'p',
      kind: 'page',
      parentId: 't',
      createdAt: 3,
      data: {
        kind: 'page',
        versions: [{ v: 1, text: 'x', by: 'ai', at: 1 }],
        chosenVersion: 1,
        direction: {
          direction: '',
          length: 'standard',
          tone: 'inherit',
          ending: false,
          emotions: {},
          chapter: 'none',
          document: 'story',
          pace: 'inherit',
          beat: 'inherit',
          sizeTarget: null,
        },
        model: 'm',
        bible: {
          people: [],
          places: [],
          things: [],
          threads: [],
          relations: [null, 42, {}, { from: 'A', to: 'B', kind: 'k' }],
          summary: 5,
        },
      },
    };
    const book = {
      id: 'b',
      seedNodeId: 's',
      chosenTitleId: 't',
      frontierId: 'p',
      status: 'in-progress',
      model: 'm',
      rules: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const lib = normalizeLibrary({ books: [book], nodes: { s: seed, t: title, p: page } });
    const data = lib.nodes.p?.data;
    expect(data && data.kind === 'page' ? data.bible?.relations : null).toEqual([
      { from: 'A', to: 'B', kind: 'k' },
    ]);
    expect(data && data.kind === 'page' ? data.bible?.summary : null).toBe('');
  });
});

describe('schema round-trip integrity', () => {
  it('a fully-populated library survives JSON round-trip unchanged', () => {
    const seed = {
      id: 's',
      kind: 'seed',
      parentId: null,
      createdAt: 1,
      data: {
        kind: 'seed',
        text: 'The seed.',
        options: {
          genre: 'noir',
          perspective: 'third',
          tense: 'past',
          tone: 'dark',
          audience: 'adult',
          lengthHint: 'novella',
        },
        titles: [{ title: 'T1', tagline: 'tag' }],
        brief: 'A brief.',
      },
    };
    const title = {
      id: 't',
      kind: 'title',
      parentId: 's',
      createdAt: 2,
      data: { kind: 'title', title: 'The Dead Letter', tagline: 'salt and secrets' },
    };
    const turn = {
      id: 'u',
      kind: 'turn',
      parentId: 't',
      createdAt: 3,
      data: {
        kind: 'turn',
        input: {
          direction: 'storm',
          length: 'longer',
          sizeTarget: { kind: 'chars', value: 1500 },
          tone: 'darker',
          ending: false,
          emotions: { dread: 2, joy: -1 },
          chapter: 'start',
          document: 'letter',
          pace: 'propulsive',
          beat: 'cliffhanger',
        },
      },
    };
    const page = {
      id: 'p',
      kind: 'page',
      parentId: 'u',
      createdAt: 4,
      data: {
        kind: 'page',
        versions: [{ v: 1, text: 'Text.', by: 'ai', at: 5, model: 'm', pinned: true }],
        chosenVersion: 1,
        direction: {
          direction: 'storm',
          length: 'longer',
          sizeTarget: { kind: 'chars', value: 1500 },
          tone: 'darker',
          ending: false,
          emotions: { dread: 2, joy: -1 },
          chapter: 'start',
          document: 'letter',
          pace: 'propulsive',
          beat: 'cliffhanger',
        },
        model: 'm',
        bible: {
          people: [{ name: 'Elin', note: 'keeper', details: 'afraid of fog' }],
          places: [{ name: 'the island', note: '' }],
          things: [],
          threads: [{ name: 'the letter', note: 'unopened' }],
          relations: [{ from: 'Elin', to: 'Mara', kind: 'sisters' }],
          summary: 'A keeper found a letter.',
          at: 1,
          updatedAt: 6,
        },
        summary: 'A keeper found a letter.',
      },
    };
    const book = {
      id: 'b',
      seedNodeId: 's',
      chosenTitleId: 't',
      frontierId: 'p',
      status: 'finished',
      model: 'm',
      rules: ['Do not reveal the letter'],
      createdAt: 1,
      updatedAt: 7,
    };
    const lib = {
      schemaVersion: 6,
      books: [book],
      nodes: { s: seed, t: title, u: turn, p: page },
      settings: {
        endpoint: {
          name: 'n',
          baseUrl: 'http://x:1/v1',
          vendor: 'ollama',
          model: 'm',
          temperature: 1.2,
          apiKey: 'k',
        },
        defaultLength: 'shorter',
        autoBible: false,
        autoSuggest: true,
        autoSummary: false,
        templates: [
          {
            name: 'noir',
            input: {
              direction: '',
              length: 'standard',
              sizeTarget: null,
              tone: 'darker',
              ending: false,
              emotions: { dread: 2 },
              chapter: 'none',
              document: 'story',
              pace: 'inherit',
              beat: 'inherit',
            },
          },
        ],
        fastModel: 'fast',
        theme: 'sepia',
        fontScale: 1.1,
        seenOnboarding: true,
        readingPositions: { b: 3 },
      },
    };
    const normalized = normalizeLibrary(JSON.parse(JSON.stringify(lib)));
    const pageData = normalized.nodes.p?.data;
    expect(pageData && pageData.kind === 'page' ? pageData.bible?.relations[0] : null).toEqual({
      from: 'Elin',
      to: 'Mara',
      kind: 'sisters',
    });
    expect(pageData && pageData.kind === 'page' ? pageData.summary : null).toBe(
      'A keeper found a letter.',
    );
    expect(pageData && pageData.kind === 'page' ? pageData.direction.pace : null).toBe(
      'propulsive',
    );
    expect(pageData && pageData.kind === 'page' ? pageData.direction.beat : null).toBe(
      'cliffhanger',
    );
    expect(pageData && pageData.kind === 'page' ? pageData.direction.document : null).toBe(
      'letter',
    );
    expect(pageData && pageData.kind === 'page' ? pageData.direction.sizeTarget : null).toEqual({
      kind: 'chars',
      value: 1500,
    });
    expect(pageData && pageData.kind === 'page' ? pageData.versions[0]?.pinned : false).toBe(true);
    expect(normalized.books[0]?.rules).toEqual(['Do not reveal the letter']);
    expect(normalized.settings.theme).toBe('sepia');
    expect(normalized.settings.autoSummary).toBe(false);
    expect(normalized.settings.templates[0]?.input.emotions.dread).toBe(2);
    expect(normalized.settings.readingPositions).toEqual({ b: 3 });
  });
});

describe('audit-fix regressions', () => {
  it('bible groups are coerced to arrays (malformed data cannot crash downstream)', () => {
    const raw = {
      books: [],
      nodes: {
        p: {
          id: 'p',
          kind: 'page',
          parentId: null,
          createdAt: 1,
          data: {
            kind: 'page',
            versions: [{ v: 1, text: 'x', by: 'ai', at: 1 }],
            chosenVersion: 1,
            direction: {},
            model: 'm',
            bible: {
              people: 'Elin',
              places: 42,
              things: null,
              threads: [],
              relations: [],
              summary: '',
            },
          },
        },
      },
    };
    const lib = normalizeLibrary(raw);
    const data = lib.nodes.p?.data;
    expect(data && data.kind === 'page' ? data.bible?.people : null).toEqual([]);
    expect(data && data.kind === 'page' ? data.bible?.places : null).toEqual([]);
  });

  it('clamps out-of-range chosenVersion instead of silently rendering blank', () => {
    const raw = {
      books: [],
      nodes: {
        p: {
          id: 'p',
          kind: 'page',
          parentId: null,
          createdAt: 1,
          data: {
            kind: 'page',
            versions: [{ v: 1, text: 'x', by: 'ai', at: 1 }],
            chosenVersion: 99,
            direction: {},
            model: 'm',
          },
        },
      },
    };
    const lib = normalizeLibrary(raw);
    const data = lib.nodes.p?.data;
    expect(data && data.kind === 'page' ? data.chosenVersion : null).toBe(1);
  });

  it('normalizeLibrary never mutates the input object', () => {
    const raw = {
      books: [],
      nodes: {
        p: {
          id: 'p',
          kind: 'page',
          parentId: null,
          createdAt: 1,
          data: {
            kind: 'page',
            versions: [{ v: 1, text: 'x', by: 'ai', at: 1 }],
            chosenVersion: 1,
            direction: {},
            model: 'm',
          },
        },
      },
    };
    const snapshot = JSON.stringify(raw);
    normalizeLibrary(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it('keeps directionally-distinct relations (ordered dedup)', () => {
    const prev = {
      people: [],
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
      at: 1,
      updatedAt: 1,
    };
    const bible = parseBible(
      '{"people":[{"name":"A"}],"relations":[{"from":"A","to":"B","kind":"mentors"},{"from":"B","to":"A","kind":"mentors"}]}',
      prev,
    );
    expect(bible.relations.map((r) => `${r.from}→${r.to}`).sort()).toEqual(['A→B', 'B→A']);
  });

  it('PDF strings escape control characters (titles with newlines stay valid)', () => {
    const compiled = {
      title: 'Line1\nLine2',
      seed: 's',
      pages: [],
      words: 0,
      endingNote: '',
    };
    const bytes = pdfBytes(compiled);
    const text = new TextDecoder('latin1').decode(bytes);
    // Newlines are split by the wrapper before escaping — each piece lands on
    // its own line and no raw control character reaches a PDF string.
    expect(text).toContain('(Line1)');
    expect(text).toContain('(Line2)');
    expect(text).not.toContain('(Line1\nLine2)');
  });
});
