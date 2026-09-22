/**
 * ui/views/about.ts — "About this book": the full creative ledger of one book.
 * Pages, words kept vs. generated, words written by hand vs. directed, models
 * used, the decision log, and the most-iterated pages. The spec's §9 stats
 * page: "you wrote 142 words and directed 11,283".
 */
import type { AppApi } from '../ctx';
import { button, fmtDate, fmtNumber, h } from '../dom';
import { compileBook, countWords, moodOf } from '../../core/compile';
import { collectSubtree, pageNumberAt, pathToRoot, statsOf, titleNodeOf } from '../../core/tree';
import { lintText, lintVerdict } from '../../core/lint';
import type { Book } from '../../core/types';

export function renderAbout(api: AppApi): HTMLElement {
  const book = findBook(api);
  if (!book) {
    return h(
      'div',
      { class: 'view' },
      h('p', { text: 'No book open.' }),
      button('← Library', () => api.navigate('library')),
    );
  }
  const nodes = api.nodes;
  const compiled = compileBook(nodes, book);
  const stats = statsOf(nodes, book);
  const titleNode = titleNodeOf(nodes, book);
  const title = titleNode.data.kind === 'title' ? titleNode.data.title : 'Untitled';
  const tagline = titleNode.data.kind === 'title' ? titleNode.data.tagline : '';

  const directedWords = Math.max(0, stats.wordsGenerated - stats.wordsByUser);

  const stat = (label: string, value: string, hint?: string): HTMLElement =>
    h(
      'div',
      { class: 'about-stat' },
      h('span', { class: 'about-stat-value', text: value }),
      h('span', { class: 'about-stat-label', text: label }),
      hint ? h('span', { class: 'about-stat-hint', text: hint }) : null,
    );

  const grid = h(
    'div',
    { class: 'about-grid' },
    stat('pages on the chosen path', String(stats.pages)),
    stat('words kept', fmtNumber(stats.words)),
    stat('words generated', fmtNumber(stats.wordsGenerated), 'every version, kept + discarded'),
    stat('words you wrote', fmtNumber(stats.wordsByUser), 'edited pages & paragraphs'),
    stat('words you directed', fmtNumber(directedWords), 'the model wrote these on your orders'),
    stat('versions kept', String(stats.versions)),
    stat('branch points', String(stats.branches)),
    stat('moments remembered', String(stats.nodes)),
  );

  // Models used, per page — scoped to THIS book's subtree.
  const subtree = collectSubtree(nodes, book.seedNodeId);
  const models = new Set<string>();
  for (const node of subtree) {
    if (node.data.kind === 'page' && node.data.model) models.add(node.data.model);
  }

  // Decision log: every turn on the chosen path.
  const path = pathToRoot(nodes, book.frontierId);
  const decisions = path
    .filter((n) => n.kind === 'turn' && n.data.kind === 'turn')
    .map((n, index) => {
      const input = n.data.kind === 'turn' ? n.data.input : null;
      if (!input) return null;
      const direction =
        input.direction || (input.ending ? 'bring the story to a close' : 'continue naturally');
      const mood = moodOf(input);
      return h(
        'li',
        { class: 'about-decision' },
        h('span', { class: 'about-decision-page', text: `→ page ${index + 2}` }),
        h('span', { class: 'about-decision-text', text: direction }),
        mood
          ? h('span', {
              class: 'about-decision-mood',
              text: `${mood.icon}${mood.value > 0 ? '+' : ''}${mood.value}`,
            })
          : null,
      );
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  // Most-iterated pages — scoped to THIS book's subtree, real page numbers.
  const iterated = subtree
    .filter((n) => n.kind === 'page' && n.data.kind === 'page')
    .map((n) => ({
      node: n,
      versions: n.data.kind === 'page' ? n.data.versions.length : 0,
      number: pageNumberAt(nodes, n.id),
    }))
    .sort((a, b) => b.versions - a.versions)
    .slice(0, 5)
    .filter((item) => item.versions > 1);

  const moodLine = compiled.pages
    .map((page) =>
      page.mood
        ? `${page.number}${page.mood.icon}${page.mood.value > 0 ? '+' : ''}${page.mood.value}`
        : null,
    )
    .filter((mark): mark is string => mark !== null)
    .join(' · ');

  return h(
    'div',
    { class: 'view view-about' },
    h(
      'header',
      { class: 'view-head' },
      h('p', { class: 'theend-kicker', text: 'A B O U T   T H I S   B O O K' }),
      h('h1', { class: 'title-hero', text: title }),
      tagline ? h('p', { class: 'lede', text: tagline }) : null,
      h('p', {
        class: 'book-meta',
        text: `Seed: “${compiled.seed}” · started ${fmtDate(book.createdAt)} · ${book.model || 'no model'}`,
      }),
    ),
    h(
      'div',
      { class: 'row gap' },
      button(
        '📖 Read the book',
        () => api.navigate('reader', { book: book.id, to: book.frontierId }),
        'primary',
      ),
      button('🗺️ Story map', () => api.navigate('archive', { book: book.id })),
      button('← Back', () => {
        if (api.book?.id === book.id) {
          // Finished books go back to their end page; in-progress ones to the
          // page view (the "the end" screen for a live book was misleading).
          api.navigate(book.status === 'finished' ? 'theend' : 'page');
        } else {
          api.navigate('library');
        }
      }),
    ),
    h(
      'p',
      { class: 'about-lede' },
      `You wrote ${fmtNumber(stats.wordsByUser)} words with your own hands and directed ${fmtNumber(directedWords)} more. The tree remembers ${stats.versions} versions across ${stats.branches} branch points — the compiled book is one path through all of it.`,
    ),
    grid,
    moodLine
      ? h(
          'section',
          { class: 'card' },
          h('h2', { text: 'The mood map' }),
          h('p', { class: 'about-mood', text: moodLine }),
        )
      : null,
    lintSection(compiled),
    h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Decision log' }),
      decisions.length > 0
        ? h('ol', { class: 'about-decisions' }, ...decisions)
        : h('p', { class: 'field-hint', text: 'No turns yet — the book has not been directed.' }),
    ),
    iterated.length > 0
      ? h(
          'section',
          { class: 'card' },
          h('h2', { text: 'Most-iterated pages' }),
          h(
            'ul',
            { class: 'about-iterated' },
            ...iterated.map((item) =>
              h(
                'li',
                { class: 'about-iterated-item' },
                h('span', {
                  text: `Page ${item.number}: ${item.versions} versions · ${fmtNumber(countWords(item.node.data.kind === 'page' ? (item.node.data.versions[item.node.data.chosenVersion - 1]?.text ?? '') : ''))} words kept`,
                }),
                button('Open', () => api.openPageAt(book, item.node.id), 'chip'),
              ),
            ),
          ),
        )
      : null,
    models.size > 0
      ? h(
          'section',
          { class: 'card' },
          h('h2', { text: 'Models that wrote this book' }),
          h('p', { class: 'field-hint', text: [...models].join(' · ') }),
        )
      : null,
  );
}

function findBook(api: AppApi): Book | null {
  const id = api.params.book;
  if (id) return api.lib.books.find((b) => b.id === id) ?? null;
  return api.book;
}

function lintSection(compiled: ReturnType<typeof compileBook>): HTMLElement {
  const whole = compiled.pages.map((p) => p.text).join('\n\n');
  const report = lintText(whole);
  return h(
    'section',
    { class: 'card' },
    h('h2', { text: `🩺 Story linter — ${lintVerdict(report)}` }),
    h('p', {
      class: 'field-hint',
      text: `${report.words} words · ${report.sentences} sentences · ${report.paragraphs} paragraphs · adverbs ${Math.round(report.adverbRatio * 100)}% · dialogue ${Math.round(report.dialogueDensity * 100)}% · sentence variance ${report.sentenceVariance}`,
    }),
    report.issues.length === 0
      ? h('p', { class: 'conflict-ok', text: '✓ The linter smells nothing.' })
      : h(
          'ul',
          { class: 'conflict-list' },
          ...report.issues.map((issue) =>
            h('li', {
              class: issue.severity === 'warn' ? 'lint-warn' : 'lint-info',
              text: issue.message,
            }),
          ),
        ),
  );
}
