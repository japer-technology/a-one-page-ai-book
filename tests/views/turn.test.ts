// @vitest-environment happy-dom
/**
 * tests/views/turn.test.ts — the turn console's conflict checker.
 *
 * Regression this locks down: a fix once cleared the whole `.conflict-area`
 * when the reader typed, which deleted the "Check this direction" button
 * itself (the area's last child) — and typing does not re-render, so the check
 * was unreachable for the rest of the visit. The verdict must go; the button
 * must stay.
 */
import { describe, expect, it } from 'vitest';
import { renderTurn } from '../../src/ui/views/turn';
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
import { click, findButton, mountView, settle, StubApp, type } from '../helpers/view-harness';

function libOf(nodes: StoryNode[], books: Book[]): Library {
  const settings = defaultLibrary().settings;
  return {
    schemaVersion: 1,
    books,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    settings: {
      ...settings,
      autoSuggest: false,
      endpoint: { ...settings.endpoint, model: 'm' },
    },
    meta: { updatedAt: 1 },
  };
}

function fixture(): { app: StubApp; root: HTMLElement } {
  const seed = makeSeedNode('s', emptySeedOptions());
  const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
  const turn1 = makeTurnNode(title.id, DEFAULT_TURN);
  const page = makePageNode(turn1.id, DEFAULT_TURN, 'm', 'The letter waited.');
  const waiting = makeTurnNode(page.id, DEFAULT_TURN); // the frontier: the next turn
  const book = setFrontier(makeBook(seed.id, title.id, 'm'), waiting.id);
  const app = new StubApp(libOf([seed, title, turn1, page, waiting], [book]), book, 'turn');
  app.state.params = { from: page.id };
  const root = mountView(app, renderTurn);
  return { app, root };
}

const directionBox = (root: HTMLElement): HTMLTextAreaElement =>
  root.querySelector('.direction-input') as HTMLTextAreaElement;

describe('the turn console conflict checker', () => {
  it('keeps the Check button while typing', () => {
    const { root } = fixture();
    expect(findButton(root, 'Check this direction')).toBeTruthy();
    type(directionBox(root), 'OPEN THE DOOR');
    expect(findButton(root, 'Check this direction')).toBeTruthy();
  });

  it('clears a stale verdict when the direction changes, and keeps the button', async () => {
    const { app, root } = fixture();
    app.genJsonReply =
      '["The gun was destroyed in chapter 2 — using it now is inconsistent with that."]';
    type(directionBox(root), 'OPEN THE DOOR');
    click(findButton(root, 'Check this direction'));
    await settle();
    await settle();
    expect(root.textContent).toContain('conflicts with the story');

    // The reader edits the direction: the verdict is stale and must go…
    type(directionBox(root), 'OPEN THE DOOR AND RUN');
    expect(root.querySelector('.conflict-list')).toBeNull();
    expect(root.textContent).not.toContain('conflicts with the story');
    // …while the control that produces the next verdict stays reachable.
    expect(findButton(root, 'Check this direction')).toBeTruthy();
  });
});
