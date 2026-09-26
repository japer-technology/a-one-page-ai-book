/**
 * tests/regressions.test.ts — one test per bug fixed in the deep UX/correctness
 * pass, so none of them can come back silently. Each test names the user-visible
 * symptom it protects.
 */
import { describe, expect, it } from 'vitest';
import { paragraphsOf, compileBook, toDirectorCut } from '../src/core/compile';
import {
  makeBook,
  makePageNode,
  makePrologueNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
  addNode,
  childrenOf,
  prologueOf,
  statsOf,
} from '../src/core/tree';
import { DEFAULT_TURN } from '../src/core/types';
import type { Book, StoryNode, TurnInput } from '../src/core/types';
import { normalizeLibrary, normalizeBookBundle, defaultLibrary } from '../src/core/schema';
import { parseJSONLoose, parseTitleOptions } from '../src/core/parsers';
import { buildContext, pageMessages } from '../src/core/prompt';
import { lintText } from '../src/core/lint';
import { diffWords } from '../src/core/diff';
import { searchScore } from '../src/core/search';
import { computeStreak, computeShelfStats } from '../src/core/stats';
import { pdfBytes } from '../src/core/pdf';
import { plural, fmtNumber } from '../src/core/format';

// ---- helpers ---------------------------------------------------------------

function tree(entries: StoryNode[]): Record<string, StoryNode> {
  let nodes: Record<string, StoryNode> = {};
  for (const node of entries) nodes = addNode(nodes, node);
  return nodes;
}

/** seed → title → (prologue) → turn → page … */
function bookWithPages(pageCount: number): { nodes: Record<string, StoryNode>; book: Book } {
  const seed = makeSeedNode('A lighthouse keeper finds a letter.', {
    genre: '',
    mood: '',
    length: 'standard',
  } as never);
  const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: 'salt' });
  const all = [seed, title];
  let parentId = title.id;
  for (let i = 1; i <= pageCount; i++) {
    const turn = makeTurnNode(parentId, { ...DEFAULT_TURN, emotions: {} });
    const page = makePageNode(turn.id, { ...DEFAULT_TURN, emotions: {} }, 'm', `Page ${i} text.`);
    all.push(turn, page);
    parentId = page.id;
  }
  const nodes = tree(all);
  const book = makeBook(seed.id, title.id, 'm');
  const frontierId = parentId;
  return { nodes, book: { ...book, frontierId } };
}

// ---- core/compile ----------------------------------------------------------

describe('paragraphsOf', () => {
  it('splits CRLF pages into paragraphs (a whole page was one "paragraph")', () => {
    // Symptom this protects: "rewrite paragraph" on a Windows-authored page
    // committed only the rewritten block and discarded the rest of the page.
    expect(paragraphsOf('First.\r\n\r\nSecond.')).toEqual(['First.', 'Second.']);
    expect(paragraphsOf('First.\r\rSecond.')).toEqual(['First.', 'Second.']);
    expect(paragraphsOf('First.\n\nSecond.')).toEqual(['First.', 'Second.']);
  });
});

