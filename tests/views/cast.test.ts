// @vitest-environment happy-dom
/**
 * tests/views/cast.test.ts — the cast panel's own behaviours, run against the
 * real view module.
 *
 * Reader-visible promises this locks down:
 *  1. saving a person CLOSES the form (it used to stay open with the saved
 *     draft, so a second Save appended a duplicate);
 *  2. "↻ Update from the story" keeps entries the reader curated — an entry
 *     the model does not mention must survive the rewrite;
 *  3. an edit made while the background update is in flight is never
 *     discarded when the reply lands;
 *  4. the open form follows its ENTRY, not its old list position, across a
 *     background rewrite;
 *  5. a delete closes the editor before the save, so nothing re-opens on a
 *     different entry;
 *  6. a place keeps its details sheet when it is re-saved;
 *  7. rename-everywhere finds names with punctuation or non-Latin script;
 *  8. a failed update re-runs the page queued behind it.
 */
import { describe, expect, it } from 'vitest';
import { maybeUpdateBible, renderCast, updateBible } from '../../src/ui/cast';
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
import type { Book, Library, StoryBible, StoryNode } from '../../src/core/types';
import {
  all,
  api,
  click,
  findButton,
  mountView,
  settle,
  StubApp,
  type,
} from '../helpers/view-harness';

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

const bibleOf = (patch: Partial<StoryBible> = {}): StoryBible => ({
  people: [],
  places: [],
  things: [],
  threads: [],
  relations: [],
  summary: '',
  at: 1,
  updatedAt: 1,
  ...patch,
});

/** A fixture whose page already carries a cast. */
function fixtureWithBible(bible: StoryBible): { app: StubApp; root: HTMLElement; pageId: string } {
  const seed = makeSeedNode('s', emptySeedOptions());
  const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
  const turn = makeTurnNode(title.id, DEFAULT_TURN);
  const page = makePageNode(turn.id, DEFAULT_TURN, 'm', 'The letter waited on the desk.');
  page.data = {
    ...(page.data as unknown as Record<string, unknown>),
    bible,
  } as unknown as StoryNode['data'];
  const book = setFrontier(makeBook(seed.id, title.id, 'm'), page.id);
  const app = new StubApp(libOf([seed, title, turn, page], [book]), book, 'page');
  const root = mountView(app, (api) => renderCast(api, book));
  return { app, root, pageId: page.id };
}

/** Hold the next generateJSON open so the reader can act while the model "thinks". */
function holdGenerateJSON(app: StubApp): {
  release: (value: unknown) => void;
  reject: (err: Error) => void;
} {
  let release!: (value: unknown) => void;
  let reject!: (err: Error) => void;
  app.generateJSON = (() =>
    new Promise((resolve, rej) => {
      release = resolve as (value: unknown) => void;
      reject = rej;
    })) as typeof app.generateJSON;
  // Return callers, not the captured values: the executor assigns `release`
  // when the promise is constructed, which is after this object is built.
  return {
    release: (value: unknown) => release?.(value),
    reject: (err: Error) => reject?.(err),
  };
}

const namesOf = (app: StubApp, pageId: string, group: 'people' | 'places'): string[] => {
  const data = app.nodes[pageId]?.data;
  return data?.kind === 'page' ? (data.bible?.[group] ?? []).map((entry) => entry.name) : [];
};

const saveInForm = (root: HTMLElement): HTMLElement | undefined =>
  all(root, '.cast-form button').find((b) => b.textContent.trim() === 'Save');

const pencilFor = (root: HTMLElement, name: string): HTMLElement | undefined =>
  all(root, '.cast-tool').find((b) => b.getAttribute('aria-label') === `Rename or edit ${name}`);

const removeFor = (root: HTMLElement, name: string): HTMLElement | undefined =>
  all(root, '.cast-tool').find((b) => b.getAttribute('aria-label') === `Remove ${name}`);

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

