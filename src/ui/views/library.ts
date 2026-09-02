/**
 * ui/views/library.ts — the bookshelf. Every book is a spine; click to re-enter
 * at its frontier. Export, duplicate, delete, import/export of the whole library.
 */
import type { AppApi } from '../ctx';
import { button, fmtDate, fmtNumber, h } from '../dom';
import { compileBook } from '../../core/compile';
import { seedTextOf, sortBooks, statsOf, titleNodeOf, titleOf } from '../../core/tree';
import type { Book } from '../../core/types';
import {
  exportBookBundle,
  exportCompiledFile,
  exportLibraryFile,
  importLibraryFile,
} from '../../store/files';

export function renderLibrary(api: AppApi): HTMLElement {
  const books = sortBooks(api.lib);

  const search = h('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Search titles and seeds…',
    'aria-label': 'Search your books',
  });

  const list = h('div', { class: 'book-list' });
  const empty =
    books.length === 0
      ? h(
          'div',
          { class: 'empty-state' },
          h('h1', { text: 'The One-Page AI Book' }),
          h('p', {
            class: 'lede',
            text: 'You write one sentence — a seed. A local LLM writes the book with you, one page at a time. You direct every page turn. Every version is remembered forever.',
          }),
          noModelBanner(api),
          h(
            'div',
            { class: 'row gap' },
            button('＋ Start a book', () => api.navigate('seed'), 'primary'),
            button('↥ Import library…', () => importLibrary(api)),
          ),
        )
      : null;

  // Fill the list once; the search box filters by visibility (no re-render → focus kept).
  for (const book of books) list.appendChild(bookCard(api, book));

  search.addEventListener('input', () => {
    const needle = search.value.trim().toLowerCase();
    for (const card of Array.from(list.children)) {
      const haystack = ((card as HTMLElement).dataset.search ?? '').toLowerCase();
      (card as HTMLElement).style.display =
        needle === '' || haystack.includes(needle) ? '' : 'none';
    }
  });

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    books.length > 0 ? search : null,
    h(
      'div',
      { class: 'row gap' },
      button('↥ Import', () => importLibrary(api), 'ghost', {
        title: 'Import a .ptlibrary.json or .ptbook.json file',
      }),
      button('⇓ Export library', () => exportLibrary(api), 'ghost', {
        title: 'Save every book and every decision as one JSON file',
      }),
      button('＋ New book', () => api.navigate('seed'), 'primary'),
    ),
  );

  return h('div', { class: 'view view-library' }, empty, toolbar, list);
}

function bookCard(api: AppApi, book: Book): HTMLElement {
  const nodes = api.nodes;
  const title = titleOf(nodes, book);
  const seed = seedTextOf(nodes, book);
  const stats = statsOf(nodes, book);
  const titleNode = titleNodeOf(nodes, book);
  const tagline = titleNode.data.kind === 'title' ? titleNode.data.tagline : '';
  const finished = book.status === 'finished';

  const menu = h(
    'details',
    { class: 'menu' },
    h('summary', { class: 'menu-btn', title: 'More actions', text: '⋯' }),
    h(
      'div',
      { class: 'menu-panel' },
      menuItem('Export as .txt', () => void exportCompiledFile(compileBook(nodes, book), 'txt')),
      menuItem('Export as .md', () => void exportCompiledFile(compileBook(nodes, book), 'md')),
      menuItem('Save book file (.ptbook.json)', () => void exportBookBundle(book, nodes)),
      menuItem('Duplicate', () => api.duplicateBook(book.id)),
      menuItem('Delete', () => deleteBook(api, book), 'danger'),
    ),
  );

  return h(
    'article',
    {
      class: `book-card${finished ? ' finished' : ''}`,
      dataset: { search: `${title}\n${seed}\n${tagline}` },
    },
    h(
      'div',
      { class: 'book-main' },
      h('div', { class: 'book-status', text: finished ? '📕 finished' : '📖 in progress' }),
      h('h2', { class: 'book-title', text: title }),
      tagline ? h('p', { class: 'book-tagline', text: tagline }) : null,
      h('p', {
        class: 'book-stats',
        text: `${stats.pages} pages · ${fmtNumber(stats.words)} words kept · ${stats.versions} versions · ${stats.branches} branches`,
      }),
      h(
        'p',
        { class: 'book-meta' },
        `${fmtDate(book.updatedAt)} · ${book.model || 'no model'} · seed: “${seed.length > 90 ? seed.slice(0, 90) + '…' : seed}”`,
      ),
    ),
    h(
      'div',
      { class: 'book-actions' },
      button(finished ? 'Read' : 'Continue', () => api.openBook(book.id), 'primary'),
      button('📖 Read', () => api.navigate('reader', { book: book.id }), 'ghost', {
        title: 'Read the compiled book',
      }),
      menu,
    ),
  );
}

function menuItem(
  label: string,
  onClick: () => void,
  kind: 'normal' | 'danger' = 'normal',
): HTMLElement {
  return h('button', {
    class: `menu-item${kind === 'danger' ? ' menu-item-danger' : ''}`,
    type: 'button',
    text: label,
    onclick: () => onClick(),
  });
}

function deleteBook(api: AppApi, book: Book): void {
  const title = titleOf(api.nodes, book);
  if (
    window.confirm(
      `Delete “${title}”? The tree — every page, version, and decision — will be gone.`,
    )
  ) {
    api.removeBook(book.id);
    api.toast(`Deleted “${title}”`, 'info');
  }
}

async function importLibrary(api: AppApi): Promise<void> {
  try {
    const imported = await importLibraryFile();
    if (!imported) return;
    const count = imported.books.length;
    if (
      count === 0 ||
      window.confirm(
        `Import ${count} book(s) from this file? It will REPLACE the current library. Export your current library first if you want a backup.`,
      )
    ) {
      api.update(() => imported);
      api.toast(count > 0 ? `Imported ${count} book(s)` : 'Imported an empty library', 'success');
      api.navigate('library');
    }
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Import failed', 'error');
  }
}

async function exportLibrary(api: AppApi): Promise<void> {
  try {
    await exportLibraryFile(api.lib);
    api.toast('Library exported', 'success');
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Export failed', 'error');
  }
}

function noModelBanner(api: AppApi): HTMLElement | null {
  if (api.lib.settings.endpoint.model) return null;
  return h(
    'div',
    { class: 'banner' },
    'No model selected yet — Page Turn talks to a local LLM (LM Studio, Ollama, llama.cpp, …). ',
    h('button', {
      class: 'linklike',
      type: 'button',
      text: 'Find your local LLM →',
      onclick: () => api.navigate('settings'),
    }),
  );
}
