/**
 * ui/views/theend.ts — the book is complete. The tree remains: re-read the
 * compiled path, export it, or keep branching from the last page.
 */
import type { AppApi } from '../ctx';
import { button, fmtNumber, h } from '../dom';
import { compileBook } from '../../core/compile';
import { pathToRoot, statsOf, titleNodeOf } from '../../core/tree';
import { exportCompiledFile } from '../../store/files';
import { renderCast } from '../cast';
import { renderStoryMemory } from '../story';

export function renderTheEnd(api: AppApi): HTMLElement {
  const book = api.book;
  if (!book) {
    return h(
      'div',
      { class: 'view' },
      h('p', { text: 'No book open.' }),
      button('← Library', () => api.navigate('library')),
    );
  }

  const compiled = compileBook(api.nodes, book);
  const stats = statsOf(api.nodes, book);
  const titleNode = titleNodeOf(api.nodes, book);
  const title = titleNode.data.kind === 'title' ? titleNode.data.title : 'Untitled';

  const path = pathToRoot(api.nodes, book.frontierId);
  const ending = path.find((n) => n.kind === 'ending');
  const lastPage = [...path].reverse().find((n) => n.kind === 'page');
  const lastText =
    lastPage && lastPage.data.kind === 'page'
      ? lastPage.data.versions[lastPage.data.chosenVersion - 1]?.text
      : '';

  return h(
    'div',
    { class: 'view view-theend' },
    h(
      'header',
      { class: 'view-head theend-head' },
      h('p', { class: 'theend-kicker', text: 'T H E   E N D' }),
      h('h1', { class: 'title-hero', text: title }),
      h('p', {
        class: 'book-meta',
        text: `${compiled.pages.length} pages · ${fmtNumber(compiled.words)} words kept`,
      }),
      h('p', {
        class: 'book-meta',
        text: `The tree remembers: ${stats.versions} versions, ${stats.branches} branches, ${stats.nodes} moments. The compiled book is one path through it.`,
      }),
    ),
    lastText ? h('div', { class: 'page-text', text: lastText }) : null,
    ending && ending.data.kind === 'ending' && ending.data.note
      ? h('p', { class: 'book-meta', text: `Ending note: “${ending.data.note}”` })
      : null,
    h(
      'div',
      { class: 'actions' },
      button('📖 Read the book', () => api.navigate('reader', { book: book.id }), 'primary'),
      button('📊 About this book', () => api.navigate('about', { book: book.id }), 'ghost', {
        title: 'The full ledger: words, versions, decisions, models',
      }),
      button('🗺️ Story map', () => api.navigate('archive', { book: book.id }), 'ghost', {
        title: 'See every path, version and road not taken',
      }),
      button('➡️ Write a sequel', () => api.seedFromBook(book.id), 'ghost', {
        title: 'Seed a new book that inherits this cast and threads',
      }),
      button('⇓ .epub', () => void exportCompiledFile(compiled, 'epub'), 'ghost', {
        title: 'Export the book as a real EPUB e-book',
      }),
      button('⇓ .txt', () => void exportCompiledFile(compiled, 'txt')),
      button('⇓ .md', () => void exportCompiledFile(compiled, 'md')),
      button(
        '🌿 Keep branching',
        () => {
          api.unfinishBook(book);
          api.navigate('page');
        },
        'ghost',
        { title: 'Un-end the book and grow a new branch from the last page' },
      ),
      button('← Library', () => api.navigate('library')),
    ),
    renderCast(api, book),
    renderStoryMemory(api, book),
  );
}
