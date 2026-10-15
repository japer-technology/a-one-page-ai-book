import { describe, expect, it } from 'vitest';
import { computeShelfStats, computeStreak, shiftDate } from '../src/core/stats';
import { defaultLibrary } from '../src/core/schema';
import {
  finishBook,
  makeBook,
  makePageNode,
  makePrologueNode,
  makeSeedNode,
  makeTitleNode,
  makeTurnNode,
  setFrontier,
  statsOf,
} from '../src/core/tree';
import { emptySeedOptions } from '../src/core/schema';
import { DEFAULT_TURN } from '../src/core/types';

describe('computeStreak', () => {
  it('counts consecutive days ending today or yesterday', () => {
    const today = '2026-02-10';
    const days = [today, '2026-02-09', '2026-02-08', '2026-02-01'];
    expect(computeStreak(days, today)).toEqual({ streak: 3, longest: 3 });
    const yesterday = days.slice(0, 2);
    expect(computeStreak(yesterday, today).streak).toBe(2); // not broken yet
    expect(computeStreak(['2026-02-01', '2026-02-03'], today)).toEqual({ streak: 0, longest: 1 });
  });

  it('never hangs on the empty-string sentinel in a day list', () => {
    // '' is shiftDate()'s unparseable sentinel and a fixed point of itself:
    // it entered the set and the walk could never advance — an unbreakable
    // infinite loop inside the shelf render.
    expect(computeStreak([''], '')).toEqual({ streak: 0, longest: 0 });
    expect(computeStreak([''], 'nonsense')).toEqual({ streak: 0, longest: 0 });
    expect(computeStreak(['', '2026-10-10', '2026-10-11'], '2026-10-11')).toEqual({
      streak: 2,
      longest: 2,
    });
  });

  it('shiftDate moves across months', () => {
    expect(shiftDate('2026-02-01', -1)).toBe('2026-01-31');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('computeShelfStats', () => {
  it('derives totals and achievements from the library', () => {
    const lib = defaultLibrary();
    const seed = makeSeedNode('A seed.', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
    const page = makePageNode(title.id, DEFAULT_TURN, 'm', 'Page text.');
    const book = finishBook(makeBook(seed.id, title.id, 'm'), page.id);
    lib.nodes = { [seed.id]: seed, [title.id]: title, [page.id]: page };
    lib.books = [book];
    lib.settings.activityDays = { '2026-02-08': 1, '2026-02-09': 1, '2026-02-10': 1 };
    const stats = computeShelfStats(lib, '2026-02-10');
    expect(stats.books).toBe(1);
    expect(stats.finished).toBe(1);
    expect(stats.pages).toBe(1);
    expect(stats.streak).toBe(3);
    expect(stats.achievements.find((a) => a.id === 'first-book')?.earned).toBe(true);
    expect(stats.achievements.find((a) => a.id === 'centurion')?.earned).toBe(false);
  });

  it('counts pages and words exactly as the book card does (prologue excluded)', () => {
    const lib = defaultLibrary();
    const seed = makeSeedNode('A seed.', emptySeedOptions());
    const title = makeTitleNode(seed.id, { title: 'T', tagline: '' });
    const turn = makeTurnNode(title.id, DEFAULT_TURN);
    const page = makePageNode(turn.id, DEFAULT_TURN, 'm', 'Page one text here.');
    const prologue = makePrologueNode(title.id, DEFAULT_TURN, 'm', 'The page zero that knew.');
    const book = setFrontier(makeBook(seed.id, title.id, 'm'), page.id);
    lib.nodes = {
      [seed.id]: seed,
      [title.id]: title,
      [turn.id]: turn,
      [page.id]: page,
      [prologue.id]: prologue,
    };
    lib.books = [book];

    const stats = computeShelfStats(lib, '2026-10-11');
    const card = statsOf(lib.nodes, book);
    // The compiled list includes the page-zero prologue; the shelf strip used
    // it while the book card (and the .md export) counted statsOf — two
    // contradictory numbers for one book on one screen.
    expect(stats.pages).toBe(card.pages);
    expect(stats.wordsKept).toBe(card.words);
    expect(stats.pages).toBe(1);
  });
});
