// @vitest-environment happy-dom
/**
 * tests/views/library.test.ts — the bookshelf, against the real view module.
 *
 * Three reader-visible promises:
 *  1. the search box filters the shelf by title;
 *  2. a search that matches nothing says so — and the note survives a
 *     re-render (it is a child of the list wrapper; `list.after(note)` on the
 *     detached tree a re-render builds was a silent no-op, leaving a blank
 *     shelf with the query still in the box and no hint why);
 *  3. the tag chips narrow the shelf, and a finished book stays on it with a
 *     "Read" door.
 */
import { describe, expect, it } from 'vitest';
import { renderLibrary } from '../../src/ui/views/library';
import {
  finishBook,
  makeBook,
  makePageNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
  setFrontier,
} from '../../src/core/tree';
import { defaultLibrary, emptySeedOptions, normalizeLibrary } from '../../src/core/schema';
import { DEFAULT_TURN } from '../../src/core/types';
import type { Book, Library, StoryNode } from '../../src/core/types';
import { all, click, mountView, StubApp, type } from '../helpers/view-harness';

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

function bookOn(
  title: string,
  seedText: string,
  tags: string[] = [],
): { nodes: StoryNode[]; book: Book } {
  const seed = makeSeedNode(seedText, emptySeedOptions());
  const titleNode = makeTitleNode(seed.id, { title, tagline: `${title} tagline` });
  const turn = makeTurnNode(titleNode.id, DEFAULT_TURN);
  const page = makePageNode(turn.id, DEFAULT_TURN, 'm', `${title} opens here.`);
  const book = { ...setFrontier(makeBook(seed.id, titleNode.id, 'm'), page.id), tags };
  return { nodes: [seed, titleNode, turn, page], book };
}

/** Two in-progress books, one tagged `gothic`, one `coastal`. */
function shelf(): { app: StubApp; root: HTMLElement } {
  const dead = bookOn('The Dead Letter', 'A letter waits on the desk.', ['gothic']);
  const salt = bookOn('Salt & Secrets', 'The tide brings a locked box.', ['coastal']);
  const app = new StubApp(
    libOf([...dead.nodes, ...salt.nodes], [dead.book, salt.book]),
    null,
    'library',
  );
  const root = mountView(app, renderLibrary);
  return { app, root };
}

function cardFor(root: HTMLElement, title: string): HTMLElement {
  const card = all(root, '.book-card').find((el) => el.textContent.includes(title));
  if (!card) throw new Error(`card for ${title} missing`);
  return card;
}

const searchBox = (root: HTMLElement): HTMLInputElement =>
  root.querySelector('input.search') as HTMLInputElement;

