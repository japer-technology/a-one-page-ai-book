import { describe, expect, it } from 'vitest';
import {
  addNode,
  appendPageVersion,
  attachBible,
  attachSummary,
  bibleUpTo,
  branchTip,
  chapterCountUpTo,
  childrenOf,
  cloneSubtree,
  collectSubtree,
  finishBook,
  latestBible,
  makeBook,
  makeEndingNode,
  makePageNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
  pageNumberAt,
  pathToRoot,
  removeSubtree,
  setBookRules,
  setChosenVersion,
  setVersionPinned,
  spinePages,
  statsOf,
  summaryUpTo,
  titleOf,
} from '../src/core/tree';
import { emptySeedOptions } from '../src/core/schema';
import { DEFAULT_TURN } from '../src/core/types';
import type { StoryNode } from '../src/core/types';

function fixture() {
  const seed = makeSeedNode('A lighthouse keeper finds a letter.', emptySeedOptions());
  const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
  const page1 = makePageNode(title.id, DEFAULT_TURN, 'model-a', 'Page one text.');
  const turn = makeTurnNode(page1.id, { ...DEFAULT_TURN, direction: 'a stranger arrives' });
  const page2 = makePageNode(
    turn.id,
    { ...DEFAULT_TURN, direction: 'a stranger arrives' },
    'model-a',
    'Page two text.',
  );
  // A discarded sibling: same turn, different page (a branch).
  const page2b = makePageNode(
    turn.id,
    { ...DEFAULT_TURN, direction: 'a storm hits' },
    'model-a',
    'Page two, other branch.',
  );
  let nodes: Record<string, StoryNode> = {};
  for (const node of [seed, title, page1, turn, page2, page2b]) nodes = addNode(nodes, node);
  const book = finishBook(makeBook(seed.id, title.id, 'model-a'), page2.id);
  return { seed, title, page1, turn, page2, page2b, nodes, book };
}

describe('tree basics', () => {
  it('walks root-first paths', () => {
    const { nodes, seed, page1, turn, page2, book } = fixture();
    const path = pathToRoot(nodes, page2.id);
    expect(path.map((n) => n.kind)).toEqual(['seed', 'title', 'page', 'turn', 'page']);
    expect(path[0]?.id).toBe(seed.id);
    expect(path.map((n) => n.id)).toContain(turn.id);
    expect(path.includes(page1)).toBe(true);
    expect(titleOf(nodes, book)).toBe('The Dead Letter');
  });

  it('counts pages along the chosen path, not the whole tree', () => {
    const { nodes, title, page1, page2 } = fixture();
    expect(spinePages(nodes, page2.id).map((p) => p.id)).toEqual([page1.id, page2.id]);
    expect(pageNumberAt(nodes, page2.id)).toBe(2);
    expect(pageNumberAt(nodes, title.id)).toBe(0);
  });

  it('lists children in creation order', () => {
    const { nodes, turn, page2, page2b } = fixture();
    expect(childrenOf(nodes, turn.id).map((n) => n.id)).toEqual([page2.id, page2b.id]);
  });

  it('counts chapter starts along the spine, never by page number', () => {
    const { nodes, title, page1, page2, turn } = fixture();
    // Page 2 starts chapter 1; a further turn leads into chapter 2.
    const chapter2 = makePageNode(
      turn.id,
      { ...DEFAULT_TURN, chapter: 'start' },
      'model-a',
      'Chapter 2 opens.',
    );
    const turn2 = makeTurnNode(chapter2.id, DEFAULT_TURN);
    let withChapter = addNode(nodes, chapter2);
    withChapter = addNode(withChapter, turn2);
    expect(chapterCountUpTo(withChapter, title.id)).toBe(0);
    expect(chapterCountUpTo(withChapter, page1.id)).toBe(0);
    expect(chapterCountUpTo(withChapter, chapter2.id)).toBe(1);
    // Counting up to the turn covers every page before it, so the next page
    // opens chapter 2 — independent of its page number (3 here).
    expect(chapterCountUpTo(withChapter, turn2.id)).toBe(1);
    expect(chapterCountUpTo(withChapter, turn2.id) + 1).toBe(2);
    // The other branch never started a chapter.
    expect(chapterCountUpTo(withChapter, page2.id)).toBe(0);
  });
});

