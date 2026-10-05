// @vitest-environment happy-dom
/**
 * tests/views/about.test.ts — the "About this book" decision log, against the
 * real view module.
 *
 * The log names the page each turn produced. The pending turn at the frontier
 * has produced nothing yet, so it must read as the page it is ABOUT to make
 * ("→ page 3 (upcoming)") — never as the page the PREVIOUS turn made. The old
 * fallback (the count of pages already written) named exactly that page, and a
 * pending turn under the title read "→ page 0".
 */
import { describe, expect, it } from 'vitest';
import { renderAbout } from '../../src/ui/views/about';
import {
  makeBook,
  makePageNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
  setFrontier,
} from '../../src/core/tree';
import { defaultLibrary, emptySeedOptions } from '../../src/core/schema';
import { DEFAULT_TURN } from '../../src/core/types';
import type { Book, Library, StoryNode } from '../../src/core/types';
import { mountView, StubApp, texts } from '../helpers/view-harness';

function libOf(nodes: StoryNode[], books: Book[]): Library {
  const settings = defaultLibrary().settings;
  return {
    schemaVersion: 1,
    books,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    settings: { ...settings, endpoint: { ...settings.endpoint, model: 'm' } },
    meta: { updatedAt: 1 },
  };
}

/** About reads `params.book` (it can be opened for a book that is not open). */
function mountAbout(nodes: StoryNode[], book: Book): HTMLElement {
  const app = new StubApp(libOf(nodes, [book]), book, 'about');
  app.state.params = { book: book.id };
  return mountView(app, renderAbout);
}

describe('the About decision log', () => {
  it('names the page each turn produced, and marks the pending turn as upcoming', () => {
    const seed = makeSeedNode('s', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
    const turn1 = makeTurnNode(title.id, DEFAULT_TURN);
    const page1 = makePageNode(turn1.id, DEFAULT_TURN, 'm', 'One.');
    const turn2 = makeTurnNode(page1.id, DEFAULT_TURN);
    const page2 = makePageNode(turn2.id, DEFAULT_TURN, 'm', 'Two.');
    // The frontier: a turn the reader has directed, with no page written yet.
    const pending = makeTurnNode(page2.id, { ...DEFAULT_TURN, direction: 'open the door' });
    const book = setFrontier(makeBook(seed.id, title.id, 'm'), pending.id);
    const root = mountAbout([seed, title, turn1, page1, turn2, page2, pending], book);

    // Written turns point at their own page; the pending turn at the page it
    // is about to make. The pre-fix fallback (pages already written = 2) made
    // the pending entry claim "→ page 2" — the page turn2 had made.
    expect(texts(root, '.about-decision-page')).toEqual([
      '→ page 1',
      '→ page 2',
      '→ page 3 (upcoming)',
    ]);
  });

  it('marks a turn waiting directly under the title as upcoming page 1', () => {
    const seed = makeSeedNode('s', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'Salt & Secrets', tagline: '' });
    const pending = makeTurnNode(title.id, DEFAULT_TURN);
    const book = setFrontier(makeBook(seed.id, title.id, 'm'), pending.id);
    const root = mountAbout([seed, title, pending], book);

    // No pages written at all: the old fallback read "→ page 0".
    expect(texts(root, '.about-decision-page')).toEqual(['→ page 1 (upcoming)']);
  });
});
