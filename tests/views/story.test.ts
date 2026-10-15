// @vitest-environment happy-dom
/**
 * tests/views/story.test.ts — the rolling-summary updater's queue discipline.
 *
 * A page that is kept while another update is in flight is skipped by the
 * busy-guard and remembered as "pending"; the update must run it eventually.
 * The failure path used to drop it silently, so the memory lagged one page
 * behind until the reader clicked Retry.
 */
import { describe, expect, it } from 'vitest';
import { maybeUpdateSummary, renderStoryMemory } from '../../src/ui/story';
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
import { api, click, findButton, mountView, settle, StubApp } from '../helpers/view-harness';

function libOf(nodes: StoryNode[], books: Book[]): Library {
  const settings = defaultLibrary().settings;
  return {
    schemaVersion: 1,
    books,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    settings: {
      ...settings,
      endpoint: { ...settings.endpoint, model: 'm' },
      // The summary updater defers to the cast updater while autoBible is on;
      // this test drives it directly.
      autoBible: false,
    },
    meta: { updatedAt: 1 },
  };
}

describe('the rolling-summary updater', () => {
  it('re-runs the page queued behind a failed memory update', async () => {
    const seed = makeSeedNode('s', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
    const turn = makeTurnNode(title.id, DEFAULT_TURN);
    const page1 = makePageNode(turn.id, DEFAULT_TURN, 'm', 'Page one.');
    const turn2 = makeTurnNode(page1.id, DEFAULT_TURN);
    const page2 = makePageNode(turn2.id, DEFAULT_TURN, 'm', 'Page two.');
    const book = setFrontier(makeBook(seed.id, title.id, 'm'), page2.id);
    const app = new StubApp(libOf([seed, title, turn, page1, turn2, page2], [book]), book, 'page');
    const root = mountView(app, (a) => renderStoryMemory(a, book));

    let calls = 0;
    let failFirst!: (err: Error) => void;
    app.generateText = (() => {
      calls++;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          failFirst = reject;
        });
      }
      return Promise.resolve('The story so far.');
    }) as typeof app.generateText;

    click(findButton(root, '↻ Update')); // held — page 2's memory update
    maybeUpdateSummary(api(app), book, page1.id); // queued while it runs
    failFirst(new Error('server busy'));
    for (let i = 0; i < 10 && calls < 2; i++) await settle();

    expect(calls).toBe(2);
    expect(app.calls.some((call) => call[0] === 'saveSummary' && call[1] === page1.id)).toBe(true);
  });
});
