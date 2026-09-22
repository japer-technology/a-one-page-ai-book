/**
 * core/stats.ts — the living shelf's ledger: streaks, totals, and local
 * achievements, all derived from the library + the activity calendar.
 * Pure: takes a `today` string so tests are deterministic. No cloud, no
 * accounts — the badges are computed on-device, every render.
 */
import type { Library } from './types';
import { compileBook } from './compile';
import { collectSubtree } from './tree';

export interface Achievement {
  id: string;
  icon: string;
  label: string;
  hint: string;
  earned: boolean;
}

export interface ShelfStats {
  books: number;
  finished: number;
  pages: number;
  wordsKept: number;
  versions: number;
  branches: number;
  streak: number;
  longestStreak: number;
  activeDays: number;
  achievements: Achievement[];
}

/** Consecutive-day streak ending at (or just before) today. */
export function computeStreak(days: string[], today: string): { streak: number; longest: number } {
  const set = new Set(days);
  let streak = 0;
  let cursor = today;
  // If today is missing, start counting from yesterday (streak not yet broken).
  if (!set.has(cursor)) cursor = shiftDate(cursor, -1);
  while (set.has(cursor)) {
    streak++;
    cursor = shiftDate(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  const sorted = [...set].sort();
  let previous: string | null = null;
  for (const day of sorted) {
    if (previous !== null && isNextDay(previous, day)) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  return { streak, longest };
}

export function shiftDate(iso: string, delta: number): string {
  // Parse as UTC (the Z suffix): local-timezone parsing would shift the day
  // and break streaks for anyone not on UTC.
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function isNextDay(a: string, b: string): boolean {
  return shiftDate(a, 1) === b;
}

export function computeShelfStats(lib: Library, today: string): ShelfStats {
  const books = lib.books;
  const nodes = lib.nodes;
  let pages = 0;
  let wordsKept = 0;
  let versions = 0;
  let branches = 0;
  let finished = 0;
  let sequelCount = 0;
  let ironFinished = 0;
  let maxVersionsOnOnePage = 0;

  for (const book of books) {
    if (book.status === 'finished') finished++;
    if (book.status === 'finished' && book.ironMode === 'iron') ironFinished++;
    const compiled = compileBook(nodes, book);
    pages += compiled.pages.length;
    wordsKept += compiled.words;
    if (/^Sequel to\b/i.test(compiled.seed)) sequelCount++;
    const subtree = collectSubtree(nodes, book.seedNodeId);
    for (const node of subtree) {
      if (node.kind === 'page' && node.data.kind === 'page') {
        versions += node.data.versions.length;
        maxVersionsOnOnePage = Math.max(maxVersionsOnOnePage, node.data.versions.length);
      }
      if (node.kind === 'turn' || node.kind === 'page') {
        const children = subtree.filter((n) => n.parentId === node.id);
        if (children.length > 1) branches++;
      }
    }
  }

  const days = Object.keys(lib.settings.activityDays ?? {});
  const { streak, longest } = computeStreak(days, today);

  const achievements: Achievement[] = [
    {
      id: 'first-book',
      icon: '🌱',
      label: 'First book',
      hint: 'Seed your first story',
      earned: books.length >= 1,
    },
    {
      id: 'first-page',
      icon: '📄',
      label: 'First page',
      hint: 'Write page one',
      earned: pages >= 1,
    },
    {
      id: 'shelfful',
      icon: '📚',
      label: 'A full shelf',
      hint: 'Five books on the shelf',
      earned: books.length >= 5,
    },
    {
      id: 'perfectionist',
      icon: '💎',
      label: 'Perfectionist',
      hint: 'Ten versions of a single page',
      earned: maxVersionsOnOnePage >= 10,
    },
    {
      id: 'centurion',
      icon: '💯',
      label: 'Centurion',
      hint: 'A hundred pages kept',
      earned: pages >= 100,
    },
    {
      id: 'gardener',
      icon: '🌿',
      label: 'Gardener',
      hint: 'Grow ten branch points',
      earned: branches >= 10,
    },
    {
      id: 'director',
      icon: '🎬',
      label: 'Director',
      hint: 'Keep ten thousand words',
      earned: wordsKept >= 10_000,
    },
    { id: 'finisher', icon: '🏁', label: 'Finisher', hint: 'Finish a book', earned: finished >= 1 },
    {
      id: 'sequelist',
      icon: '➡️',
      label: 'Sequelist',
      hint: 'Seed a sequel',
      earned: sequelCount >= 1,
    },
    {
      id: 'week-long',
      icon: '🔥',
      label: 'On fire',
      hint: 'A seven-day streak',
      earned: streak >= 7,
    },
    {
      id: 'iron-author',
      icon: '⚔️',
      label: 'Iron Author',
      hint: 'Finish a book with no re-rolls',
      earned: ironFinished >= 1,
    },
  ];

  return {
    books: books.length,
    finished,
    pages,
    wordsKept,
    versions,
    branches,
    streak,
    longestStreak: longest,
    activeDays: days.length,
    achievements,
  };
}
