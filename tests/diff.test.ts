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

/**
 * Above 3000 tokens the word-level table is abandoned for the line-level
 * fallback, which used to add and drop its `\n` separators by hand: the
 * compare view showed a phantom blank line after every deleted paragraph of a
 * long page, and appended text was glued onto the line above it.
 */
describe('large pages (line-level fallback)', () => {
  const reconstruct = (parts: ReturnType<typeof diffWords>, kinds: Array<'same' | 'add' | 'del'>) =>
    parts
      .filter((p) => kinds.includes(p.kind))
      .map((p) => p.text)
      .join('');
  /** Ten long paragraphs, so the token count passes the LCS cap. */
  const paragraphs = Array.from(
    { length: 10 },
    (_, i) => `Paragraph ${i}. ` + 'word '.repeat(240).trim(),
  );
  const before = paragraphs.join('\n\n');

  it('reconstructs both sides exactly', () => {
    const after = paragraphs.filter((_, i) => i !== 4).join('\n\n');
    const deleted = diffWords(before, after);
    expect(reconstruct(deleted, ['same', 'del']), 'same + del must be the original').toBe(before);
    expect(reconstruct(deleted, ['same', 'add'])).toBe(after);

    const appended = `${before}\n\nA brand new final paragraph.\n`;
    const added = diffWords(before, appended);
    expect(reconstruct(added, ['same', 'del'])).toBe(before);
    expect(reconstruct(added, ['same', 'add'])).toBe(appended);
  });

  it('does not triple the blank line between paragraphs', () => {
    const after = paragraphs.filter((_, i) => i !== 4).join('\n\n');
    const deleted = diffWords(before, after);
    expect(reconstruct(deleted, ['same'])).not.toMatch(/\n{3,}/);
  });
});
