/**
 * core/compile.ts — turn the chosen path of the tree into a linear book,
 * and linear books into exportable text. Pure and testable.
 */
import type { Book, StoryNode } from './types';
import { pathToRoot } from './tree';

export interface CompiledPage {
  number: number;
  text: string;
  words: number;
}

export interface CompiledBook {
  title: string;
  seed: string;
  pages: CompiledPage[];
  words: number;
  endingNote: string;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'untitled-book';
}

/** The chosen path, compiled: title page + pages in spine order + ending note. */
export function compileBook(nodes: Record<string, StoryNode>, book: Book): CompiledBook {
  const path = pathToRoot(nodes, book.frontierId);
  const titleNode = path.find((n) => n.kind === 'title');
  const seedNode = path.find((n) => n.kind === 'seed');
  const endingNode = path.find((n) => n.kind === 'ending');

  const pages: CompiledPage[] = [];
  for (const node of path) {
    if (node.kind !== 'page' || node.data.kind !== 'page') continue;
    const version = node.data.versions[node.data.chosenVersion - 1];
    if (!version) continue;
    pages.push({ number: pages.length + 1, text: version.text, words: countWords(version.text) });
  }

  return {
    title: titleNode && titleNode.data.kind === 'title' ? titleNode.data.title : 'Untitled',
    seed: seedNode && seedNode.data.kind === 'seed' ? seedNode.data.text : '',
    pages,
    words: pages.reduce((sum, p) => sum + p.words, 0),
    endingNote: endingNode && endingNode.data.kind === 'ending' ? endingNode.data.note : '',
  };
}

export function toPlainText(compiled: CompiledBook): string {
  const lines: string[] = [compiled.title, '', ''];
  for (const page of compiled.pages) {
    lines.push(page.text.trim(), '', '');
  }
  if (compiled.endingNote) lines.push('— The End —', '');
  lines.push(`(A book directed page by page in Page Turn. Seed: ${compiled.seed})`);
  return lines.join('\n').trimEnd() + '\n';
}

export function toMarkdown(compiled: CompiledBook): string {
  const lines: string[] = [`# ${compiled.title}`, '', `> ${compiled.seed}`, ''];
  for (const page of compiled.pages) {
    lines.push(page.text.trim(), '', '');
  }
  if (compiled.endingNote) lines.push('*— The End —*', '');
  lines.push('---', '', '*Directed page by page in [Page Turn](https://github.com).*');
  return lines.join('\n').trimEnd() + '\n';
}

export function bookFileName(compiled: CompiledBook, ext: string): string {
  return `${slugify(compiled.title)}.${ext}`;
}
