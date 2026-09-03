import { describe, expect, it } from 'vitest';
import { diffStats, diffWords, tokenize } from '../src/core/diff';

describe('tokenize', () => {
  it('splits words, punctuation and whitespace', () => {
    expect(tokenize("Mara's hands shook.")).toEqual(["Mara's", ' ', 'hands', ' ', 'shook', '.']);
  });
});

describe('diffWords', () => {
  it('marks additions and deletions', () => {
    const parts = diffWords('The fog rolled in.', 'The thick fog rolled in slowly.');
    const joined = parts
      .map((p) => (p.kind === 'add' ? `+${p.text}+` : p.kind === 'del' ? `-${p.text}-` : p.text))
      .join('');
    expect(joined).toContain('+thick +');
    expect(joined).toContain('+ slowly+');
    expect(diffStats(parts).added).toBeGreaterThan(0);
  });

  it('returns all-same for identical texts', () => {
    const parts = diffWords('same text', 'same text');
    expect(parts.every((p) => p.kind === 'same')).toBe(true);
    expect(diffStats(parts)).toEqual({ added: 0, removed: 0 });
  });

  it('handles empty before', () => {
    const parts = diffWords('', 'fresh start');
    expect(parts.filter((p) => p.kind === 'add').length).toBeGreaterThan(0);
  });
});
