import { describe, expect, it } from 'vitest';
import { fuzzySearch, searchScore } from '../src/core/search';

describe('searchScore', () => {
  it('scores exact substrings highest', () => {
    expect(searchScore('dead', 'The Dead Letter')).toBeGreaterThan(100);
    expect(searchScore('', 'anything')).toBe(1);
    expect(searchScore('zzz', 'The Dead Letter')).toBe(0);
  });

  it('tolerates typos via subsequence matching', () => {
    // "ded" matches d-e-d inside "The Dead Letter".
    expect(searchScore('ded', 'The Dead Letter')).toBeGreaterThan(0);
    expect(searchScore('lght', 'lighthouse keeper')).toBeGreaterThan(0);
    expect(searchScore('qkzx', 'lighthouse keeper')).toBe(0);
  });

  it('fuzzySearch ranks and filters', () => {
    // Exact substring wins outright.
    const exact = fuzzySearch('dead', [
      { text: 'The Dead Letter' },
      { text: 'A Cookbook' },
      { text: 'Letters Home' },
    ]);
    expect(exact.map((r) => r.index)).toEqual([0]);
    // A typo still finds both letter-books, ranked by score.
    const fuzzy = fuzzySearch('letr', [
      { text: 'The Dead Letter' },
      { text: 'A Cookbook' },
      { text: 'Letters Home' },
    ]);
    expect(fuzzy.map((r) => r.index).sort()).toEqual([0, 2]);
    expect(fuzzy[0]!.score).toBeGreaterThan(fuzzy[1]!.score);
    expect(fuzzy.length).toBe(2);
  });
});
