/**
 * core/mdfiles.ts — the library as plain .md files. An alternative, fully
 * human-readable file structure: a README, an index, and one markdown file
 * per book (title, seed, provenance, every page, cast, mood map). Pure and
 * testable.
 */
import type { Library } from './types';
import { compileBook, moodLine, slugify, toMarkdown } from './compile';
import { seedTextOf, statsOf, titleOf } from './tree';

export interface MdEntry {
  name: string;
  content: string;
}

export function bookMdName(lib: Library, bookId: string): string {
  const book = lib.books.find((b) => b.id === bookId);
  if (!book) return 'unknown.md';
  return `books/${slugify(titleOf(lib.nodes, book)) || 'untitled'}-${book.id.slice(0, 8)}.md`;
}

function bookMd(lib: Library, bookId: string): MdEntry {
  const book = lib.books.find((b) => b.id === bookId);
  if (!book) return { name: 'unknown.md', content: '' };
  const compiled = compileBook(lib.nodes, book);
  const stats = statsOf(lib.nodes, book);
  const seed = seedTextOf(lib.nodes, book);
  const mood = moodLine(compiled);
  const body = toMarkdown(compiled);
  const header = [
    `# ${compiled.title}`,
    '',
    `- Seed: ${seed}`,
    `- Status: ${book.status === 'finished' ? 'finished' : 'in progress'}`,
    `- Pages kept: ${compiled.pages.length} · Words kept: ${compiled.words}`,
    `- Versions: ${stats.versions} · Branches: ${stats.branches}`,
    `- Model: ${book.model || 'unknown'}`,
    `- Started: ${new Date(book.createdAt).toISOString().slice(0, 10)} · Updated: ${new Date(book.updatedAt).toISOString().slice(0, 10)}`,
    ...(book.tags.length > 0 ? [`- Tags: ${book.tags.join(', ')}`] : []),
    ...(book.guests.length > 0 ? [`- Co-written with: ${book.guests.join(', ')}`] : []),
    ...(mood ? [`- ${mood}`] : []),
    '',
    '---',
    '',
  ].join('\n');
  return { name: bookMdName(lib, bookId), content: header + body + '\n' };
}

/** The whole library as a folder of .md files. */
export function mdLibraryEntries(lib: Library): MdEntry[] {
  const entries: MdEntry[] = [];
  const lines = ['# Page Turn — the library, as markdown', ''];
  for (const book of lib.books) {
    const title = titleOf(lib.nodes, book);
    const stats = statsOf(lib.nodes, book);
    lines.push(
      `- **${title}** — ${stats.pages} pages · ${stats.words} words kept · [${bookMdName(lib, book.id)}](${bookMdName(lib, book.id)})`,
    );
  }
  if (lib.books.length === 0) lines.push('(The shelf is empty.)');
  entries.push({ name: 'index.md', content: lines.join('\n') + '\n' });
  entries.push({
    name: 'README.md',
    content: [
      '# Page Turn library',
      '',
      'This folder is a complete, human-readable copy of your bookshelf: one markdown file per book (pages, cast and mood map included), exported from Page Turn.',
      '',
      `- Books: ${lib.books.length}`,
      `- Exported: ${new Date().toISOString()}`,
      '',
    ].join('\n'),
  });
  for (const book of lib.books) entries.push(bookMd(lib, book.id));
  return entries;
}
