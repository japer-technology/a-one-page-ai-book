import { describe, expect, it } from 'vitest';
import { computeShelfStats, computeStreak, shiftDate } from '../src/core/stats';
import { defaultLibrary } from '../src/core/schema';
import { finishBook, makeBook, makePageNode, makeSeedNode, makeTitleNode } from '../src/core/tree';
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
});