describe('the bookshelf', () => {
  it('restores unfinished starts from storage and resumes their title proposals', () => {
    const started = makeSeedNode('A seed whose model was offline.', emptySeedOptions());
    const titled = bookOn('Already titled', 'A different seed.');
    const lib = normalizeLibrary(
      JSON.parse(JSON.stringify(libOf([started, ...titled.nodes], [titled.book]))),
    );
    const app = new StubApp(lib, null, 'library');
    const root = mountView(app, renderLibrary);
    expect(root.querySelectorAll('.unfinished-start')).toHaveLength(1);
    expect(root.querySelector('.unfinished-start')?.textContent).toContain('model was offline');
    click(all(root, 'button').find((b) => b.textContent === 'Resume titles'));
    expect(app.view).toBe('titles');
    expect(app.params.seed).toBe(started.id);
  });

  it('deletes only the chosen unfinished start and its proposals', () => {
    window.confirm = () => true;
    const seed = makeSeedNode('Discard this start.', emptySeedOptions());
    const proposal = makeTitleNode(seed.id, { title: 'Unused', tagline: '' });
    const kept = bookOn('Keep this book', 'Keep this seed.');
    const app = new StubApp(libOf([seed, proposal, ...kept.nodes], [kept.book]), null, 'library');
    const root = mountView(app, renderLibrary);
    click(all(root, 'button').find((b) => b.textContent === 'Delete start'));
    expect(app.nodes[seed.id]).toBeUndefined();
    expect(app.nodes[proposal.id]).toBeUndefined();
    expect(app.lib.books).toEqual([kept.book]);
    expect(root.querySelector('.unfinished-start')).toBeNull();
  });

  it('offers one primary start action and import on an empty shelf', () => {
    const app = new StubApp(defaultLibrary(), null, 'library');
    const root = mountView(app, renderLibrary);
    expect(root.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(root.querySelector('.btn-primary')?.textContent).toContain('Start a book');
    expect(root.querySelector('.toolbar')).toBeNull();
    expect(root.textContent).toContain('Import library');
    click(all(root, 'button').find((b) => b.textContent === 'Hide this guide'));
    expect(app.lib.settings.seenOnboarding).toBe(true);
    expect(root.querySelector('.onboarding')).toBeNull();
    expect(root.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('gives a populated library a heading, creation action, and file tools', () => {
    const { root } = shelf();
    expect(root.querySelector('h1')?.textContent).toBe('Your library');
    expect(root.querySelectorAll('.library-heading .btn-primary')).toHaveLength(1);
    expect(root.querySelector('.toolbar .btn-primary')).toBeNull();
    expect(root.querySelector('.toolbar')?.textContent).toContain('Export library');
    const files = root.querySelector<HTMLDetailsElement>('.library-files');
    expect(files?.open).toBe(false);
    expect(files?.querySelector('summary')?.textContent).toBe('Import & export');
    expect(root.querySelector('.sort-select')?.getAttribute('aria-label')).toBe('Sort your books');
  });

  it('filters by title while typing, and keeps a no-match note across a re-render', () => {
    const { root } = shelf();
    type(searchBox(root), '');
    expect(cardFor(root, 'The Dead Letter').style.display).toBe('');
    expect(cardFor(root, 'Salt & Secrets').style.display).toBe('');

    type(searchBox(root), 'dead letter');
    expect(cardFor(root, 'The Dead Letter').style.display).toBe('');
    expect(cardFor(root, 'Salt & Secrets').style.display).toBe('none');

    // A query that matches nothing: the shelf explains itself.
    type(searchBox(root), 'zzzzq');
    expect(cardFor(root, 'The Dead Letter').style.display).toBe('none');
    expect(root.querySelector('.empty-state-inline')?.textContent).toContain(
      'No books match that search',
    );

    // Any re-render (a sort change, a background upkeep refresh) must keep
    // BOTH the query and its explanation: the note lives inside the list
    // wrapper, so the freshly built tree carries it.
    const sort = root.querySelector('select.sort-select') as HTMLSelectElement;
    sort.value = 'length';
    sort.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(searchBox(root).value).toBe('zzzzq');
    expect(root.querySelector('.empty-state-inline')?.textContent).toContain(
      'No books match that search',
    );
    expect(cardFor(root, 'The Dead Letter').style.display).toBe('none');

    // Clearing the query brings the shelf back and takes the note away.
    type(searchBox(root), '');
    expect(cardFor(root, 'The Dead Letter').style.display).toBe('');
    expect(cardFor(root, 'Salt & Secrets').style.display).toBe('');
    expect(root.querySelector('.empty-state-inline')).toBeNull();
  });

  it('keeps a finished book on the shelf, with a Read door', () => {
    const done = bookOn('Ashes at Dawn', 'The last fire goes out.');
    const book = finishBook(done.book, done.nodes[done.nodes.length - 1]!.id);
    const app = new StubApp(libOf(done.nodes, [book]), book, 'library');
    const root = mountView(app, renderLibrary);
    type(searchBox(root), '');

    const card = cardFor(root, 'Ashes at Dawn');
    expect(card.className).toContain('finished');
    expect(card.textContent).toContain('📕 finished');

    const read = all(card, 'button').find((b) => b.textContent.trim() === 'Read');
    click(read);
    expect(app.calls.some((call) => call[0] === 'openBook' && call[1] === book.id)).toBe(true);
  });

  it('narrows the shelf by tag, and clearing the tag brings the shelf back', () => {
    const { root } = shelf();
    type(searchBox(root), '');

    click(all(root, '.tag-chip').find((chip) => chip.textContent.trim() === 'gothic'));
    const shown = all(root, '.book-card');
    expect(shown).toHaveLength(1);
    expect(shown[0]?.textContent).toContain('The Dead Letter');

    // Clicking the active chip again clears the filter.
    click(all(root, '.tag-chip').find((chip) => chip.textContent.trim() === 'gothic'));
    expect(all(root, '.book-card')).toHaveLength(2);
  });
});
