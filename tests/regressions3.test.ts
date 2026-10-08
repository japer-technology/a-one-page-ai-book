/**
 * tests/regressions3.test.ts — one test per bug fixed in the third deep pass:
 * memory-budget windows, model-output salvage (refusals, records, cast groups),
 * import safety (null fields, cross-book frontiers), ledger metrics, and export
 * consistency. Each test names the user-visible symptom it protects.
 */
import { describe, expect, it } from 'vitest';
import {
  addNode,
  makeBook,
  makePageNode,
  makePrologueNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
} from '../src/core/tree';
import { DEFAULT_TURN } from '../src/core/types';
import type { Book, Library, StoryNode, StoryBible, TurnInput } from '../src/core/types';
import { defaultLibrary, emptySeedOptions, normalizeLibrary } from '../src/core/schema';
import { bibleMessages, buildContext, conflictVerdicts, summaryMessages } from '../src/core/prompt';
import { parseBible, parseStringList, parseTitleOptions } from '../src/core/parsers';
import { computeStreak } from '../src/core/stats';
import { lintText } from '../src/core/lint';
import { mdLibraryEntries } from '../src/core/mdfiles';
import { compileBook } from '../src/core/compile';

// ---- helpers ---------------------------------------------------------------

const SNAP: TurnInput = { ...DEFAULT_TURN, emotions: {} };

function tree(entries: StoryNode[]): Record<string, StoryNode> {
  let nodes: Record<string, StoryNode> = {};
  for (const node of entries) nodes = addNode(nodes, node);
  return nodes;
}

/** seed → title → turn → page, frontier on the page. */
function bookWithPageText(pageText: string): {
  nodes: Record<string, StoryNode>;
  book: Book;
} {
  const seed = makeSeedNode('SHORT-SEED-MARKER.', emptySeedOptions());
  const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
  const turn = makeTurnNode(title.id, SNAP);
  const page = makePageNode(turn.id, SNAP, 'm', pageText);
  const nodes = tree([seed, title, turn, page]);
  const book: Book = { ...makeBook(seed.id, title.id, 'm'), frontierId: page.id };
  return { nodes, book };
}

const words = (n: number, marker: string): string =>
  Array.from({ length: n }, (_, i) => `${marker}${i}`).join(' ');

// ---- the memory updaters ----------------------------------------------------

describe('the memory updaters', () => {
  it('fold in the newest page even when it alone exceeds the memory budget', () => {
    const { nodes, book } = bookWithPageText(words(2300, 'w'));
    const ctx = buildContext(nodes, book);
    // The verbatim window keeps the page (its own budget is larger)…
    expect(ctx.pages.join('\n\n')).toContain('w2299');

    // …so the summary/cast update must not silently drop it in favour of the
    // seed alone. Before the fix both requests went without a single word of
    // the page the reader just wrote.
    const summary = summaryMessages(ctx, null)[1]?.content ?? '';
    const bible = bibleMessages(ctx, null)[1]?.content ?? '';
    expect(summary).toContain('w2299');
    expect(bible).toContain('w2299');
  });
});

// ---- the conflict checker ----------------------------------------------------

describe('the conflict checker’s verdicts', () => {
  it('never reports a “not inconsistent” verdict as a conflict', () => {
    expect(conflictVerdicts(['The direction is not inconsistent with the story so far.'])).toEqual(
      [],
    );
    expect(conflictVerdicts(['This is not inconsistent.'])).toEqual([]);
    expect(conflictVerdicts(["This isn't inconsistent."])).toEqual([]);
  });

  it('keeps a real finding even when a word before “inconsistent” ends in “nt”', () => {
    // The contraction branch must require its apostrophe: blanking a bare "nt"
    // (accou-nt, poi-nt, fro-nt) swallowed the model's actual conflict, and the
    // console reported "no conflicts found". (Follow-up review pass.)
    expect(
      conflictVerdicts(['The account inconsistent with page 3: the gun was destroyed there.']),
    ).toHaveLength(1);
    expect(
      conflictVerdicts(['The point inconsistent with page 2: she never met the keeper.']),
    ).toHaveLength(1);
    expect(conflictVerdicts(['The front inconsistent with the map of the island.'])).toHaveLength(
      1,
    );
  });

  it('accepts conditional consistency hedges as consistency', () => {
    expect(conflictVerdicts(['This would be consistent with the story so far.'])).toEqual([]);
    expect(conflictVerdicts(['The direction remains consistent.'])).toEqual([]);
  });

  it('still keeps real contradictions and mixed verdicts', () => {
    expect(
      conflictVerdicts(['She is established as the keeper’s daughter, not a stranger.']),
    ).toHaveLength(1);
    expect(
      conflictVerdicts(['Consistent with the story, but the gun was destroyed on page 2.']),
    ).toHaveLength(1);
    expect(conflictVerdicts(['The direction is inconsistent with page 3.'])).toHaveLength(1);
  });
});

// ---- title salvage -----------------------------------------------------------

