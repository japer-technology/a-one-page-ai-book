// @vitest-environment happy-dom
/**
 * tests/views/cast.test.ts — the cast panel's own behaviours, run against the
 * real view module.
 *
 * Two reader-visible promises this locks down:
 *  1. saving a person CLOSES the form (it used to stay open with the saved
 *     draft, so a second Save appended a duplicate);
 *  2. "↻ Update from the story" keeps entries the reader curated — an entry
 *     the model does not mention must survive the rewrite.
 */
import { describe, expect, it } from 'vitest';
import { renderCast } from '../../src/ui/cast';
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
import { all, click, findButton, mountView, settle, StubApp, type } from '../helpers/view-harness';

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
  const page = makePageNode(turn.id, DEFAULT_TURN, 'm', 'The letter waited on the desk.');
  const book = setFrontier(makeBook(seed.id, title.id, 'm'), page.id);
  const app = new StubApp(libOf([seed, title, turn, page], [book]), book, 'page');
  const root = mountView(app, (api) => renderCast(api, book));
  return { app, root, pageId: page.id };
}

const saveInForm = (root: HTMLElement): HTMLElement | undefined =>
  all(root, '.cast-form button').find((b) => b.textContent.trim() === 'Save');

describe('the cast panel', () => {
  it('closes the form on Save instead of inviting a duplicate', () => {
    const { app, root, pageId } = fixture();
    click(findButton(root, '＋ person'));
    expect(root.querySelector('.cast-form')).toBeTruthy();

    type(root.querySelector('.cast-form input') as HTMLInputElement, 'Hermes QA Ghost');
    click(saveInForm(root));

    expect(root.querySelector('.cast-form')).toBeNull();
    expect(root.textContent).toContain('Hermes QA Ghost');
    expect(app.calls.filter((call) => call[0] === 'saveBible')).toHaveLength(1);
    const data = app.nodes[pageId]?.data;
    const names = data?.kind === 'page' ? (data.bible?.people ?? []).map((p) => p.name) : [];
    expect(names).toEqual(['Hermes QA Ghost']);
  });

  it('keeps a reader-curated entry when the model rewrites the cast without it', async () => {
    const { app, root, pageId } = fixture();
    click(findButton(root, '＋ person'));
    type(root.querySelector('.cast-form input') as HTMLInputElement, 'Hermes QA Ghost');
    click(saveInForm(root));

    app.genJsonReply = '{"people":[{"name":"Elin Marr","note":"from the model"}]}';
    click(findButton(root, '↻ Update from the story'));
    await settle();
    await settle();

    const data = app.nodes[pageId]?.data;
    const names = data?.kind === 'page' ? (data.bible?.people ?? []).map((p) => p.name) : [];
    expect(names).toEqual(['Elin Marr', 'Hermes QA Ghost']);
    expect(root.textContent).toContain('Hermes QA Ghost');
  });
});