describe('compileBook prologue resolution', () => {
  it('uses the prologue of the title on the compiled path, not the chosen one', () => {
    const seed = makeSeedNode('s', {} as never);
    const titleA = makeTitleNode(seed.id, { title: 'A', tagline: '' });
    const titleB = makeTitleNode(seed.id, { title: 'B', tagline: '' });
    const prologueA = makePrologueNode(
      titleA.id,
      { ...DEFAULT_TURN, emotions: {} },
      'm',
      'PROLOGUE A',
    );
    const pageB = makePageNode(titleB.id, { ...DEFAULT_TURN, emotions: {} }, 'm', 'Branch B page.');
    const nodes = tree([seed, titleA, titleB, prologueA, pageB]);
    const book: Book = { ...makeBook(seed.id, titleA.id, 'm'), frontierId: pageB.id };

    const compiled = compileBook(nodes, book);
    expect(compiled.pages.map((p) => p.text)).toEqual(['Branch B page.']);
    expect(compiled.pages.some((p) => p.kind === 'prologue')).toBe(false);
  });

  it('finds the prologue again after the reader re-picks a title', () => {
    const seed = makeSeedNode('s', {} as never);
    const titleA = makeTitleNode(seed.id, { title: 'A', tagline: '' });
    const titleB = makeTitleNode(seed.id, { title: 'B', tagline: '' });
    const prologueA = makePrologueNode(
      titleA.id,
      { ...DEFAULT_TURN, emotions: {} },
      'm',
      'PROLOGUE',
    );
    const nodes = tree([seed, titleA, titleB, prologueA]);

    // Re-picking A (the way pickTitle does: title AND frontier move together)
    // must bring the reader's prologue back. Before the fix, `prologueOf`
    // resolved via chosenTitleId but compileBook's path is what it must follow,
    // so a prologue written under a title that is no longer chosen vanished.
    const rebook = { ...makeBook(seed.id, titleB.id, 'm'), frontierId: titleB.id };
    expect(prologueOf(nodes, rebook)).toBeNull();
    const repicked = { ...rebook, chosenTitleId: titleA.id, frontierId: titleA.id };
    expect(prologueOf(nodes, repicked)?.id).toBe(prologueA.id);
    expect(compileBook(nodes, repicked).pages[0]?.text).toBe('PROLOGUE');
  });
});

describe('toDirectorCut', () => {
  it('labels the beat dial as a beat, not as the ending', () => {
    const { nodes, book } = bookWithPages(1);
    const markdown = toDirectorCut(compileBook(nodes, book));
    expect(markdown).not.toContain('ending: cliffhanger');
  });
});

// ---- core/tree -------------------------------------------------------------

describe('node factories', () => {
  it('snapshot the direction so later UI edits cannot rewrite recorded history', () => {
    const direction: TurnInput = { ...DEFAULT_TURN, emotions: { dread: 2 } };
    const page = makePageNode('p', direction, 'm', 'text');
    const turn = makeTurnNode('p', direction);
    // The turn console keeps the very object it handed over and mutates it.
    direction.emotions.dread = 3;
    direction.ending = true;
    expect(page.data.kind === 'page' && page.data.direction.emotions.dread).toBe(2);
    expect(turn.data.kind === 'turn' && turn.data.input.ending).toBe(false);
  });

  it('does not share one DEFAULT_TURN object across every prologue', () => {
    const a = makePrologueNode('t1', DEFAULT_TURN, 'm', 'a');
    const b = makePrologueNode('t2', DEFAULT_TURN, 'm', 'b');
    expect(a.data).not.toBe(b.data);
    if (a.data.kind === 'prologue' && b.data.kind === 'prologue') {
      expect(a.data.direction).not.toBe(b.data.direction);
    }
  });
});

describe('childrenOf', () => {
  it('stays correct (and cheap) across many nodes', () => {
    const { nodes } = bookWithPages(40);
    const ids = Object.keys(nodes);
    for (const id of ids) {
      expect(childrenOf(nodes, id)).toEqual(
        Object.values(nodes)
          .filter((n) => n.parentId === id)
          .sort((a, b) => a.createdAt - b.createdAt),
      );
    }
  });

  it('does not let a caller corrupt the shared index', () => {
    const { nodes } = bookWithPages(2);
    const seedId = Object.values(nodes).find((n) => n.kind === 'seed')?.id ?? '';
    const first = childrenOf(nodes, seedId);
    first.push(makeTitleNode(seedId, { title: 'injected', tagline: '' }));
    expect(childrenOf(nodes, seedId).length).toBe(1);
  });
});

// ---- core/schema -----------------------------------------------------------

