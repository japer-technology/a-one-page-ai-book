/**
 * ui/views/library.ts — the bookshelf. Every book is a spine; click to re-enter
 * at its frontier. Export, duplicate, delete, import/export of the whole library.
 */
import type { AppApi } from '../ctx';
import { button, fmtDate, fmtNumber, h } from '../dom';
import { compileBook } from '../../core/compile';
import { getNode, seedTextOf, sortBooks, statsOf, titleNodeOf, titleOf } from '../../core/tree';
import { EMOTION_NAMES } from '../../core/types';
import type { Book, StoryNode } from '../../core/types';
import {
  exportBookBundle,
  exportLibraryFile,
  exportLibraryMarkdown,
  importLibraryFile,
} from '../../store/files';
import { exportCompiled } from '../export';
import { paintCover } from '../cover';
import { searchScore } from '../../core/search';
import { computeShelfStats } from '../../core/stats';

// Session-scoped shelf state.
let sortMode: 'recent' | 'mood' | 'length' | 'branches' = 'recent';
let activeTag: string | null = null;

export function renderLibrary(api: AppApi): HTMLElement {
  const all = sortBooks(api.lib);
  const books = sortBy(all, sortMode, api).filter(
    (book) => !activeTag || (book.tags ?? []).includes(activeTag),
  );

  // Full-text index: titles (chosen AND every proposed one), seeds AND page text (spec §10).
  const haystacks = new Map<string, string>();
  for (const book of books) {
    const compiled = compileBook(api.nodes, book);
    haystacks.set(
      book.id,
      `${titleOf(api.nodes, book)}\n${proposedTitlesText(api, book)}\n${seedTextOf(api.nodes, book)}\n${compiled.pages
        .map((p) => p.text)
        .join('\n')}`.toLowerCase(),
    );
  }

  const search = h('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Search titles, seeds & pages…',
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
          api.lib.settings.seenOnboarding ? null : onboarding(api),
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
      const bookId = (card as HTMLElement).dataset.bookId ?? '';
      const haystack = haystacks.get(bookId) ?? '';
      // Fuzzy: exact substring always wins; typo-tolerant subsequences need a score.
      (card as HTMLElement).style.display =
        needle === '' || haystack.includes(needle) || searchScore(needle, haystack) >= 8
          ? ''
          : 'none';
    }
  });

  const allTags = [...new Set(all.flatMap((book) => book.tags ?? []))].sort();
  const tagChips =
    allTags.length > 0
      ? h(
          'div',
          { class: 'tag-row' },
          h('span', { class: 'tag-row-label', text: 'tags' }),
          ...allTags.map((tag) =>
            h('button', {
              class: 'chip tag-chip' + (activeTag === tag ? ' chip-on' : ''),
              type: 'button',
              text: tag,
              onclick: () => {
                activeTag = activeTag === tag ? null : tag;
                api.refresh();
              },
            }),
          ),
          activeTag
            ? button(
                '✕ clear',
                () => {
                  activeTag = null;
                  api.refresh();
                },
                'chip',
              )
            : null,
        )
      : null;

  const nudge =
    (api.lib.settings.exportMeter?.pages ?? 0) >= 15
      ? h(
          'div',
          { class: 'banner backup-nudge' },
          `You've written ${api.lib.settings.exportMeter.pages} pages since your last export. `,
          button('⇓ Export the library', () => void exportLibrary(api), 'chip'),
        )
      : null;

  const shelf = shelfStatsStrip(api);

  const sortSelect = h(
    'select',
    { class: 'input sort-select', title: 'Sort the shelf' },
    ...[
      ['recent', 'recent'],
      ['mood', 'by mood'],
      ['length', 'by length'],
      ['branches', 'most branched'],
    ].map(([v, label]) =>
      h('option', { value: v, selected: v === sortMode ? true : undefined, text: label }),
    ),
  );
  sortSelect.addEventListener('change', () => {
    sortMode = sortSelect.value as typeof sortMode;
    api.refresh();
  });
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    books.length > 0 ? search : null,
    books.length > 0 ? sortSelect : null,
    h(
      'div',
      { class: 'row gap' },
      button('↥ Import', () => importLibrary(api), 'ghost', {
        title: 'Import a .ptlibrary.json or .ptbook.json file',
      }),
      button('⇓ Library as .md files', () => void exportMdLibrary(api), 'ghost', {
        title: 'The whole library as plain, readable markdown files (.zip)',
      }),
      button('⇓ Export library', () => exportLibrary(api), 'ghost', {
        title: 'Save every book and every decision as one JSON file',
      }),
      button('＋ New book', () => api.navigate('seed'), 'primary'),
    ),
  );

  return h('div', { class: 'view view-library' }, empty, shelf, nudge, tagChips, toolbar, list);
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
      menuItem('Continue / fork', () => api.openBook(book.id)),
      menuItem('✎ Rename', () => {
        const name = window.prompt('Rename this book:', title);
        if (name?.trim()) api.renameTitle(book, name.trim());
      }),
      menuItem('⚔ Iron Author: unlimited', () => api.setIronMode(book, 'none')),
      menuItem('⚔ Iron Author: three strikes', () => api.setIronMode(book, 'three')),
      menuItem('⚔ Iron Author: iron (no re-rolls)', () => api.setIronMode(book, 'iron')),
      menuItem('🪶 Pass the quill', () => passQuill(api, book, nodes)),
      menuItem('🏷 Edit tags', () => {
        const current = (book.tags ?? []).join(', ');
        const next = window.prompt(
          'Tags (comma-separated collections, e.g. bedtime, gothic):',
          current,
        );
        if (next !== null)
          api.setTags(
            book,
            next
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
          );
      }),
      menuItem('🗺️ Story map', () => api.navigate('archive', { book: book.id })),
      menuItem('📊 About this book', () => api.navigate('about', { book: book.id })),
      menuItem('📖 Read the chosen path', () => api.navigate('reader', { book: book.id })),
      menuItem('Export as .epub', () => void exportCompiled(api, compileBook(nodes, book), 'epub')),
      menuItem('Export as .txt', () => void exportCompiled(api, compileBook(nodes, book), 'txt')),
      menuItem('Export as .md', () => void exportCompiled(api, compileBook(nodes, book), 'md')),
      menuItem('Save book file (.ptbook.json)', () => {
        void exportBookBundle(book, nodes).then((saved) => {
          if (saved) api.markExported();
        });
      }),
      menuItem('➡️ Write a sequel', () => api.seedFromBook(book.id)),
      menuItem('Duplicate', () => api.duplicateBook(book.id)),
      menuItem('Delete', () => deleteBook(api, book), 'danger'),
    ),
  );

  const cover = h('canvas', {
    class: 'book-cover',
    width: 168,
    height: 210,
    'aria-hidden': 'true',
    title: `${finished ? 'Read' : 'Continue'} “${title}”`,
    onclick: () => api.openBook(book.id),
  });
  paintCover(cover, compileBook(nodes, book));

  return h(
    'article',
    {
      class: `book-card${finished ? ' finished' : ''}`,
      dataset: { search: `${title}\n${seed}\n${tagline}`, bookId: book.id },
    },
    cover,
    h(
      'div',
      { class: 'book-main' },
      h(
        'div',
        { class: 'book-status' },
        finished ? '📕 finished' : '📖 in progress',
        book.ironMode === 'iron' ? ' · ⚔ iron' : book.ironMode === 'three' ? ' · ⚔ 3 strikes' : '',
        book.guests && book.guests.length > 0 ? ` · 🪶 with ${book.guests.join(' & ')}` : '',
      ),
      h('h2', {
        class: 'book-title',
        text: title,
        title: `${finished ? 'Read' : 'Continue'} “${title}”`,
        onclick: () => api.openBook(book.id),
      }),
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

/** Every proposed title of a seed (with taglines), for library search (§5). */
function proposedTitlesText(api: AppApi, book: Book): string {
  const seedNode = getNode(api.nodes, book.seedNodeId);
  if (!seedNode || seedNode.data.kind !== 'seed') return '';
  return seedNode.data.titles.map((t) => `${t.title} ${t.tagline}`).join('\n');
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

async function exportMdLibrary(api: AppApi): Promise<void> {
  try {
    if (await exportLibraryMarkdown(api.lib)) {
      api.toast('Library exported as .md files', 'success');
    }
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Export failed', 'error');
  }
}

async function exportLibrary(api: AppApi): Promise<void> {
  try {
    if (await exportLibraryFile(api.lib)) {
      api.markExported();
      api.toast('Library exported', 'success');
    }
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Export failed', 'error');
  }
}

/** The living shelf's ledger: streak, totals, and local achievements. */
function shelfStatsStrip(api: AppApi): HTMLElement {
  if (api.lib.books.length === 0) return h('div');
  const today = new Date().toISOString().slice(0, 10);
  const stats = computeShelfStats(api.lib, today);
  const earned = stats.achievements.filter((a) => a.earned).length;
  return h(
    'details',
    { class: 'shelf-stats' },
    h(
      'summary',
      { class: 'shelf-stats-summary' },
      h('span', { class: 'shelf-stats-item', text: `🔥 ${stats.streak}-day streak` }),
      h('span', {
        class: 'shelf-stats-item',
        text: `📚 ${stats.books} book${stats.books === 1 ? '' : 's'}`,
      }),
      h('span', { class: 'shelf-stats-item', text: `📄 ${fmtNumber(stats.pages)} pages kept` }),
      h('span', {
        class: 'shelf-stats-item',
        text: `🏆 ${earned}/${stats.achievements.length} badges`,
      }),
      h('span', { class: 'shelf-stats-item', text: `${fmtNumber(stats.wordsKept)} words kept` }),
    ),
    h(
      'div',
      { class: 'shelf-stats-body' },
      h(
        'div',
        { class: 'achievements' },
        ...stats.achievements.map((a) =>
          h(
            'span',
            {
              class: 'achievement' + (a.earned ? ' earned' : ' locked'),
              title: `${a.label} — ${a.hint}`,
            },
            h('span', { class: 'achievement-icon', text: a.icon }),
            h('span', { class: 'achievement-label', text: a.label }),
          ),
        ),
      ),
      h('p', {
        class: 'field-hint',
        text: `Longest streak: ${stats.longestStreak} days · ${stats.activeDays} active days · all badges are computed on this device.`,
      }),
    ),
  );
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

/** A three-step tour for the empty bookshelf, dismissible forever. */
function onboarding(api: AppApi): HTMLElement {
  const dismiss = () => {
    api.update((lib) => ({
      ...lib,
      settings: { ...lib.settings, seenOnboarding: true },
    }));
  };
  const step = (icon: string, title: string, text: string): HTMLElement =>
    h(
      'div',
      { class: 'onboard-step' },
      h('span', { class: 'onboard-icon', text: icon }),
      h('h3', { text: title }),
      h('p', { text }),
    );
  return h(
    'section',
    { class: 'onboarding' },
    h(
      'div',
      { class: 'onboard-grid' },
      step('🌱', 'Write a seed', 'One sentence is enough — or chat it through first.'),
      step(
        '🎛️',
        'Direct every turn',
        '“What happens next?” — mood, length, rules, or just continue.',
      ),
      step(
        '🌳',
        'Keep everything',
        'Every version and fork is remembered; walk back and branch any time.',
      ),
    ),
    h(
      'div',
      { class: 'row gap' },
      button(
        'Got it — start my first book',
        () => {
          dismiss();
          api.navigate('seed');
        },
        'primary',
      ),
      button('Skip tour', dismiss),
    ),
  );
}

function sortBy(
  books: ReturnType<typeof sortBooks>,
  mode: 'recent' | 'mood' | 'length' | 'branches',
  api: AppApi,
): ReturnType<typeof sortBooks> {
  if (mode === 'length') {
    return [...books].sort((a, b) => statsOf(api.nodes, b).words - statsOf(api.nodes, a).words);
  }
  if (mode === 'branches') {
    return [...books].sort(
      (a, b) => statsOf(api.nodes, b).branches - statsOf(api.nodes, a).branches,
    );
  }
  if (mode === 'mood') {
    const rank = (book: (typeof books)[number]): number => {
      const compiled = compileBook(api.nodes, book);
      const counts = new Map<string, number>();
      for (const page of compiled.pages) {
        const mood = page.mood;
        if (mood) counts.set(mood.label, (counts.get(mood.label) ?? 0) + 1);
      }
      let best = '';
      let bestCount = 0;
      for (const [label, count] of counts) {
        if (count > bestCount) {
          best = label;
          bestCount = count;
        }
      }
      const index = EMOTION_NAMES.indexOf(best as never);
      return index < 0 ? EMOTION_NAMES.length : index;
    };
    return [...books].sort((a, b) => rank(a) - rank(b));
  }
  return books;
}

async function passQuill(api: AppApi, book: Book, nodes: Record<string, StoryNode>): Promise<void> {
  const name = window.prompt('Your name for the quill (recorded as a co-writer):');
  if (name === null) return;
  const withGuest = {
    ...book,
    guests: [...new Set([...(book.guests ?? []), name.trim()])].filter(Boolean),
  };
  // Record the co-writer on the shelf, not just in the exported file — the
  // toast promises it and a fresh export should carry every guest.
  api.update((lib) => ({
    ...lib,
    books: lib.books.map((b) => (b.id === book.id ? withGuest : b)),
  }));
  try {
    if (await exportBookBundle(withGuest, nodes)) {
      api.toast(
        'The quill is passed — send the .ptbook.json file. Drop it back here to merge their pages as new branches.',
        'success',
      );
    }
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Quill export failed', 'error');
  }
}
