// @vitest-environment happy-dom
/**
 * tests/views/reader.test.ts — the reading room's page turns, against the real
 * view module.
 *
 * The fix: pressing → turns the page (stops any read-aloud and scrolls the new
 * page to the top, exactly like the on-screen arrows do). This locks the
 * keyboard path down: position advanced, `setReadingPosition` called,
 * `window.scrollTo({top: 0})` issued — and no scroll churn when a press cannot
 * turn the page.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderReader } from '../../src/ui/views/reader';
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
import { mountView, StubApp } from '../helpers/view-harness';

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

function fixture(pageCount = 2): { app: StubApp; root: HTMLElement; book: Book } {
  const seed = makeSeedNode('A letter waits on the desk.', emptySeedOptions());
  const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
  const nodes: StoryNode[] = [seed, title];
  let parent = title.id;
  for (let i = 1; i <= pageCount; i++) {
    const turn = makeTurnNode(parent, DEFAULT_TURN);
    const page = makePageNode(turn.id, DEFAULT_TURN, 'm', `Paragraph of page ${i}.`);
    nodes.push(turn, page);
    parent = page.id;
  }
  const book = setFrontier(makeBook(seed.id, title.id, 'm'), parent);
  const app = new StubApp(libOf(nodes, [book]), book, 'reader');
  app.state.params = { book: book.id };
  const root = mountView(app, renderReader);
  return { app, root, book };
}

const positions = (app: StubApp): Array<[unknown, unknown]> =>
  app.calls.filter((call) => call[0] === 'setReadingPosition').map((call) => [call[1], call[2]]);

const press = (key: 'ArrowLeft' | 'ArrowRight'): void => {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key }));
};

describe('the reading room page turns', () => {
  it('ArrowRight advances the reading position and starts the page at the top', () => {
    const { app, root, book } = fixture();
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    press('ArrowRight');

    expect(positions(app)).toEqual([[book.id, 1]]);
    // A fresh page starts at the top — never mid-scroll from the last one.
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });

    app.refresh();
    expect(root.textContent).toContain('Page 1 of 2');
    scrollTo.mockRestore();
  });

  it('does not scroll when a key press cannot turn the page', () => {
    const { app, book } = fixture();
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    // On the title page, ← has nowhere to go.
    press('ArrowLeft');
    expect(scrollTo).not.toHaveBeenCalled();

    // Walk to the last page. The real shell re-renders when the position is
    // saved (`setReadingPosition` → `update`), so refresh between presses —
    // that render is what hands the key handler its new position.
    press('ArrowRight');
    app.refresh();
    press('ArrowRight');
    app.refresh();
    expect(positions(app)).toEqual([
      [book.id, 1],
      [book.id, 2],
    ]);

    // …then → again is a no-op: no extra position write, no scroll.
    scrollTo.mockClear();
    press('ArrowRight');
    expect(positions(app)).toHaveLength(2);
    expect(scrollTo).not.toHaveBeenCalled();
    scrollTo.mockRestore();
  });
});