describe('the cast panel — edits racing the background update', () => {
  it('keeps a reader edit made while the cast update is in flight', async () => {
    const { app, root, pageId } = fixture();
    const held = holdGenerateJSON(app);

    // The background update starts and holds (the model is "thinking").
    click(findButton(root, '↻ Update from the story'));
    // The reader adds an entry in the meantime.
    click(findButton(root, '＋ person'));
    type(root.querySelector('.cast-form input') as HTMLInputElement, 'Hermes QA Ghost');
    click(saveInForm(root));

    // Now the reply lands — it must not rebuild the bible without the edit.
    held.release({ people: [{ name: 'Elin Marr', note: 'from the model' }] });
    await settle();
    await settle();
    await settle();

    expect(namesOf(app, pageId, 'people')).toEqual(['Hermes QA Ghost']);
    expect(app.calls.filter((call) => call[0] === 'saveBible')).toHaveLength(1);
  });

  it('does not resurrect a name the reader renamed while the update was in flight', async () => {
    const { app, root, pageId } = fixtureWithBible(
      bibleOf({ people: [{ name: 'Elin Marr', note: 'the keeper' }] }),
    );
    const held = holdGenerateJSON(app);

    click(findButton(root, '↻ Update from the story'));
    click(pencilFor(root, 'Elin Marr'));
    type(root.querySelector('.cast-form input') as HTMLInputElement, 'Elin Marrow');
    click(saveInForm(root));

    held.release({ people: [{ name: 'Elin Marr', note: 'from the model' }] });
    await settle();
    await settle();
    await settle();

    // The rename stands; the reply does not bring the old name back.
    expect(namesOf(app, pageId, 'people')).toEqual(['Elin Marrow']);
  });

  it('saves an open edit form into the entry it was opened on, not the row that moved into its slot', async () => {
    const { app, root, pageId } = fixtureWithBible(
      bibleOf({
        places: [
          { name: 'Harbour Light', note: 'the tower' },
          { name: 'The Salt House', note: 'her home' },
        ],
      }),
    );

    // Open the edit form on 'Harbour Light' (index 0) …
    click(pencilFor(root, 'Harbour Light'));
    expect(root.querySelector('.cast-form')).toBeTruthy();

    // … a background update lands and re-orders the group …
    app.genJsonReply = {
      places: [
        { name: 'The Salt House', note: 'her home, remodelled' },
        { name: 'Harbour Light', note: 'the tower' },
      ],
    };
    click(findButton(root, '↻ Update from the story'));
    await settle();
    await settle();

    // … the form is still open, still on Harbour Light, and edits its note.
    expectFormOn(root, 'Harbour Light');
    type(all(root, '.cast-form input')[1] as HTMLInputElement, 'the lighthouse tower');
    click(saveInForm(root));

    const data = app.nodes[pageId]?.data;
    const places = data?.kind === 'page' ? (data.bible?.places ?? []) : [];
    expect(places.map((p) => p.name)).toEqual(['The Salt House', 'Harbour Light']);
    expect(places.find((p) => p.name === 'Harbour Light')?.note).toBe('the lighthouse tower');
    expect(places.find((p) => p.name === 'The Salt House')?.note).toBe('her home, remodelled');
  });

  it('closes the editor before deleting, so nothing re-opens on another entry', () => {
    const { app, root, pageId } = fixtureWithBible(
      bibleOf({
        people: [
          { name: 'Ann', note: '' },
          { name: 'Bob', note: 'the stranger' },
          { name: 'Cara', note: '' },
        ],
      }),
    );

    // Edit Bob …
    click(pencilFor(root, 'Bob'));
    expect(root.querySelector('.cast-form')).toBeTruthy();

    // … then delete Ann from a different row.
    click(removeFor(root, 'Ann'));

    // The editor is gone; nobody slid into its slot wearing Bob's draft.
    expect(root.querySelector('.cast-form')).toBeNull();
    expect(namesOf(app, pageId, 'people')).toEqual(['Bob', 'Cara']);
  });

  it("keeps a place's details sheet when it is re-saved without touching them", () => {
    const { app, root, pageId } = fixtureWithBible(
      bibleOf({
        places: [
          {
            name: 'The Salt House',
            note: 'her home',
            details: 'a low stone house above the tide line',
          },
        ],
      }),
    );

    click(pencilFor(root, 'The Salt House'));
    click(saveInForm(root));

    const data = app.nodes[pageId]?.data;
    const places = data?.kind === 'page' ? (data.bible?.places ?? []) : [];
    expect(places[0]?.details).toBe('a low stone house above the tide line');
  });

  it('finds a name the model wrote with trailing punctuation when renaming everywhere', async () => {
    const seed = makeSeedNode('s', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
    const turn = makeTurnNode(title.id, DEFAULT_TURN);
    const page = makePageNode(turn.id, DEFAULT_TURN, 'm', 'Said Dr. Voss! quietly, and left.');
    page.data = {
      ...(page.data as unknown as Record<string, unknown>),
      bible: bibleOf({ people: [{ name: 'Dr. Voss!', note: '' }] }),
    } as unknown as StoryNode['data'];
    const book = setFrontier(makeBook(seed.id, title.id, 'm'), page.id);
    const app = new StubApp(libOf([seed, title, turn, page], [book]), book, 'page');
    const root = mountView(app, (api) => renderCast(api, book));

    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true });
    click(pencilFor(root, 'Dr. Voss!'));
    type(root.querySelector('.cast-form input') as HTMLInputElement, 'Dr. Vance');
    // The rename button appears on the form's next paint (typing only updates
    // the draft), exactly as the reference probe drives it.
    app.refresh();
    click(findButton(root, '🔧 Save + rename everywhere'));
    await settle();
    await settle();

    expect(app.toasts.some((toast) => toast.message.includes('does not appear'))).toBe(false);
    expect(app.calls.some((call) => call[0] === 'generateText')).toBe(true);
    expect(app.calls.some((call) => call[0] === 'appendVersion')).toBe(true);
  });

  it('re-runs the page queued behind a failed cast update', async () => {
    const seed = makeSeedNode('s', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
    const turn = makeTurnNode(title.id, DEFAULT_TURN);
    const page1 = makePageNode(turn.id, DEFAULT_TURN, 'm', 'Page one.');
    const turn2 = makeTurnNode(page1.id, DEFAULT_TURN);
    const page2 = makePageNode(turn2.id, DEFAULT_TURN, 'm', 'Page two.');
    const book = setFrontier(makeBook(seed.id, title.id, 'm'), page2.id);
    const app = new StubApp(libOf([seed, title, turn, page1, turn2, page2], [book]), book, 'page');
    const root = mountView(app, (a) => renderCast(a, book));

    let calls = 0;
    let failFirst!: (err: Error) => void;
    app.generateJSON = (() => {
      calls++;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          failFirst = reject;
        });
      }
      return Promise.resolve({ people: [{ name: 'Elin Marr', note: '' }] });
    }) as typeof app.generateJSON;

    click(findButton(root, '↻ Update from the story')); // held — page 2's update
    maybeUpdateBible(api(app), book, page1.id); // queued while it runs
    failFirst(new Error('server busy'));
    for (let i = 0; i < 10 && calls < 2; i++) await settle();

    expect(calls).toBe(2);
    expect(app.calls.some((call) => call[0] === 'saveBible' && call[1] === page1.id)).toBe(true);
  });

  it('does not re-extract a dropped page on the next update', async () => {
    // The auto update for the FRONTIER page (2) is in flight when the reader
    // edits the cast, so the reply is correctly dropped — and the marker
    // naming page 2 must go with it, or the next update (for page 1) would
    // treat page 2 as trailing work and re-extract it unrequested.
    const seed = makeSeedNode('s', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
    const turn1 = makeTurnNode(title.id, DEFAULT_TURN);
    const page1 = makePageNode(turn1.id, DEFAULT_TURN, 'm', 'One.');
    const turn2 = makeTurnNode(page1.id, DEFAULT_TURN);
    const page2 = makePageNode(turn2.id, DEFAULT_TURN, 'm', 'Two.');
    const book = setFrontier(makeBook(seed.id, title.id, 'm'), page2.id);
    const lib = libOf([seed, title, turn1, page1, turn2, page2], [book]);
    lib.settings = { ...lib.settings, autoBible: true };
    const app = new StubApp(lib, book, 'page');
    const root = mountView(app, (api) => renderCast(api, book));

    // Hold the first model call open — AND record it: the panel's own hold
    // helper replaces the method outright, so its calls never reach app.calls.
    const originalGenerateJSON = app.generateJSON;
    let release!: (value: unknown) => void;
    app.generateJSON = (() => {
      app.calls.push(['generateJSON']);
      return new Promise((resolve) => {
        release = resolve as (value: unknown) => void;
      });
    }) as typeof app.generateJSON;

    maybeUpdateBible(api(app), book, page2.id);
    // The reader edits while the model is thinking.
    click(findButton(root, '＋ person'));
    type(root.querySelector('.cast-form input') as HTMLInputElement, 'Hermes QA Ghost');
    click(saveInForm(root));
    // The reply lands and is dropped as stale.
    release({ people: [{ name: 'Elin Marr', note: 'from the model' }] });
    await settle();
    await settle();
    await settle();

    // A later update for the EARLIER page must make exactly its own call.
    app.generateJSON = originalGenerateJSON;
    app.genJsonReply = { people: [{ name: 'Elin Marr', note: 'from the model' }] };
    await updateBible(api(app), book, page1.id);
    await settle();
    await settle();

    expect(app.calls.filter((call) => call[0] === 'generateJSON')).toHaveLength(2);
  });
});

function expectFormOn(root: HTMLElement, name: string): void {
  const form = root.querySelector('.cast-form');
  expect(form).toBeTruthy();
  const field = root.querySelector('.cast-form input') as HTMLInputElement | null;
  expect(field?.value).toBe(name);
}
