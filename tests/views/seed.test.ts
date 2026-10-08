// @vitest-environment happy-dom
/**
 * tests/views/seed.test.ts — the pre-writing chat: session races and drafts.
 *
 * Findings locked here (third deep pass): a reply or distill that settles
 * after the conversation was reset (“New conversation”, Begin) used to write
 * into the NEXT session — a phantom assistant turn, or the DISCARDED brief
 * landing in the seed box; and the chat input was the one field with no
 * draft, so any re-render silently dropped a half-typed message.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { renderSeed, resetSeedSession } from '../../src/ui/views/seed';
import { defaultLibrary } from '../../src/core/schema';
import type { StoryNode } from '../../src/core/types';
import { click, findButton, mountView, settle, StubApp, type } from '../helpers/view-harness';

const bubbles = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('.chat-text')].map((node) => node.textContent ?? '');

beforeEach(() => {
  resetSeedSession();
  window.confirm = () => true;
});

describe('the pre-writing chat session', () => {
  it('never lands a reply in the session that replaced it', async () => {
    const app = new StubApp(defaultLibrary(), null, 'seed');
    const root = mountView(app, renderSeed);
    app.newSeed = ((text: string, options: unknown, brief: string) =>
      ({
        id: 'seed-new',
        kind: 'seed',
        parentId: null,
        createdAt: 0,
        data: { kind: 'seed', text, options, brief, titles: [] },
      }) as StoryNode) as unknown as StubApp['newSeed'];

    let release = (): void => {};
    app.generateText = () =>
      new Promise((resolve) => {
        release = () => resolve('THE STALE REPLY');
      });

    type(root.querySelector<HTMLInputElement>('.chat-input'), 'a story about a lighthouse');
    click(findButton(root, 'Send'));
    await settle();

    // The reader starts the book while the partner is still thinking.
    type(root.querySelector<HTMLTextAreaElement>('.seed-input'), 'A SEED FOR THE NEW BOOK');
    click(findButton(root, 'Begin'));
    release();
    await settle();
    await settle();

    expect(bubbles(root)).not.toContain('THE STALE REPLY');
  });

  it('drops a distill that lands after “New conversation”', async () => {
    const app = new StubApp(defaultLibrary(), null, 'seed');
    const root = mountView(app, renderSeed);

    let n = 0;
    let releaseDistill = (): void => {};
    app.generateText = () => {
      n++;
      if (n === 1) return Promise.resolve('a first reply');
      return new Promise((resolve) => {
        releaseDistill = () => resolve('THE OLD BRIEF');
      });
    };

    type(root.querySelector<HTMLInputElement>('.chat-input'), 'gothic mystery');
    click(findButton(root, 'Send'));
    await settle();
    await settle();

    click(findButton(root, 'Distill'));
    await settle();
    click(findButton(root, 'New conversation'));
    await settle();

    releaseDistill();
    await settle();
    await settle();

    // The discarded conversation must not come back as a surviving brief…
    expect(root.querySelector('.brief-input')).toBeNull();
    // …nor as text in the seed box steering the next book.
    expect((root.querySelector('.seed-input') as HTMLTextAreaElement).value).not.toBe(
      'THE OLD BRIEF',
    );
  });

  it('keeps a half-typed chat message across a re-render', async () => {
    const app = new StubApp(defaultLibrary(), null, 'seed');
    const root = mountView(app, renderSeed);

    type(
      root.querySelector<HTMLInputElement>('.chat-input'),
      'I want a quiet gothic mystery with—',
    );
    app.refresh();
    await settle();
    expect((root.querySelector('.chat-input') as HTMLInputElement).value).toBe(
      'I want a quiet gothic mystery with—',
    );
  });

  it('does not land a lucky roll in the session that replaced it', async () => {
    // The dice batch belongs to the session that asked for it: a roll settling
    // after a reset must not repopulate the pool or the seed box. Abort-on-
    // navigate usually wins that race; this makes the invariant independent of
    // it. (Follow-up review pass.)
    const app = new StubApp(defaultLibrary(), null, 'seed');
    app.lib.settings.endpoint.model = 'test-model';
    const root = mountView(app, renderSeed);

    let release = (): void => {};
    let calls = 0;
    app.generateText = () => {
      calls++;
      return new Promise((resolve) => {
        release = () => resolve('["A stale idea","Another stale idea"]');
      });
    };

    click(findButton(root, 'lucky'));
    await settle();

    // The reader resets the session (Begin / New conversation) mid-roll.
    resetSeedSession();
    release();
    await settle();
    await settle();

    // The leaked batch must not fill the box…
    expect((root.querySelector('.seed-input') as HTMLTextAreaElement).value).toBe('');
    // …nor the pool: a second click asks the model anew instead of walking the
    // stale batch for free.
    click(findButton(root, 'lucky'));
    await settle();
    expect(calls).toBe(2);
    release();
    await settle();
  });
});