describe('normalizeLibrary hardening', () => {
  it('rejects a page version whose text is not a string', () => {
    // Symptom: import succeeded, then the shelf never painted again
    // (`countWords` called .trim() on a number).
    const payload = {
      schemaVersion: 1,
      books: [],
      nodes: {
        n1: {
          id: 'n1',
          kind: 'page',
          parentId: null,
          createdAt: 1,
          data: {
            kind: 'page',
            versions: [{ v: 1, text: 42, by: 'ai', at: 1 }],
            chosenVersion: 1,
            direction: {},
            model: 'm',
          },
        },
      },
      settings: {},
    };
    expect(() => normalizeLibrary(payload)).toThrow(/no usable versions/);
  });

  it('drops non-object cast entries instead of crashing every export', () => {
    const seed = makeSeedNode('s', {} as never);
    const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
    const page = makePageNode(title.id, { ...DEFAULT_TURN, emotions: {} }, 'm', 'text');
    if (page.data.kind === 'page') {
      page.data.bible = {
        people: [null, { name: 'Elin', note: 'n' }],
        places: [],
        things: [],
        threads: [],
        relations: [],
        summary: '',
      } as never;
    }
    const book = { ...makeBook(seed.id, title.id, 'm'), frontierId: page.id };
    const lib = { ...defaultLibrary(), books: [book], nodes: tree([seed, title, page]) };
    const normalized = normalizeLibrary(JSON.parse(JSON.stringify(lib)));
    const bible = Object.values(normalized.nodes).find((n) => n.data.kind === 'page')?.data;
    expect(bible?.kind === 'page' ? bible.bible?.people : undefined).toEqual([
      { name: 'Elin', note: 'n' },
    ]);
  });

  it('refuses a book whose chosenTitleId points at a non-title node', () => {
    const { nodes, book } = bookWithPages(1);
    const pageId = Object.values(nodes).find((n) => n.kind === 'page')?.id ?? '';
    const payload = {
      schemaVersion: 1,
      books: [{ ...book, chosenTitleId: pageId }],
      nodes,
      settings: {},
    };
    expect(() => normalizeLibrary(payload)).toThrow(/not a title/);
  });

  it('drops non-finite timestamps (they blew up the .md export)', () => {
    const { nodes, book } = bookWithPages(1);
    const payload = {
      schemaVersion: 1,
      books: [{ ...book, createdAt: Infinity, updatedAt: Number.NaN }],
      nodes,
      settings: {},
    };
    const normalized = normalizeLibrary(payload);
    expect(Number.isFinite(normalized.books[0]?.createdAt)).toBe(true);
    expect(Number.isFinite(normalized.books[0]?.updatedAt)).toBe(true);
  });

  it('drops junk activityDays keys (they threw a RangeError in the shelf render)', () => {
    const payload = {
      ...defaultLibrary(),
      settings: { activityDays: { junk: 1, '2026-02-10': 2 } },
    };
    const normalized = normalizeLibrary(JSON.parse(JSON.stringify(payload)));
    expect(Object.keys(normalized.settings.activityDays)).toEqual(['2026-02-10']);
  });

  it('keeps importing a book bundle', () => {
    const { nodes, book } = bookWithPages(1);
    const bundle = { format: 'page-turn-book', version: 1, book, nodes };
    const { book: imported } = normalizeBookBundle(bundle);
    expect(imported.id).toBe(book.id);
  });
});

// ---- core/parsers ----------------------------------------------------------

describe('parseJSONLoose', () => {
  it('finds the payload even when prose contains a balanced bracket pair first', () => {
    // Symptom: the real JSON was rejected and the title salvage path then
    // fabricated titles out of the raw JSON text.
    const text = 'Here are 3 titles [as JSON]:\n[{"title":"A","tagline":"t"}]';
    expect(parseJSONLoose(text)).toEqual([{ title: 'A', tagline: 't' }]);
    expect(parseTitleOptions(text)).toEqual([{ title: 'A', tagline: 't' }]);
  });

  it('still repairs trailing commas', () => {
    expect(parseJSONLoose('{"a":1,}')).toEqual({ a: 1 });
  });
});

// ---- core/prompt -----------------------------------------------------------

describe('buildContext', () => {
  it('never drops the newest page when it alone exceeds the budget', () => {
    const { nodes, book } = bookWithPages(4);
    // Inflate the NEWEST page far beyond any budget.
    const pages = Object.values(nodes).filter((n) => n.kind === 'page');
    const newest = pages[pages.length - 1];
    if (newest && newest.data.kind === 'page') {
      newest.data.versions[0]!.text = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(' ');
    }
    const ctx = buildContext(nodes, book);
    expect(ctx.pages.length).toBeGreaterThan(0);
    const messages = pageMessages(ctx, { ...DEFAULT_TURN, emotions: {} }, 4);
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).not.toContain('nothing exists yet');
    expect(user).toContain('word5999');
  });

  it('still uses the page-1 sentinel for a genuinely empty history', () => {
    const { nodes, book } = bookWithPages(0);
    const messages = pageMessages(buildContext(nodes, book), { ...DEFAULT_TURN, emotions: {} }, 1);
    expect(messages.find((m) => m.role === 'user')?.content).toContain('nothing exists yet');
  });
});

