import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/core/zip';
import { epubBytes, moodLine } from '../src/core/epub';
import type { CompiledBook } from '../src/core/compile';

function book(): CompiledBook {
  return {
    title: 'The Dead Letter',
    seed: 'A lighthouse keeper finds a letter.',
    pages: [
      {
        number: 1,
        text: 'First page.\n\nSecond paragraph.',
        words: 4,
        mood: { icon: '🕳️', label: 'dread', value: 2 },
      },
      { number: 2, text: 'The end.', words: 2 },
    ],
    words: 6,
    endingNote: 'The End',
    cast: {
      people: [{ name: 'Elin', note: 'the keeper', details: 'wants the truth' }],
      places: [],
      things: [],
      threads: [{ name: "the letter's sender", note: '' }],
      relations: [],
      summary: '',
      at: 2,
      updatedAt: 1,
    },
  };
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe(0xcbf43926);
  });
});

describe('epubBytes', () => {
  it('produces a zip with the required EPUB skeleton', () => {
    const bytes = epubBytes(book());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Local file header magic.
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const decoder = new TextDecoder('ascii');
    // mimetype must be the first entry, stored uncompressed.
    expect(decoder.decode(bytes.subarray(30 + 8, 30 + 8 + 20))).toBe('application/epub+zip');
    const text = decoder.decode(bytes);
    expect(text).toContain('META-INF/container.xml');
    expect(text).toContain('OEBPS/content.opf');
    expect(text).toContain('OEBPS/p1.xhtml');
    expect(text).toContain('OEBPS/cast.xhtml');
    // End-of-central-directory magic present.
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return; // found
    }
    throw new Error('EOCD not found');
  });

  it('escapes XML in prose and prints the mood map', () => {
    const b = book();
    b.title = 'A <Sharp> & "Odd" Title';
    const bytes = epubBytes(b);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('A &lt;Sharp&gt; &amp; &quot;Odd&quot; Title');
    expect(text).toContain('First page.');
    expect(moodLine(b)).toContain('1🕳️+2');
  });

  it('does not let the prologue shift page labels and moods by one', () => {
    const b = book();
    b.pages.unshift({
      number: 0,
      kind: 'prologue',
      text: 'The page zero that knew.',
      words: 5,
      mood: { icon: '✨', label: 'wonder', value: 1 },
    });
    const bytes = epubBytes(b);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('OEBPS/p0.xhtml');
    expect(text).toContain('OEBPS/p1.xhtml');
    // Page 1 keeps its own page label and its own mood — not the prologue's.
    expect(text).toContain('Page 1 · 🕳️ dread +2');
    expect(text).not.toContain('Page 1 · ✨ wonder +1');
    // The prologue entry labels itself as the prologue (header and heading).
    expect(text).toContain('<title>Prologue</title>');
    // The mood map ignores page zero (like compile.ts does).
    expect(moodLine(b)).toContain('1🕳️+2');
    expect(moodLine(b)).not.toContain('0✨');
  });
});