describe('versions', () => {
  it('appends versions and selects them', () => {
    const { page1 } = fixture();
    const v2 = appendPageVersion(page1, 'A better page one.', 'ai', 'model-b');
    expect(v2.data.kind === 'page' && v2.data.versions.length).toBe(2);
    expect(v2.data.kind === 'page' && v2.data.chosenVersion).toBe(2);
    const v1 = setChosenVersion(v2, 1);
    expect(v1.data.kind === 'page' && v1.data.chosenVersion).toBe(1);
    expect(() => setChosenVersion(v2, 9)).toThrow();
  });

  it('keeps every version after branching', () => {
    const { nodes, book } = fixture();
    const stats = statsOf(nodes, book);
    expect(stats.pages).toBe(2); // chosen path
    expect(stats.versions).toBe(3); // all page nodes × 1 version
    expect(stats.branches).toBe(1); // the turn has two children
    expect(stats.words).toBeGreaterThan(0);
  });
});

describe('subtree operations', () => {
  it('clones with fresh ids and remapped parents', () => {
    const { nodes, seed } = fixture();
    const clone = cloneSubtree(nodes, seed.id);
    expect(clone.rootId).not.toBe(seed.id);
    for (const node of Object.values(clone.nodes)) {
      if (node.parentId !== null) {
        expect(clone.nodes[node.parentId]).toBeDefined();
      }
    }
    expect(clone.nodes[clone.rootId]?.parentId).toBeNull();
    const originalIds = Object.keys(nodes);
    for (const id of Object.keys(clone.nodes)) {
      expect(originalIds).not.toContain(id);
    }
  });

  it('removes only the given subtree', () => {
    const { nodes, seed } = fixture();
    const remaining = removeSubtree(nodes, seed.id);
    expect(Object.keys(remaining)).toHaveLength(0);
  });

  it('collects the whole subtree once', () => {
    const { nodes, seed } = fixture();
    expect(collectSubtree(nodes, seed.id)).toHaveLength(6);
  });
});