describe('the title salvage', () => {
  it('never offers a refusal or apology as a title', () => {
    expect(parseTitleOptions('I cannot provide titles — this seed is inappropriate.')).toEqual([]);
    expect(
      parseTitleOptions("I'm sorry, but I can't help with that — it goes against my guidelines."),
    ).toEqual([]);
  });

  it('does not discard titles or ideas that merely begin with an apology word', () => {
    // "Sorry, Wrong Number" is a title shape, not a refusal; the filter used to
    // drop any line starting "Sorry," or "I'm sorry". (Follow-up review pass.)
    expect(parseTitleOptions('Sorry, Wrong Number — a radio mystery')).toEqual([
      { title: 'Sorry, Wrong Number', tagline: 'a radio mystery' },
    ]);
    expect(parseTitleOptions("I'm Sorry — two words nobody wanted")).toEqual([
      { title: "I'm Sorry", tagline: 'two words nobody wanted' },
    ]);
    expect(parseStringList('Sorry, Wrong Number')).toEqual(['Sorry, Wrong Number']);
    // …while refusal continuations still filter.
    expect(parseStringList("I'm sorry, but I can't help with that.")).toEqual([]);
    expect(parseStringList('Sorry, but I cannot write that.')).toEqual([]);
  });

  it('still reads a normal list', () => {
    expect(parseTitleOptions('1. The Dead Letter — A story of salt and secrets')).toEqual([
      { title: 'The Dead Letter', tagline: 'A story of salt and secrets' },
    ]);
  });
});

// ---- string-list salvage -----------------------------------------------------

describe('the string-list salvage', () => {
  it('never offers a refusal as an idea', () => {
    expect(parseStringList('I cannot help with that request.')).toEqual([]);
  });

  it('reads record items for their text instead of “[object Object]”', () => {
    expect(parseStringList('[{"text":"a"},{"text":"b"}]')).toEqual(['a', 'b']);
    expect(parseStringList('[{"conflict":"the gun was destroyed on page 2"}]')).toEqual([
      'the gun was destroyed on page 2',
    ]);
    expect(parseStringList('["one","two"]')).toEqual(['one', 'two']);
  });
});

// ---- cast merge --------------------------------------------------------------

describe('the cast merge', () => {
  it('never evicts reader-curated entries when the model returns a full list', () => {
    const prev: StoryBible = {
      people: [
        { name: 'Reader-A', note: '' },
        { name: 'Reader-B', note: '' },
      ],
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
      at: 1,
      updatedAt: 1,
    };
    const full = Array.from({ length: 11 }, (_, i) => ({ name: `Model${i}`, note: 'm' }));
    const out = parseBible(
      JSON.stringify({ people: [...full, { name: 'Reader-A', note: 'rewritten' }] }),
      prev,
    );
    const names = out.people.map((p) => p.name);
    expect(names).toContain('Reader-A');
    expect(names).toContain('Reader-B');
    expect(out.people.length).toBeLessThanOrEqual(12);
  });

  it('keeps refreshing the living cast when the group sits at its cap', () => {
    // A long story's cast sits at cap permanently; reserving room by slicing
    // the whole model list froze every note forever (0/12 refreshed, where the
    // old merge refreshed all 12). (Follow-up review pass.)
    const prev: StoryBible = {
      people: Array.from({ length: 12 }, (_, i) => ({ name: `N${i}`, note: 'STALE' })),
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
      at: 1,
      updatedAt: 1,
    };
    const model = Array.from({ length: 12 }, (_, i) => ({ name: `N${i}`, note: 'FRESH' }));
    const out = parseBible(JSON.stringify({ people: model }), prev);
    expect(out.people).toHaveLength(12);
    expect(out.people.every((p) => p.note === 'FRESH')).toBe(true);

    // With one seat free, the update and the newcomer both land.
    const eleven = { ...prev, people: prev.people.slice(0, 11) };
    const out2 = parseBible(
      JSON.stringify({ people: [...model.slice(0, 11), { name: 'NEWCOMER', note: 'FRESH' }] }),
      eleven,
    );
    expect(out2.people).toHaveLength(12);
    expect(out2.people.map((p) => p.name)).toContain('NEWCOMER');
    expect(out2.people.filter((p) => p.note === 'FRESH')).toHaveLength(12);
  });

  it('dispatches a bare array by its kind field instead of dumping everything into people', () => {
    const out = parseBible(
      '[{"name":"Elin","kind":"people"},{"name":"the lighthouse","kind":"places"},{"name":"the letter","kind":"things"}]',
    );
    expect(out.people.map((p) => p.name)).toEqual(['Elin']);
    expect(out.places.map((p) => p.name)).toEqual(['the lighthouse']);
    expect(out.things.map((p) => p.name)).toEqual(['the letter']);
  });
});

// ---- import safety -----------------------------------------------------------

