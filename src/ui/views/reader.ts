/**
 * ui/views/reader.ts — read the compiled book: title page first, then one page
 * at a time. The compiled book is just ONE path through the tree; the tree
 * itself stays alive in the library.
 */
import type { AppApi } from '../ctx';
import { button, fmtNumber, h } from '../dom';
import { compileBook } from '../../core/compile';
import { titleNodeOf } from '../../core/tree';
import type { Book } from '../../core/types';
import { exportCompiledFile } from '../../store/files';

// Session view state: reading position per book.
const positions = new Map<string, number>();

export function renderReader(api: AppApi): HTMLElement {
  const book = findBook(api);
  if (!book) {
    return h(
      'div',
      { class: 'view' },
      h('p', { text: 'No book to read.' }),
      button('← Library', () => api.navigate('library')),
    );
  }

  const compiled = compileBook(api.nodes, book);
  const max = compiled.pages.length;
  const pos = Math.min(Math.max(positions.get(book.id) ?? 0, 0), max);
  positions.set(book.id, pos);

  const go = (delta: number) => {
    positions.set(book.id, Math.min(Math.max(pos + delta, 0), max));
    api.refresh();
  };

  const titleNode = titleNodeOf(api.nodes, book);
  const tagline = titleNode.data.kind === 'title' ? titleNode.data.tagline : '';

  const exportRow = h(
    'div',
    { class: 'row gap' },
    button('⇓ .txt', () => void exportCompiledFile(compiled, 'txt')),
    button('⇓ .md', () => void exportCompiledFile(compiled, 'md')),
  );

  if (max === 0) {
    return h(
      'div',
      { class: 'view view-reader' },
      h('header', { class: 'view-head' }, h('h1', { class: 'title-hero', text: compiled.title })),
      h('p', { text: 'This book has no pages yet.' }),
      h(
        'div',
        { class: 'row gap' },
        button('← Library', () => api.navigate('library')),
        exportRow,
      ),
    );
  }

  if (pos === 0) {
    return h(
      'div',
      { class: 'view view-reader' },
      h(
        'header',
        { class: 'view-head title-page' },
        h('h1', { class: 'title-hero', text: compiled.title }),
        tagline ? h('p', { class: 'lede', text: tagline }) : null,
        h('p', {
          class: 'book-meta',
          text: `A book directed page by page · ${max} pages · ${fmtNumber(compiled.words)} words`,
        }),
        compiled.seed ? h('p', { class: 'book-meta', text: `Seed: “${compiled.seed}”` }) : null,
      ),
      h(
        'div',
        { class: 'actions' },
        button('Begin reading →', () => go(1), 'primary'),
        exportRow,
        button('← Library', () => api.navigate('library')),
      ),
    );
  }

  const page = compiled.pages[pos - 1];
  if (!page) return h('div', { class: 'view' });
  return h(
    'div',
    { class: 'view view-reader' },
    h(
      'header',
      { class: 'page-head' },
      h('span', { class: 'page-num', text: `Page ${page.number} of ${max}` }),
      h('span', { class: 'page-book', text: compiled.title }),
    ),
    h('div', { class: 'page-text', text: page.text }),
    h(
      'div',
      { class: 'actions' },
      button('◀', () => go(-1), 'ghost', { disabled: pos <= 1 }),
      button('▶', () => go(1), 'primary', { disabled: pos >= max }),
      button('≡ Title page', () => go(-pos)),
      exportRow,
    ),
  );
}

function findBook(api: AppApi): Book | null {
  const id = api.params.book;
  if (id) return api.lib.books.find((b) => b.id === id) ?? null;
  return api.book;
}
