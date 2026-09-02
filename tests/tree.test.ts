import { describe, expect, it } from 'vitest';
import {
  addNode,
  appendPageVersion,
  childrenOf,
  cloneSubtree,
  collectSubtree,
  finishBook,
  makeBook,
  makeEndingNode,
  makePageNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
  pageNumberAt,
  pathToRoot,
  removeSubtree,
  setChosenVersion,
  spinePages,
  statsOf,
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