describe('the library importer', () => {
  it('reads a null tagline/brief as absent instead of rejecting the whole library', () => {
    const seed = makeSeedNode('S', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
    const lib = normalizeLibrary({
      schemaVersion: 1,
      nodes: {
        [seed.id]: { ...seed, data: { ...seed.data, brief: null } },
        [title.id]: { ...title, data: { ...title.data, tagline: null } },
      },
      books: [{ ...makeBook(seed.id, title.id, 'm') }],
      settings: {},
      meta: { updatedAt: 0 },
    });
    expect(lib.books).toHaveLength(1);
    const storedTitle = lib.nodes[title.id];
    const storedSeed = lib.nodes[seed.id];
    expect(storedTitle && storedTitle.data.kind === 'title' ? storedTitle.data.tagline : null).toBe(
      '',
    );
    expect(storedSeed && storedSeed.data.kind === 'seed' ? storedSeed.data.brief : null).toBe('');
  });

  it('repairs a frontier that points into another book’s subtree', () => {
    const seedA = makeSeedNode('A seed.', emptySeedOptions());
    const titleA = makeTitleNode(seedA.id, { title: 'A title', tagline: '' });
    const turnA = makeTurnNode(titleA.id, SNAP);
    const pageA = makePageNode(turnA.id, SNAP, 'm', 'A page text.');
    const seedB = makeSeedNode('B seed.', emptySeedOptions());
    const titleB = makeTitleNode(seedB.id, { title: 'B title', tagline: '' });
    const nodes = tree([seedA, titleA, turnA, pageA, seedB, titleB]);
    const bookA: Book = { ...makeBook(seedA.id, titleA.id, 'm'), frontierId: pageA.id };
    // The bug: book B borrows book A's page as its frontier.
    const bookB: Book = { ...makeBook(seedB.id, titleB.id, 'm'), frontierId: pageA.id };
    const lib = normalizeLibrary({
      schemaVersion: 1,
      nodes,
      books: [bookA, bookB],
      settings: {},
      meta: { updatedAt: 0 },
    });
    const storedB = lib.books.find((b) => b.id === bookB.id);
    expect(storedB).toBeTruthy();
    const compiledB = compileBook(lib.nodes, storedB as Book);
    // Before the fix, B rendered A's title, seed and page.
    expect(compiledB.seed).toBe('B seed.');
    expect(compiledB.title).toBe('B title');
    expect(compiledB.pages).toHaveLength(0);
    const storedA = lib.books.find((b) => b.id === bookA.id) as Book;
    expect(compileBook(lib.nodes, storedA).pages).toHaveLength(1);
  });
});

// ---- the streak ledger -------------------------------------------------------

describe('the streak ledger', () => {
  it('never counts junk activity days as runs', () => {
    expect(computeStreak(['junk', 'zzz'], '2026-02-10')).toEqual({ streak: 0, longest: 0 });
    expect(computeStreak(['2026-02-09', '2026-02-09x', '2026-02-10'], '2026-02-10')).toEqual({
      streak: 2,
      longest: 2,
    });
  });

  it('drops impossible-but-shaped days at import', () => {
    const lib = normalizeLibrary({
      schemaVersion: 1,
      nodes: {},
      books: [],
      settings: { activityDays: { '2026-02-10': 1, '2026-02-30': 1, '2026-99-99': 1 } },
      meta: { updatedAt: 0 },
    });
    expect(lib.settings.activityDays).toEqual({ '2026-02-10': 1 });
  });
});

// ---- the linter --------------------------------------------------------------

describe('the linter', () => {
  it('counts a sentence that ends inside a closing quote', () => {
    expect(lintText('He said "go home." Then he left. She stayed.').sentences).toBe(3);
    expect(
      lintText('"You shouldn’t have come," she said. "Not now." He stepped back. "I had to."')
        .sentences,
    ).toBe(4);
  });

  it('does not call -ly nouns adverbs', () => {
    const report = lintText(
      'The family came. The family left. The family stayed. The family waited. The family cried. The family slept.',
    );
    expect(report.adverbRatio).toBeLessThan(0.08);
    expect(report.issues.some((i) => i.message.includes('adverbs'))).toBe(false);
  });
});

// ---- the .md export ----------------------------------------------------------

describe('the .md export', () => {
  it('uses one page count in index.md and in the book file', () => {
    const seed = makeSeedNode('Prologue seed.', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'Prologue Book', tagline: '' });
    const prologue = makePrologueNode(title.id, SNAP, 'm', 'Prologue text.');
    const chain: StoryNode[] = [];
    let parent = prologue.id;
    for (let i = 1; i <= 3; i++) {
      const turn = makeTurnNode(parent, SNAP);
      const page = makePageNode(turn.id, SNAP, 'm', `Page ${i} text.`);
      chain.push(turn, page);
      parent = page.id;
    }
    const nodes = tree([seed, title, prologue, ...chain]);
    const book: Book = { ...makeBook(seed.id, title.id, 'm'), frontierId: parent };
    const lib: Library = {
      ...defaultLibrary(),
      books: [book],
      nodes,
      meta: { updatedAt: 0 },
    };
    const entries = mdLibraryEntries(lib);
    const index = entries.find((e) => e.name === 'index.md')?.content ?? '';
    const file = entries.find((e) => e.name.startsWith('books/'))?.content ?? '';
    expect(index).toContain('3 pages');
    expect(file).toContain('Pages kept: 3');
  });
});
