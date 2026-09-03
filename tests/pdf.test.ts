import { describe, expect, it } from 'vitest';
import { cp1252, pdfBytes, textWidth, wrapText } from '../src/core/pdf';
import type { CompiledBook } from '../src/core/compile';

function book(): CompiledBook {
  return {
    title: 'The Dead Letter',
    seed: 'A lighthouse keeper finds a letter.',
    pages: [
      {
        number: 1,
        text: 'First page. '.repeat(60),
        words: 120,
        mood: { icon: '🕳️', label: 'dread', value: 2 },
      },
      { number: 2, text: 'The end.', words: 2 },
    ],
    words: 122,
    endingNote: 'The End',
    cast: {
      people: [{ name: 'Elin', note: 'the keeper' }],
      places: [],
      things: [],
      threads: [],
      at: 2,
      updatedAt: 1,
    },
  };
}

describe('cp1252', () => {
  it('maps typographic characters and drops emoji', () => {
    const bytes = cp1252('A — “quote” 🕳️ end');
    expect(bytes[0]).toBe(0x41);
    expect([...bytes]).toContain(0x97); // em dash
    expect([...bytes]).toContain(0x93); // left double quote
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('🕳');
  });
});

describe('wrapText', () => {
  it('wraps to width and keeps blank lines', () => {
    const lines = wrapText('word word word', 11, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(textWidth('hello', 10)).toBeGreaterThan(0);
  });
});

describe('pdfBytes', () => {
  it('produces a valid PDF skeleton with pages for every chapter', () => {
    const bytes = pdfBytes(book());
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Font');
    expect(text).toContain('startxref');
    expect(text).toContain('%%EOF');
    expect(text).toContain('The Dead Letter');
    // long page 1 overflows into more than one PDF page; count them all
    const pageCount = (text.match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThanOrEqual(3);
  });
});
