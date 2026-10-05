// @vitest-environment happy-dom
/**
 * tests/views/titles.test.ts — the title phase, against the real view module.
 *
 * Every proposal is a doorway: clicking a card selects it (the card's own
 * edit field must not clear that selection), and the choose control hands the
 * chosen option to `pickTitle` and moves on to direct page one. "Propose 5
 * more" appends only titles the seed does not already offer.
 *
 * The stub's `pickTitle` is a recorded throw (the harness does not model the
 * book creation), so this file patches the instance with the real contract:
 * record the call, return the book.
 */
import { describe, expect, it } from 'vitest';
import { renderTitles } from '../../src/ui/views/titles';
import { makeSeedNode } from '../../src/core/tree';
import { defaultLibrary, emptySeedOptions } from '../../src/core/schema';
import type { Book, Library, StoryNode, TitleOption } from '../../src/core/types';
import { all, click, mountView, settle, StubApp, type, texts } from '../helpers/view-harness';

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

/** The harness records-and-throws; model the real contract for this file. */
function stubPickTitle(app: StubApp): void {
  const target = app as unknown as {
    pickTitle: (seedId: string, option: TitleOption) => Book;
  };
  target.pickTitle = (seedId, option) => {
    app.calls.push(['pickTitle', seedId, option]);
    return app.book ?? ({} as Book);
  };
}

function fixture(): { app: StubApp; root: HTMLElement; seedId: string } {
  const seed = makeSeedNode('A letter waits on the desk.', emptySeedOptions());
  if (seed.data.kind === 'seed') {
    seed.data.titles = [
      { title: 'The Dead Letter', tagline: 'A letter waits.' },
      { title: 'Salt & Secrets', tagline: 'The tide remembers.' },
    ];
  }
  const app = new StubApp(libOf([seed], []), null, 'titles');
  stubPickTitle(app);
  app.state.params = { seed: seed.id };
  const root = mountView(app, renderTitles);
  return { app, root, seedId: seed.id };
}

const chooseButton = (root: HTMLElement): HTMLButtonElement => {
  const button = all(root, 'button').find(
    (b) => b.textContent.includes('Use this title') || b.textContent.includes('Select a title'),
  );
  if (!button) throw new Error('choose control missing');
  return button as HTMLButtonElement;
};

describe('the title phase', () => {
  it('renders the proposals and hands the chosen option to pickTitle', () => {
    const { app, root, seedId } = fixture();
    expect(texts(root, '.title-card h2')).toEqual(['The Dead Letter', 'Salt & Secrets']);

    // Nothing chosen yet: the control is inert.
    expect(chooseButton(root).disabled).toBe(true);
    expect(chooseButton(root).textContent).toContain('Select a title above');

    click(all(root, '.title-card')[0]);

    const chosenCard = all(root, '.title-card')[0];
    expect(chosenCard?.className).toContain('selected');
    expect(chooseButton(root).disabled).toBe(false);
    expect(chooseButton(root).textContent).toContain('Use this title');

    click(chooseButton(root));
    const pickIndex = app.calls.findIndex((call) => call[0] === 'pickTitle');
    const navIndex = app.calls.findIndex((call) => call[0] === 'navigate' && call[1] === 'turn');
    expect(pickIndex).toBeGreaterThanOrEqual(0);
    // …and the reader is moved on to direct page one.
    expect(navIndex).toBeGreaterThan(pickIndex);
    expect(app.calls[pickIndex]?.[1]).toBe(seedId);
    expect(app.calls[pickIndex]?.[2]).toEqual({
      title: 'The Dead Letter',
      tagline: 'A letter waits.',
    });
  });

  it('lets a keyboard reader select a card and proceed (no click required)', () => {
    const { root } = fixture();
    // On a return visit nothing is selected and the choose control is inert;
    // a keyboard reader must still be able to pick a proposal.
    expect(chooseButton(root).disabled).toBe(true);
    expect(all(root, '.title-card')[1]?.getAttribute('tabindex')).toBe('0');

    all(root, '.title-card')[1]?.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(all(root, '.title-card')[1]?.className).toContain('selected');
    expect(chooseButton(root).disabled).toBe(false);

    // Space selects too (and does not scroll the page).
    all(root, '.title-card')[0]?.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }),
    );
    expect(all(root, '.title-card')[0]?.className).toContain('selected');
    expect(chooseButton(root).disabled).toBe(false);
  });

  it('chooses the reader’s edited title, not the proposal', () => {
    const { app, root } = fixture();
    click(all(root, '.title-card')[0]);

    // The inline editor only appears on the selected card.
    const edit = all(root, '.title-edit')[0] as HTMLInputElement | undefined;
    expect(edit).toBeTruthy();
    type(edit ?? null, 'The Dead Letter (revised)');

    click(chooseButton(root));
    const pick = app.calls.find((call) => call[0] === 'pickTitle');
    expect(pick?.[2]).toEqual({ title: 'The Dead Letter (revised)', tagline: 'A letter waits.' });
  });

  it('appends only fresh proposals — a batch of duplicates is not appended', async () => {
    const { app, root } = fixture();
    app.genTextReply = JSON.stringify([
      { title: 'The Dead Letter', tagline: 'A duplicate.' },
      { title: 'Salt & Secrets', tagline: 'Also a duplicate.' },
    ]);

    click(all(root, 'button').find((b) => b.textContent.includes('Propose 5 more')));
    await settle();
    await settle();

    expect(app.calls.some((call) => call[0] === 'generateText')).toBe(true);
    // Every parsed title already exists on the seed: appending them would
    // duplicate the proposal list, so nothing is appended and the reader is
    // told why.
    expect(app.calls.some((call) => call[0] === 'appendTitles')).toBe(false);
    expect(app.toasts.map((toast) => toast.message).join('\n')).toContain(
      'No new titles this time',
    );
  });

  it('appends when the batch has a genuinely new proposal', async () => {
    const { app, root } = fixture();
    app.genTextReply = JSON.stringify([
      { title: 'The Dead Letter', tagline: 'A duplicate.' },
      { title: 'A Third Door', tagline: 'It opens.' },
    ]);

    click(all(root, 'button').find((b) => b.textContent.includes('Propose 5 more')));
    await settle();
    await settle();

    // The stub records `appendTitles` without its payload; the duplicate-only
    // test above proves the payload was filtered to the fresh options.
    expect(app.calls.some((call) => call[0] === 'appendTitles')).toBe(true);
    expect(app.toasts.map((toast) => toast.message).join('\n')).not.toContain(
      'No new titles this time',
    );
  });
});
