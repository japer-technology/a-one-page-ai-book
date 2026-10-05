// @vitest-environment happy-dom
/**
 * tests/views/archive.test.ts — the story map, against the real view module.
 *
 * Locks down three reader-visible promises:
 *  1. a branch the reader grew by re-entering a title (title → turn → page)
 *     IS listed as a road not taken from the branch's first page, and clicking
 *     it re-enters that branch;
 *  2. a finished branch re-enters at its last PAGE — never at the ending
 *     (which used to un-finish the book and bounce the reader to the Library);
 *  3. "🏁 The frontier" is not a dead click when the frontier is a prologue
 *     (openPageAt ignores non-pages; the repair path lives in openBook).
 */
import { describe, expect, it } from 'vitest';
import { renderArchive } from '../../src/ui/views/archive';
import {
  makeBook,
  makeEndingNode,
  makePageNode,
  makePrologueNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
  setFrontier,
} from '../../src/core/tree';
import { defaultLibrary, emptySeedOptions } from '../../src/core/schema';
import { DEFAULT_TURN } from '../../src/core/types';
import type { Book, Library, StoryNode } from '../../src/core/types';
import { all, click, findButton, mountView, StubApp } from '../helpers/view-harness';

function libOf(nodes: StoryNode[], books: Book[]): Library {
  return {
    schemaVersion: 1,
    books,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    settings: defaultLibrary().settings,
    meta: { updatedAt: 1 },
  };
}

/** The seed's proposed titles drive the map's title cards (and their Enter doors). */
function withTitles(seed: StoryNode, titles: string[]): StoryNode {
  if (seed.data.kind === 'seed') {
    seed.data.titles = titles.map((title) => ({ title, tagline: '' }));
  }
  return seed;
}

describe('the story map', () => {
  it('lists a title-level fork as a road not taken and re-enters it on click', () => {
    const seed = makeSeedNode('s', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
    const turn1 = makeTurnNode(title.id, DEFAULT_TURN);
    const page1 = makePageNode(turn1.id, DEFAULT_TURN, 'm', 'One.');
    const turn2 = makeTurnNode(page1.id, DEFAULT_TURN);
    const page2 = makePageNode(turn2.id, DEFAULT_TURN, 'm', 'Two.');
    // The shape the app's own re-enter flow mints: title → turn → page.
    const turnX = makeTurnNode(title.id, { ...DEFAULT_TURN, direction: 'a different beginning' });
    const pageX = makePageNode(turnX.id, DEFAULT_TURN, 'm', 'Alternative first page.');
    const book = setFrontier(makeBook(seed.id, title.id, 'm'), page2.id);
    const app = new StubApp(
      libOf([seed, title, turn1, page1, turn2, page2, turnX, pageX], [book]),
      book,
    );
    const root = mountView(app, renderArchive);

    const chips = all(root, '.archive-branch');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toContain('Alternative first page.');
    expect(all(root, '.tree-ghost').length).toBeGreaterThanOrEqual(1);

    click(chips[0]);
    expect(app.state.book?.frontierId).toBe(pageX.id);
    expect(app.calls.some((call) => call[0] === 'navigate' && call[1] === 'page')).toBe(true);
  });

  it('never re-enters a finished branch at its ending, and counts its pages', () => {
    const seed = withTitles(makeSeedNode('s', emptySeedOptions()), [
      'The Dead Letter',
      'Salt & Secrets',
    ]);
    const titleA = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
    const titleB = makeTitleNode(seed.id, { title: 'Salt & Secrets', tagline: '' });
    const turn1 = makeTurnNode(titleA.id, DEFAULT_TURN);
    const page1 = makePageNode(turn1.id, DEFAULT_TURN, 'm', 'One.');
    const ending = makeEndingNode(page1.id, 'A quiet close.');
    // The End screen attaches the prologue to the TITLE, after the pages.
    const prologue = makePrologueNode(titleA.id, DEFAULT_TURN, 'm', 'A prologue.');
    // A different title is the chosen one, so A's card carries the page count.
    const book = setFrontier(makeBook(seed.id, titleB.id, 'm'), titleB.id);
    const app = new StubApp(
      libOf([seed, titleA, titleB, turn1, page1, ending, prologue], [book]),
      book,
    );
    const root = mountView(app, renderArchive);

    // The walk-back counts the real pages: the prologue tip used to read as
    // "not started yet" on a fully written branch.
    const cardFor = (titleText: string): string => {
      const card = all(root, '.title-card').find((c) => c.textContent.includes(titleText));
      return card?.querySelector('.book-meta')?.textContent ?? '';
    };
    expect(cardFor('The Dead Letter')).toContain('1 page written');

    // The title door ("Enter") re-enters the branch; openBranch (main.ts)
    // walks the tip back to the last page — never to the ending.
    const card = all(root, '.title-card').find((c) => c.textContent.includes('The Dead Letter'));
    const enter = all(card ?? root, 'button').find((b) => b.textContent.trim() === 'Enter');
    click(enter);
    const branchCall = app.calls.find((call) => call[0] === 'openBranch');
    expect(branchCall).toBeTruthy();
    expect((branchCall?.[2] as { title?: string } | undefined)?.title).toBe('The Dead Letter');
  });

  it('does not leave the frontier button dead when the frontier is a prologue', () => {
    const seed = makeSeedNode('s', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
    const turn1 = makeTurnNode(title.id, DEFAULT_TURN);
    const page1 = makePageNode(turn1.id, DEFAULT_TURN, 'm', 'One.');
    const prologue = makePrologueNode(title.id, DEFAULT_TURN, 'm', 'A prologue.');
    const book = setFrontier(makeBook(seed.id, title.id, 'm'), prologue.id);
    const app = new StubApp(libOf([seed, title, turn1, page1, prologue], [book]), book);
    const root = mountView(app, renderArchive);

    click(findButton(root, '🏁 The frontier'));
    // A prologue is not a page `openPageAt` can show: the map must route the
    // reader through openBook, which contains the frontier repair.
    expect(app.calls.some((call) => call[0] === 'openBook')).toBe(true);
    expect(app.calls.some((call) => call[0] === 'openPageAt')).toBe(false);
  });
});
