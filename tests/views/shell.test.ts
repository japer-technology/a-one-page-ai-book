// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { defaultLibrary, emptySeedOptions } from '../../src/core/schema';
import { makeBook, makeSeedNode, makeTitleNode } from '../../src/core/tree';
import type { ViewName } from '../../src/ui/ctx';
import { renderShell, renderToastStack } from '../../src/ui/shell';
import { api, click, findButton, StubApp } from '../helpers/view-harness';

function shell(view: ViewName, withBook = false): { app: StubApp; root: HTMLElement } {
  const lib = defaultLibrary();
  const seed = makeSeedNode('A letter arrives.', emptySeedOptions());
  const title = makeTitleNode(seed.id, { title: 'The Last Letter', tagline: '' });
  const book = makeBook(seed.id, title.id, 'local-writer');
  if (withBook) {
    lib.nodes = { [seed.id]: seed, [title.id]: title };
    lib.books = [book];
  }
  const app = new StubApp(lib, withBook ? book : null, view);
  const root = document.createElement('div');
  root.id = 'app';
  document.body.replaceChildren(root);
  renderShell(api(app), document.createElement('section'), []);
  return { app, root };
}

describe('workspace navigation', () => {
  it.each(['library', 'seed', 'titles', 'settings', 'help'] as const)(
    'keeps stale book tools off the %s view',
    (view) => {
      const { root } = shell(view, true);
      expect(root.querySelector('.book-context')).toBeNull();
      const current = root.querySelector('[aria-current="page"]');
      expect(current?.textContent).toBe(
        {
          library: 'Library',
          seed: 'New book',
          titles: 'New book',
          settings: 'Settings',
          help: 'Help',
        }[view],
      );
    },
  );

  it.each([
    ['page', 'Write'],
    ['turn', 'Write'],
    ['theend', 'Write'],
    ['reader', 'Read'],
    ['archive', 'Story map'],
    ['about', 'About'],
  ] as const)('identifies the current book and destination in %s', (view, label) => {
    const { root } = shell(view, true);
    expect(root.querySelector('.book-context-title')?.textContent).toBe('The Last Letter');
    expect(root.querySelector('.book-nav [aria-current="page"]')?.textContent).toBe(label);
    expect(root.querySelector('.nav [aria-current="page"]')).toBeNull();
  });

  it('returns to the book frontier and passes the book ID to other book views', () => {
    const { app, root } = shell('reader', true);
    const nav = root.querySelector('.book-nav')!;
    click(findButton(nav, 'Write'));
    expect(app.calls).toContainEqual(['openBook', app.book?.id]);
    click(findButton(nav, 'Story map'));
    expect(app.calls).toContainEqual(['navigate', 'archive', { book: app.book?.id }]);
    click(findButton(nav, 'About'));
    expect(app.calls).toContainEqual(['navigate', 'about', { book: app.book?.id }]);
  });

  it('offers model setup and moves keyboard focus directly to content', () => {
    const { app, root } = shell('library');
    click(root.querySelector('.model-chip')!);
    expect(app.calls).toContainEqual(['navigate', 'settings', {}]);
    expect(root.querySelector('.model-chip-name')?.textContent).toBe('Set up a model');
    click(root.querySelector('.skip-link')!);
    expect(document.activeElement).toBe(root.querySelector('main'));
  });

  it('updates toasts without replacing the content or book navigation', () => {
    const { root } = shell('page', true);
    const main = root.querySelector('main');
    const nav = root.querySelector('.book-nav');
    renderToastStack([{ id: 1, message: 'Saved', kind: 'success' }]);
    expect(root.querySelector('main')).toBe(main);
    expect(root.querySelector('.book-nav')).toBe(nav);
    expect(root.querySelector('#toasts')?.textContent).toBe('Saved');
  });
});
