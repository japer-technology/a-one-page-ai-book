import { describe, expect, it } from 'vitest';
import { lintText, lintVerdict } from '../src/core/lint';

describe('lintText', () => {
  it('measures words, sentences, paragraphs and ratios', () => {
    const report = lintText(
      'One sentence here. Another one here.\n\nThird paragraph with a quoted "hello there" line.',
    );
    expect(report.words).toBeGreaterThan(10);
    expect(report.sentences).toBeGreaterThanOrEqual(2);
    expect(report.paragraphs).toBe(2);
    expect(report.dialogueDensity).toBeGreaterThan(0);
    expect(report.issues.length).toBeGreaterThanOrEqual(0);
  });

  it('flags adverb bloat and repetition', () => {
    const text = Array.from(
      { length: 6 },
      () => 'She walked slowly and quietly into the slowly quiet room.',
    ).join('\n\n');
    const report = lintText(text);
    expect(report.adverbRatio).toBeGreaterThan(0.08);
    expect(report.repeatedNgrams.length).toBeGreaterThan(0);
    expect(lintVerdict(report)).toBe('needs a look');
  });

  it('reports empty pages cleanly', () => {
    const report = lintText('   ');
    expect(report.words).toBe(0);
    expect(report.issues.some((i) => i.message.includes('empty'))).toBe(true);
  });
});
