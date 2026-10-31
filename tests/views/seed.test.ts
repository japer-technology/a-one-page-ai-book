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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSeed, resetSeedSession } from '../../src/ui/views/seed';
import { defaultLibrary } from '../../src/core/schema';
import type { StoryNode } from '../../src/core/types';
import { chat } from '../../src/llm/client';
import { withLLMRetry } from '../../src/llm/retry';
import { click, findButton, mountView, settle, StubApp, type } from '../helpers/view-harness';

const bubbles = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('.chat-text')].map((node) => node.textContent ?? '');

beforeEach(() => {
  resetSeedSession();
  window.confirm = () => true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lucky seed generation', () => {
  it('uses built-in ideas without a model and does not repeat before exhausting them', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const app = new StubApp(defaultLibrary(), null, 'seed');
    const root = mountView(app, renderSeed);
    const ideas = new Set<string>();
    for (let i = 0; i < 12; i++) {
      click(findButton(root, 'lucky'));
      ideas.add(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value ?? '');
    }
    expect(ideas.size).toBe(12);
    expect(ideas.has('')).toBe(false);
    expect(app.calls.some(([name]) => name === 'generateText')).toBe(false);
    expect(app.toasts[0]?.message).toContain('built-in idea');
    vi.restoreAllMocks();
  });

  it('offers model seeds and walks the batch without another request', async () => {
    const app = new StubApp(defaultLibrary(), null, 'seed');
    app.lib.settings.endpoint.model = 'test-model';
    const ideas = [
      'A lighthouse starts walking inland.',
      'A baker discovers a door inside a loaf.',
    ];
    app.genTextReply = JSON.stringify(ideas);
    const root = mountView(app, renderSeed);

    click(findButton(root, 'lucky'));
    await settle();
    expect(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value).toBe(ideas[0]);
    click(findButton(root, 'lucky'));
    expect(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value).toBe(ideas[1]);
    expect(app.calls.filter(([name]) => name === 'generateText')).toHaveLength(1);
  });

  it('uses a configured fast model even without a prose model', async () => {
    const app = new StubApp(defaultLibrary(), null, 'seed');
    app.lib.settings.endpoint.model = '';
    app.lib.settings.fastModel = 'fast-model';
    app.genTextReply = '["A baker discovers a door inside a loaf."]';
    const generate = vi.spyOn(app, 'generateText');
    const root = mountView(app, renderSeed);

    click(findButton(root, 'lucky'));
    await settle();

    expect(generate).toHaveBeenCalledWith(expect.any(Array), {
      model: 'fast-model',
      quiet: true,
    });
    expect(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value).toBe(
      'A baker discovers a door inside a loaf.',
    );
  });

  it('discards cached seeds when the starting notes change', async () => {
    const app = new StubApp(defaultLibrary(), null, 'seed');
    app.lib.settings.endpoint.model = 'test-model';
    app.genTextReply =
      '["A lighthouse starts walking inland.", "A baker discovers a door inside a loaf."]';
    const root = mountView(app, renderSeed);
    click(findButton(root, 'lucky'));
    await settle();

    type(root.querySelector<HTMLInputElement>('input[list="genres"]'), 'cozy mystery');
    app.genTextReply = '["A village baker finds a stolen necklace in her flour."]';
    click(findButton(root, 'lucky'));
    await settle();

    const calls = app.calls.filter(([name]) => name === 'generateText');
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1])).toContain('genre: cozy mystery');
    expect(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value).toBe(
      'A village baker finds a stolen necklace in her flour.',
    );
  });

  it('trims seeds and drops duplicates, commentary, and broken JSON', async () => {
    const app = new StubApp(defaultLibrary(), null, 'seed');
    app.lib.settings.endpoint.model = 'test-model';
    const idea = 'A lighthouse starts walking inland.';
    app.genTextReply = JSON.stringify([
      'Here are five different story seeds:',
      'Could you tell me which genre you prefer?',
      '["A baker discovers a door inside a loaf.",',
      `  ${idea}  `,
      idea.toUpperCase(),
    ]);
    const root = mountView(app, renderSeed);
    click(findButton(root, 'lucky'));
    await settle();
    expect(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value).toBe(idea);

    app.genTextReply = JSON.stringify([idea, 'A baker discovers a door inside a loaf.']);
    click(findButton(root, 'lucky'));
    await settle();
    expect(app.calls.filter(([name]) => name === 'generateText')).toHaveLength(2);
    expect(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value).toBe(
      'A baker discovers a door inside a loaf.',
    );
  });

  it.each([false, true])('keeps edits made while a roll is pending (failure: %s)', async (fail) => {
    const app = new StubApp(defaultLibrary(), null, 'seed');
    app.lib.settings.endpoint.model = 'test-model';
    let release = (): void => {};
    app.generateText = () =>
      new Promise((resolve, reject) => {
        release = () =>
          fail
            ? reject(new Error('Model unavailable'))
            : resolve('["A lighthouse starts walking inland."]');
      });
    const root = mountView(app, renderSeed);
    click(findButton(root, 'lucky'));
    type(root.querySelector<HTMLTextAreaElement>('.seed-input'), 'My own carefully typed idea.');
    release();
    await settle();

    expect(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value).toBe(
      'My own carefully typed idea.',
    );
    expect(app.toasts.at(-1)?.message).toContain('seed was kept');
    if (!fail) {
      click(findButton(root, 'lucky'));
      expect(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value).toBe(
        'A lighthouse starts walking inland.',
      );
    }
  });

  it('discards a reply requested for starting notes that have changed', async () => {
    const app = new StubApp(defaultLibrary(), null, 'seed');
    app.lib.settings.endpoint.model = 'test-model';
    let release = (): void => {};
    app.generateText = () =>
      new Promise((resolve) => {
        release = () => resolve('["A lighthouse starts walking inland."]');
      });
    const root = mountView(app, renderSeed);
    click(findButton(root, 'lucky'));
    type(root.querySelector<HTMLInputElement>('input[list="genres"]'), 'cozy mystery');
    release();
    await settle();

    expect(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value).toBe('');
    expect(app.toasts.at(-1)?.message).toContain('starting notes changed');
    expect(findButton(root, 'lucky')?.hasAttribute('disabled')).toBe(false);
  });

  it('allows a new roll after reset without an old request unlocking or overwriting it', async () => {
    const app = new StubApp(defaultLibrary(), null, 'seed');
    app.lib.settings.endpoint.model = 'test-model';
    const releases: Array<(text: string) => void> = [];
    app.generateText = () =>
      new Promise((resolve) => {
        releases.push(resolve);
      });
    const root = mountView(app, renderSeed);
    click(findButton(root, 'lucky'));
    resetSeedSession();
    app.refresh();
    expect(findButton(root, 'lucky')?.hasAttribute('disabled')).toBe(false);
    click(findButton(root, 'lucky'));
    expect(releases).toHaveLength(2);

    releases[0]?.('["A stale lighthouse starts walking inland."]');
    await settle();
    expect(findButton(root, 'Asking the model')?.hasAttribute('disabled')).toBe(true);
    expect(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value).toBe('');

    releases[1]?.('["A baker discovers a door inside a loaf."]');
    await settle();
    expect(findButton(root, 'lucky')?.hasAttribute('disabled')).toBe(false);
    expect(root.querySelector<HTMLTextAreaElement>('.seed-input')?.value).toBe(
      'A baker discovers a door inside a loaf.',
    );
  });

  it('explains reasoning-only output, offers a fallback, and releases the button', async () => {
    const app = new StubApp(defaultLibrary(), null, 'seed');
    const endpoint = app.lib.settings.endpoint;
    endpoint.model = 'google/gemma-4-26b-a4b-qat';
    endpoint.vendor = 'openai-compat';
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: '', reasoning_content: 'Still thinking about seeds.' },
                finish_reason: 'length',
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    app.generateText = () => withLLMRetry(() => chat({ endpoint, model: endpoint.model }, []));
    const root = mountView(app, renderSeed);

    click(findButton(root, 'lucky'));
    await settle();
    await settle();

    const seed = root.querySelector<HTMLTextAreaElement>('.seed-input')?.value ?? '';
    expect(seed.length).toBeGreaterThan(12);
    expect(seed).not.toContain('Still thinking');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(app.toasts.some(({ message }) => /reasoning but no final answer/.test(message))).toBe(
      true,
    );
    expect(root.querySelector<HTMLButtonElement>('.btn-ghost')?.disabled).toBe(false);
    expect(findButton(root, 'lucky')).toBeDefined();
  });
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
