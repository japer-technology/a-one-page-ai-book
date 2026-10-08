// @vitest-environment happy-dom
/**
 * tests/views/page.test.ts — the paragraph crafting tools dispatch, against
 * the real view module.
 *
 * The "＋ Insert a paragraph after this one" tool must ask the model for a NEW
 * paragraph and commit it AFTER the anchor (compile.ts `applyParagraphEdit`,
 * 'insert') — it used to be served by the REWRITE path (the old code branched
 * on `index >= paras.length` alone), so the model rewrote the paragraph the
 * reader pointed at and their prose changed instead of growing. The core
 * commit logic is unit-tested in src/core/compile.ts; this locks the VIEW's
 * dispatch of the request.
 */
import { describe, expect, it } from 'vitest';
import { renderPage } from '../../src/ui/views/page';
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
import { all, click, findButton, mountView, settle, StubApp } from '../helpers/view-harness';

const PAGE_TEXT = 'Para one.\n\nPara two.';

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

function fixture(): { app: StubApp; root: HTMLElement; pageId: string } {
  const seed = makeSeedNode('s', emptySeedOptions());
  const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
  const turn = makeTurnNode(title.id, DEFAULT_TURN);
  const page = makePageNode(turn.id, DEFAULT_TURN, 'm', PAGE_TEXT);
  const book = setFrontier(makeBook(seed.id, title.id, 'm'), page.id);
  const app = new StubApp(libOf([seed, title, turn, page], [book]), book, 'page');
  const root = mountView(app, renderPage);
  return { app, root, pageId: page.id };
}

/** The paragraph crafting tool with this label on the block at `index`. */
function tool(root: HTMLElement, index: number, label: string): HTMLElement {
  const para = all(root, '.para')[index];
  if (!para) throw new Error(`paragraph block ${index} missing`);
  const button = all(para, '.para-tools button').find((b) => b.textContent.trim() === label);
  if (!button) throw new Error(`paragraph tool ${label} missing`);
  return button;
}

/** The model button of the open paragraph panel. */
function aiButton(root: HTMLElement): HTMLElement {
  const button = all(root, '.para-panel button').find((b) => b.textContent.includes('with AI'));
  if (!button) throw new Error('AI paragraph panel button missing');
  return button;
}

describe('the paragraph crafting tools', () => {
  it('inserts a model paragraph AFTER the anchor instead of rewriting it', async () => {
    const { app, root, pageId } = fixture();
    app.genTextReply = 'The new paragraph.';

    click(tool(root, 0, '＋'));
    expect(root.querySelector('.para-panel')).toBeTruthy();
    click(aiButton(root));
    await settle();
    await settle();

    const commit = app.calls.find((call) => call[0] === 'appendVersion');
    expect(commit?.[1]).toBe(pageId);
    // The insert lands between the two existing paragraphs, leaving the
    // anchor intact…
    expect(commit?.[2]).toBe('Para one.\n\nThe new paragraph.\n\nPara two.');
    // …never in place of it (the pre-fix rewrite result).
    expect(commit?.[2]).not.toBe('The new paragraph.\n\nPara two.');
  });

  it('still rewrites in place when the ↻ tool was clicked', async () => {
    const { app, root, pageId } = fixture();
    app.genTextReply = 'Rewritten first.';

    click(tool(root, 0, '↻'));
    // Rewrite mode is labelled as such — not as writing a new paragraph.
    expect(root.textContent).toContain('Rewrite with AI');
    click(aiButton(root));
    await settle();
    await settle();

    const commit = app.calls.find((call) => call[0] === 'appendVersion');
    expect(commit?.[1]).toBe(pageId);
    expect(commit?.[2]).toBe('Rewritten first.\n\nPara two.');
  });
});

describe('a failed rewrite', () => {
  it('stays with its page and never hides other pages', async () => {
    const seed = makeSeedNode('s', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
    const turn1 = makeTurnNode(title.id, DEFAULT_TURN);
    const page1 = makePageNode(turn1.id, DEFAULT_TURN, 'm', 'PAGE ONE TEXT.');
    const turn2 = makeTurnNode(page1.id, DEFAULT_TURN);
    const page2 = makePageNode(turn2.id, DEFAULT_TURN, 'm', 'PAGE TWO TEXT.');
    const book = setFrontier(makeBook(seed.id, title.id, 'm'), page2.id);
    const app = new StubApp(libOf([seed, title, turn1, page1, turn2, page2], [book]), book, 'page');
    const root = mountView(app, renderPage);

    app.generateText = async () => {
      throw new Error('LLM returned an empty page');
    };
    click(findButton(root, 'Regenerate'));
    await settle();
    await settle();
    // Page 2's own panel shows the failure…
    expect(root.textContent).toContain('LLM returned an empty page');
    expect(findButton(root, 'Retry')).toBeTruthy();

    // …but walking to page 1 must reveal page 1: text and crafting tools.
    // The old book-scoped key hid EVERY page behind the stale error panel.
    app.openPageAt(app.book as Book, page1.id);
    await settle();
    expect(root.textContent).toContain('PAGE ONE TEXT.');
    expect(root.textContent).not.toContain('LLM returned an empty page');

    // Returning to page 2 brings its panel back, and its Retry rewrites
    // PAGE 2 — it used to rewrite whichever page was on screen.
    app.openPageAt(app.book as Book, page2.id);
    await settle();
    expect(root.textContent).toContain('LLM returned an empty page');
    app.generateText = async () => 'REWRITTEN TWO.';
    click(findButton(root, 'Retry'));
    await settle();
    await settle();
    const commit = app.calls.find((call) => call[0] === 'appendVersion');
    expect(commit?.[1]).toBe(page2.id);
  });
});