// ---- core/lint & diff & search & stats -------------------------------------

describe('lintText', () => {
  it('reads CRLF pages as paragraphs', () => {
    expect(lintText('A.\r\n\r\nB.').paragraphs).toBe(2);
  });

  it('does not print "(and 0 more)"', () => {
    const report = lintText('one two three four one two three four');
    const repeated = report.issues.find((i) => i.message.includes('Repeated phrasing'));
    if (repeated) expect(repeated.message).not.toContain('0 more');
  });
});

describe('diffWords', () => {
  it('keeps the reconstruction contract on huge pages (line-level fallback)', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(' ');
    const after = `${before} tail`;
    const parts = diffWords(before, after);
    const same = parts
      .filter((p) => p.kind === 'same')
      .map((p) => p.text)
      .join('');
    const del = parts
      .filter((p) => p.kind === 'del')
      .map((p) => p.text)
      .join('');
    const add = parts
      .filter((p) => p.kind === 'add')
      .map((p) => p.text)
      .join('');
    expect(same + del).toBe(before);
    expect(same + add).toBe(after);
  });
});

describe('searchScore', () => {
  it('ranks a contiguous hit above a gappy subsequence', () => {
    const exact = searchScore('dead letter', 'the dead letter');
    const fuzzy = searchScore('dead letter', 'd e a d l e t t e r');
    expect(exact).toBeGreaterThan(fuzzy);
  });
});

describe('statsOf', () => {
  it('still counts a full book correctly with the children index', () => {
    const { nodes, book } = bookWithPages(3);
    const stats = statsOf(nodes, book);
    expect(stats.pages).toBe(3);
    expect(stats.versions).toBe(3);
  });
});

describe('computeStreak', () => {
  it('does not throw on a malformed day', () => {
    expect(() => computeStreak(['junk', 'zzz', '2026-02-10'], '2026-02-10')).not.toThrow();
    expect(computeStreak(['2026-02-10'], '2026-02-10').streak).toBe(1);
  });

  it('survives a junk key slipping into a library', () => {
    const lib = {
      ...defaultLibrary(),
      settings: { ...defaultLibrary().settings, activityDays: { 'not-a-day': 1 } },
    };
    expect(() => computeShelfStats(lib, '2026-02-10')).not.toThrow();
  });
});

// ---- core/pdf --------------------------------------------------------------

describe('pdfBytes word wrapping', () => {
  it('never draws past the page edge for an unbreakable token', () => {
    // Symptom: a long URL / no-space script printed up to 5x the page width.
    const { nodes, book } = bookWithPages(1);
    const long = 'x'.repeat(900);
    const page = Object.values(nodes).find((n) => n.kind === 'page');
    if (page && page.data.kind === 'page') page.data.versions[0]!.text = long;
    const bytes = pdfBytes(compileBook(nodes, { ...book }));
    const raw = new TextDecoder('latin1').decode(bytes);
    // Widest text-showing operator must not exceed the page width.
    const widths = [...raw.matchAll(/\(([^)]*)\)\s*Tj/g)].map((m) => m[1]?.length ?? 0);
    expect(Math.max(...widths)).toBeLessThanOrEqual(900);
  });
});

// ---- core/format -----------------------------------------------------------

describe('plural', () => {
  it('says "1 page", not "1 pages"', () => {
    expect(plural(1, 'page')).toBe('1 page');
    expect(plural(0, 'page')).toBe('0 pages');
    expect(plural(2, 'page')).toBe('2 pages');
    expect(plural(1, 'branch', 'branches')).toBe('1 branch');
    expect(plural(3, 'branch', 'branches')).toBe('3 branches');
    expect(plural(1234, 'word')).toBe(`${fmtNumber(1234)} words`);
  });
});