describe('factories and book state', () => {
  it('creates nodes with unique ids and correct kinds', () => {
    const seed = makeSeedNode('x', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
    const page = makePageNode(title.id, DEFAULT_TURN, 'm', 'text');
    const turn = makeTurnNode(page.id);
    const ending = makeEndingNode(page.id, 'The End');
    expect(new Set([seed.id, title.id, page.id, turn.id, ending.id]).size).toBe(5);
    expect([seed.kind, title.kind, page.kind, turn.kind, ending.kind]).toEqual([
      'seed',
      'title',
      'page',
      'turn',
      'ending',
    ]);
  });

  it('finishBook marks status and moves the frontier', () => {
    const { book, page2 } = fixture();
    expect(book.status).toBe('finished');
    expect(book.frontierId).toBe(page2.id);
  });
});

describe('living cast and standing rules', () => {
  it('attaches a bible to a page and finds the latest along the path', () => {
    const { nodes, page1, page2, book } = fixture();
    const bible1 = {
      people: [],
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
      at: 1,
      updatedAt: 1,
    };
    const bible2 = {
      people: [],
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
      at: 2,
      updatedAt: 2,
    };
    const p1 = attachBible(page1, bible1);
    const p2 = attachBible(page2, bible2);
    const withBibles = { ...nodes, [page1.id]: p1, [page2.id]: p2 };
    const latest = latestBible(withBibles, book);
    expect(latest?.pageNumber).toBe(2);
    const upTo1 = bibleUpTo(withBibles, page1.id);
    expect(upTo1?.pageNumber).toBe(1);
  });

  it('returns null when no page carries a bible', () => {
    const { nodes, book } = fixture();
    expect(latestBible(nodes, book)).toBeNull();
  });

  it('setBookRules replaces the standing rules immutably', () => {
    const { book } = fixture();
    const next = setBookRules(book, ['Don’t kill anyone']);
    expect(next.rules).toEqual(['Don’t kill anyone']);
    expect(book.rules).toEqual([]);
    expect(next.updatedAt).toBeGreaterThanOrEqual(book.updatedAt);
  });

  it('new books start with no standing rules', () => {
    const { book } = fixture();
    expect(book.rules).toEqual([]);
  });
});

describe('authoring additions', () => {
  it('makeSeedNode carries a pre-writing brief', () => {
    const seed = makeSeedNode('x', emptySeedOptions(), 'A quiet gothic mystery.');
    expect(seed.data.kind === 'seed' && seed.data.brief).toBe('A quiet gothic mystery.');
    const plain = makeSeedNode('x', emptySeedOptions());
    expect(plain.data.kind === 'seed' && plain.data.brief).toBe('');
  });

  it('makePageNode records hand-written pages as authored by the user', () => {
    const title = makeTitleNode('root', { title: 'T', tagline: '' });
    const page = makePageNode(title.id, DEFAULT_TURN, 'm', 'my own words', 'user');
    expect(page.data.kind === 'page' && page.data.versions[0]?.by).toBe('user');
  });

  it('bibleUpTo reports the carrying node id', () => {
    const { nodes, page1, book } = fixture();
    const bible = {
      people: [],
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
      at: 1,
      updatedAt: 1,
    };
    const withBible = { ...nodes, [page1.id]: attachBible(page1, bible) };
    const found = bibleUpTo(withBible, book.frontierId);
    expect(found?.nodeId).toBe(page1.id);
    expect(found?.pageNumber).toBe(1);
  });
});

describe('pinning and ledger stats', () => {
  it('pins and unpins a version immutably', () => {
    const { page1 } = fixture();
    const withTwo = appendPageVersion(page1, 'second draft', 'ai');
    const pinned = setVersionPinned(withTwo, 1, true);
    expect(pinned.data.kind === 'page' && pinned.data.versions[0]?.pinned).toBe(true);
    const unpinned = setVersionPinned(pinned, 1, false);
    expect(unpinned.data.kind === 'page' && unpinned.data.versions[0]?.pinned).toBeUndefined();
    expect(withTwo.data.kind === 'page' && withTwo.data.versions[0]?.pinned).toBeUndefined();
  });

  it('stats separate words generated from words kept and hand-written', () => {
    const { nodes, book, page1 } = fixture();
    const withTwo = appendPageVersion(page1, 'rewritten by hand words here', 'user');
    const merged = { ...nodes, [page1.id]: withTwo };
    const stats = statsOf(merged, book);
    expect(stats.words).toBeGreaterThan(0);
    expect(stats.wordsGenerated).toBeGreaterThan(stats.words);
    expect(stats.wordsByUser).toBe(5);
  });
});

describe('rolling story summary', () => {
  it('attaches a summary to a page and finds the latest along the path', () => {
    const { nodes, page1, page2, book } = fixture();
    const p1 = attachSummary(page1, 'The keeper finds a letter.');
    const p2 = attachSummary(page2, 'A stranger arrives as the storm gathers.');
    const withSummaries = { ...nodes, [page1.id]: p1, [page2.id]: p2 };
    const latest = summaryUpTo(withSummaries, book.frontierId);
    expect(latest?.summary).toBe('A stranger arrives as the storm gathers.');
    expect(latest?.pageNumber).toBe(2);
    expect(latest?.nodeId).toBe(page2.id);
    const upTo1 = summaryUpTo(withSummaries, page1.id);
    expect(upTo1?.summary).toBe('The keeper finds a letter.');
    expect(upTo1?.pageNumber).toBe(1);
  });

  it('carries the previous page’s summary when a page has none', () => {
    const { nodes, page1, page2 } = fixture();
    const withSummary = {
      ...nodes,
      [page1.id]: attachSummary(page1, 'The keeper finds a letter.'),
    };
    const found = summaryUpTo(withSummary, page2.id);
    expect(found?.summary).toBe('The keeper finds a letter.');
    expect(found?.nodeId).toBe(page1.id);
    expect(found?.pageNumber).toBe(1);
  });

  it('returns null when no page carries a summary and ignores empty ones', () => {
    const { nodes, page1, book } = fixture();
    expect(summaryUpTo(nodes, book.frontierId)).toBeNull();
    const withEmpty = { ...nodes, [page1.id]: attachSummary(page1, '   ') };
    expect(summaryUpTo(withEmpty, book.frontierId)).toBeNull();
  });
});

describe('branchTip', () => {
  it('walks down the most recent child chain to the branch frontier', () => {
    const { nodes, title, page2, page2b } = fixture();
    // The latest child of the turn is page2b, so the tip is that branch's end.
    expect(branchTip(nodes, title.id).id).toBe(page2b.id);
    expect(branchTip(nodes, page2.id).id).toBe(page2.id);
  });

  it('returns the root itself for a leaf', () => {
    const { nodes, seed } = fixture();
    const freshTitle = makeTitleNode(seed.id, { title: 'Dormant', tagline: '' });
    const withFresh = { ...nodes, [freshTitle.id]: freshTitle };
    expect(branchTip(withFresh, freshTitle.id).id).toBe(freshTitle.id);
  });
});
