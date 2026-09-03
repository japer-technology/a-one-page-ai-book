/**
 * core/compile.ts — turn the chosen path of the tree into a linear book,
 * and linear books into exportable text. Pure and testable.
 */
import type { Book, EmotionName, PageDocument, StoryBible, StoryNode, TurnInput } from './types';
import { EMOTION_ICONS } from './types';
import { pathToRoot } from './tree';

export interface CompiledPage {
  number: number;
  text: string;
  words: number;
  /** The dominant emotion dial that produced this page (the mood map). */
  mood?: { icon: string; label: string; value: number };
  /** The diegetic document format of this page (letter, diary, clipping…). */
  document?: PageDocument;
}

export interface CompiledBook {
  title: string;
  seed: string;
  pages: CompiledPage[];
  words: number;
  endingNote: string;
  /** The living cast as known at the end of the compiled path, if any. */
  cast?: StoryBible;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/** Split page text into craftable paragraphs (blank-line separated). */
export function paragraphsOf(text: string): string[] {
  const parts = text
    .split(/\n[ \t]*\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [text.trim()];
}

/** Rejoin paragraphs into one page of text (double newline separators). */
export function joinParagraphs(paragraphs: string[]): string {
  return paragraphs.join('\n\n');
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
export function compileBook(
  nodes: Record<string, StoryNode>,
  book: Book,
  toNodeId?: string,
): CompiledBook {
  const path = pathToRoot(nodes, toNodeId ?? book.frontierId);
  const titleNode = path.find((n) => n.kind === 'title');
  const seedNode = path.find((n) => n.kind === 'seed');
  const endingNode = path.find((n) => n.kind === 'ending');

  const pages: CompiledPage[] = [];
  let cast: StoryBible | undefined;
  for (const node of path) {
    if (node.kind !== 'page' || node.data.kind !== 'page') continue;
    if (node.data.bible) cast = node.data.bible;
    const version = node.data.versions[node.data.chosenVersion - 1];
    if (!version) continue;
    pages.push({
      number: pages.length + 1,
      text: version.text,
      words: countWords(version.text),
      mood: moodOf(node.data.direction) ?? undefined,
      document: node.data.direction.document,
    });
  }

  return {
    title: titleNode && titleNode.data.kind === 'title' ? titleNode.data.title : 'Untitled',
    seed: seedNode && seedNode.data.kind === 'seed' ? seedNode.data.text : '',
    pages,
    words: pages.reduce((sum, p) => sum + p.words, 0),
    endingNote: endingNode && endingNode.data.kind === 'ending' ? endingNode.data.note : '',
    cast,
  };
}

/** The dominant emotion dial for a page's direction (the mood map). */
export function moodOf(
  direction: TurnInput,
): { icon: string; label: string; value: number } | null {
  let best: { name: EmotionName; value: number } | null = null;
  for (const [name, value] of Object.entries(direction.emotions)) {
    if (!value) continue;
    if (!(name in EMOTION_ICONS)) continue;
    if (!best || Math.abs(value) > Math.abs(best.value)) {
      best = { name: name as EmotionName, value };
    }
  }
  if (!best) return null;
  return {
    icon: EMOTION_ICONS[best.name],
    label: best.name,
    value: best.value,
  };
}

/** One compact line of the per-page mood map. */
export function moodLine(compiled: CompiledBook): string {
  const marks = compiled.pages
    .map((page) =>
      page.mood
        ? `${page.number}${page.mood.icon}${page.mood.value > 0 ? '+' : ''}${page.mood.value}`
        : null,
    )
    .filter((mark): mark is string => mark !== null);
  return marks.length > 0 ? `Mood map: ${marks.join(' · ')}` : '';
}

export function toPlainText(compiled: CompiledBook): string {
  const lines: string[] = [compiled.title, '', ''];
  for (const page of compiled.pages) {
    lines.push(page.text.trim(), '', '');
  }
  if (compiled.endingNote) lines.push('— The End —', '');
  const mood = moodLine(compiled);
  if (mood) lines.push(mood, '');
  lines.push(castText(compiled.cast));
  lines.push(`(A book directed page by page in Page Turn. Seed: ${compiled.seed})`);
  return lines.join('\n').trimEnd() + '\n';
}

export function toMarkdown(compiled: CompiledBook): string {
  const lines: string[] = [`# ${compiled.title}`, '', `> ${compiled.seed}`, ''];
  for (const page of compiled.pages) {
    lines.push(page.text.trim(), '', '');
  }
  if (compiled.endingNote) lines.push('*— The End —*', '');
  const mood = moodLine(compiled);
  if (mood) lines.push(mood, '');
  if (compiled.cast) {
    lines.push('## The cast', '');
    lines.push(castMarkdown(compiled.cast));
  }
  lines.push('---', '', '*Directed page by page in [Page Turn](https://github.com).*');
  return lines.join('\n').trimEnd() + '\n';
}

function castText(cast: StoryBible | undefined): string {
  if (!cast) return '';
  const parts: string[] = ['', 'THE CAST', ''];
  appendGroup(parts, 'People', cast.people);
  appendGroup(parts, 'Places', cast.places);
  appendGroup(parts, 'Things', cast.things);
  appendGroup(parts, 'Open threads', cast.threads);
  parts.push('');
  return parts.join('\n');
}

function appendGroup(
  parts: string[],
  label: string,
  entries: Array<{ name: string; note: string; details?: string }>,
): void {
  if (entries.length === 0) return;
  parts.push(label);
  for (const entry of entries) {
    const note = entry.note ? ` — ${entry.note}` : '';
    const details = entry.details ? ` (${entry.details})` : '';
    parts.push(`  ${entry.name}${note}${details}`);
  }
  parts.push('');
}

function castMarkdown(cast: StoryBible): string {
  const parts: string[] = [];
  const groups: Array<[string, Array<{ name: string; note: string; details?: string }>]> = [
    ['**People**', cast.people],
    ['**Places**', cast.places],
    ['**Things**', cast.things],
    ['**Open threads**', cast.threads],
  ];
  for (const [label, entries] of groups) {
    if (entries.length === 0) continue;
    parts.push(label, '');
    for (const entry of entries) {
      const note = entry.note ? ` — ${entry.note}` : '';
      const details = entry.details ? ` *(${entry.details})*` : '';
      parts.push(`- **${entry.name}**${note}${details}`);
    }
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

export function bookFileName(compiled: CompiledBook, ext: string): string {
  return `${slugify(compiled.title)}.${ext}`;
}
