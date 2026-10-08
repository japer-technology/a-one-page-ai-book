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

describe('the emotion dials fold', () => {
  it('counts touched dials live, without forcing a re-render', () => {
    const { app, root } = fixture();
    const summary = (): string => root.querySelector('.dials-summary')?.textContent ?? '';
    expect(summary()).toContain('Emotion dials');
    expect(summary()).not.toContain('touched');

    // Dragging a dial fires `input` repeatedly; the count must update with it.
    const tension = root.querySelector('.dial-grid .dial-range') as HTMLInputElement;
    type(tension, '2');
    expect(summary()).toContain('1 touched');

    // Back to 0 = inherit: the dial is no longer touched.
    type(tension, '0');
    expect(summary()).not.toContain('touched');

    // The fix updates the label in place — a refresh() would replace the
    // range element mid-drag and break the interaction.
    expect(app.refreshes).toBe(0);
  });
});

describe('the ending tick', () => {
  it('reaches the generation prompt, across a re-render', async () => {
    const { app, root } = fixture();
    const box = root.querySelector('.check-field input') as HTMLInputElement;
    expect(box).toBeTruthy();
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));

    // The shell can repaint between the tick and the generate (a background
    // upkeep finishing, for one). The flag lives on the turn input object,
    // not on the DOM node, so it must survive — and the checkbox must come
    // back checked.
    app.refresh();
    const boxAgain = root.querySelector('.check-field input') as HTMLInputElement;
    expect(boxAgain.checked).toBe(true);

    click(findButton(root, 'Generate next page'));
    await settle();
    await settle();
    const askedWithEnding = app.calls.some(
      (call) => call[0] === 'generateText' && JSON.stringify(call[1] ?? '').includes('ENDING PAGE'),
    );
    expect(askedWithEnding).toBe(true);
  });
});

describe('a failed generation', () => {
  it('does not wedge the console for other positions, and Retry repeats its own attempt', async () => {
    // Two pages, so there are two positions to turn from.
    const seed = makeSeedNode('s', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'The Dead Letter', tagline: '' });
    const turn1 = makeTurnNode(title.id, DEFAULT_TURN);
    const page1 = makePageNode(turn1.id, DEFAULT_TURN, 'm', 'PAGE ONE TEXT.');
    const turn2 = makeTurnNode(page1.id, DEFAULT_TURN);
    const page2 = makePageNode(turn2.id, DEFAULT_TURN, 'm', 'PAGE TWO TEXT.');
    const waiting = makeTurnNode(page2.id, DEFAULT_TURN);
    const book = setFrontier(makeBook(seed.id, title.id, 'm'), waiting.id);
    const app = new StubApp(
      libOf([seed, title, turn1, page1, turn2, page2, waiting], [book]),
      book,
      'turn',
    );
    app.state.params = { from: page2.id };
    const root = mountView(app, renderTurn);

    let textCalls = 0;
    app.generateText = async (messages?: unknown) => {
      app.calls.push(['generateText', messages]);
      textCalls++;
      if (textCalls === 1) throw new Error('LLM returned an empty page');
      return 'A NEW PAGE.';
    };
    type(root.querySelector<HTMLTextAreaElement>('.direction-input'), 'THE BRIDGE COLLAPSES');
    click(findButton(root, 'Generate next page'));
    await settle();
    await settle();

    // The failed position shows its own error panel…
    expect(root.textContent).toContain('LLM returned an empty page');
    expect(findButton(root, 'Retry')).toBeTruthy();

    // …but every OTHER position's console is free. It used to be hidden for
    // the whole book, with Retry wired to whichever page was on screen.
    app.state.params = { from: page1.id };
    app.refresh();
    await settle();
    expect(root.textContent).not.toContain('LLM returned an empty page');
    expect(findButton(root, 'Generate next page')).toBeTruthy();

    // Returning to the failed position brings ITS panel back, and its Retry
    // repeats that attempt — with page 2's direction — never another page's.
    app.state.params = { from: page2.id };
    app.refresh();
    await settle();
    app.attachPage = ((_b: unknown, parentId: string, _dir: unknown, text: string) => {
      app.calls.push(['attachPage', parentId, text]);
      return { id: 'page-new', kind: 'page', parentId, createdAt: 0, data: {} } as StoryNode;
    }) as unknown as StubApp['attachPage'];
    click(findButton(root, 'Retry'));
    await settle();
    await settle();
    const gens = app.calls.filter((call) => call[0] === 'generateText');
    expect(gens.length).toBe(2);
    expect(JSON.stringify(gens[1]?.[1] ?? '')).toContain('THE BRIDGE COLLAPSES');
  });
});

describe('a cancelled conflict check', () => {
  it('is not stored as a model failure', async () => {
    const { app, root } = fixture();
    let release = (): void => {};
    app.generateJSON = (() =>
      new Promise((_resolve, reject) => {
        release = () => reject(new DOMException('Generation cancelled', 'AbortError'));
      })) as unknown as StubApp['generateJSON'];

    type(directionBox(root), 'OPEN THE DOOR');
    click(findButton(root, 'Check this direction'));
    await settle();

    // The reader navigates away mid-check: the request is aborted.
    app.state.view = 'library';
    app.abortGeneration();
    release();
    await settle();
    await settle();

    // Back at the same console: no “Generation cancelled.” failure banner and
    // no Retry attached to a direction the reader never had answered.
    app.state.view = 'turn';
    app.refresh();
    await settle();
    expect(root.textContent).not.toContain('Generation cancelled');
    expect(findButton(root, 'Retry')).toBeFalsy();
  });
});

describe('the standing-rule draft', () => {
  it('does not leak between books', () => {
    const seedA = makeSeedNode('a', emptySeedOptions());
    const titleA = makeTitleNode(seedA.id, { title: 'A', tagline: '' });
    const turnA = makeTurnNode(titleA.id, DEFAULT_TURN);
    const pageA = makePageNode(turnA.id, DEFAULT_TURN, 'm', 'A TEXT.');
    const bookA = setFrontier(makeBook(seedA.id, titleA.id, 'm'), pageA.id);
    const seedB = makeSeedNode('b', emptySeedOptions());
    const titleB = makeTitleNode(seedB.id, { title: 'B', tagline: '' });
    const turnB = makeTurnNode(titleB.id, DEFAULT_TURN);
    const pageB = makePageNode(turnB.id, DEFAULT_TURN, 'm', 'B TEXT.');
    const bookB = setFrontier(makeBook(seedB.id, titleB.id, 'm'), pageB.id);

    const app = new StubApp(
      libOf([seedA, titleA, turnA, pageA, seedB, titleB, turnB, pageB], [bookA, bookB]),
      bookA,
      'turn',
    );
    app.state.params = { from: pageA.id };
    const root = mountView(app, renderTurn);

    type(root.querySelector<HTMLInputElement>('.rule-input'), 'Don’t reveal the letter yet');
    app.state.book = bookB;
    app.state.params = { from: pageB.id };
    app.refresh();
    // Book B's console must start with an EMPTY rule input: the single shared
    // draft used to pre-fill book A's half-typed rule here.
    expect(root.querySelector<HTMLInputElement>('.rule-input')?.value).toBe('');
  });
});
