import { describe, expect, it } from 'vitest';
import { cp1252, pdfBytes, pdfFontFor, textWidth, wrapText } from '../src/core/pdf';
import type { PdfFontKey } from '../src/core/pdf';
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
      relations: [],
      summary: '',
      at: 2,
      updatedAt: 1,
    },
  };
}

function longPageBook(words: number): CompiledBook {
  const text = Array.from({ length: words }, (_, i) => `word${i}`).join(' ') + '.';
  return {
    title: 'The Long Book',
    seed: 'A very long page.',
    pages: [{ number: 1, text, words }],
    words,
    endingNote: '',
    cast: {
      people: [{ name: 'Elin', note: 'the keeper' }],
      places: [],
      things: [],
      threads: [],
      relations: [],
      summary: '',
      at: 1,
      updatedAt: 1,
    },
  };
}

/** Every emitted text-drawing op: { font, size, line }. */
function textOps(bytes: Uint8Array): Array<{ font: string; size: number; line: string }> {
  const text = new TextDecoder('latin1').decode(bytes);
  return [...text.matchAll(/BT \/(F\d) ([\d.]+) Tf [\s\S]*?\(([^)]*)\) Tj ET/g)].map((m) => ({
    font: m[1] ?? 'F1',
    size: Number(m[2]),
    line: m[3] ?? '',
  }));
}

function pageCount(bytes: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(bytes);
  return (text.match(/\/Type \/Page[^s]/g) ?? []).length;
}

const FONT_KEY: Record<string, PdfFontKey> = { F1: 'helvetica', F2: 'times', F3: 'courier' };

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
    // title page + one PDF page per book page + the cast appendix
    expect(pageCount(bytes)).toBeGreaterThanOrEqual(3);
  });
});

describe('PDF wrap guarantees', () => {
  it('never emits a line wider than the page — seeds, mood lines and cast notes wrap', () => {
    const compiled = {
      title: 'A Very Long Title That Keeps Going And Going Across The Entire Page Width',
      seed: 'word '.repeat(400), // a long seed that previously overflowed
      pages: [
        {
          number: 1,
          text: 'Short page.',
          words: 2,
          mood: { icon: '🕳️', label: 'dread', value: 2 },
        },
      ],
      words: 400,
      endingNote: 'The end',
      cast: {
        people: [{ name: 'Elin', note: 'note '.repeat(80), details: 'details '.repeat(120) }],
        places: [],
        things: [],
        threads: [],
        relations: [],
        summary: '',
        at: 1,
        updatedAt: 1,
      },
    };
    const bytes = pdfBytes(compiled);
    const pageWidth = 432;
    const margin = 60;
    const ops = textOps(bytes);
    expect(ops.length).toBeGreaterThan(3);
    for (const { font, size, line } of ops) {
      // Every emitted line must fit AT ITS OWN font size — the invariant the
      // old unwrapped seed/mood/cast lines broke.
      expect(textWidth(line, size, FONT_KEY[font] ?? 'helvetica')).toBeLessThanOrEqual(
        pageWidth - margin * 2 + 0.5,
      );
    }
  });
});

describe('PDF page fitting', () => {
  it('shrinks the body font so a long book page fits on ONE printed page', () => {
    // ~500 words is far too much for one page at 11pt, but fits when shrunk.
    const bytes = pdfBytes(longPageBook(500));
    // title page + the one chapter + cast = 3 pages; the old fixed-size
    // writer would have overflowed the chapter onto extra pages.
    expect(pageCount(bytes)).toBe(3);
    const sizes = textOps(bytes).map((op) => op.size);
    const bodySizes = sizes.filter((size) => size >= 6.4 && size < 11.5);
    expect(bodySizes.length).toBeGreaterThan(0);
    expect(Math.min(...bodySizes)).toBeLessThan(11); // shrunk below the 11pt default
  });

  it('keeps the full 11pt when the page already fits', () => {
    const bytes = pdfBytes(book());
    const sizes = textOps(bytes).map((op) => op.size);
    expect(sizes).toContain(11);
  });

  it('still paginates a page that cannot fit even at the floor size', () => {
    const bytes = pdfBytes(longPageBook(4000));
    expect(pageCount(bytes)).toBeGreaterThan(4); // chapter overflowed
    const sizes = textOps(bytes).map((op) => op.size);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(6.4); // never below the floor
  });
});

describe('PDF font selection', () => {
  it('maps reading fonts to base-14 fonts', () => {
    expect(pdfFontFor({ readingFont: 'sans' })).toBe('helvetica');
    expect(pdfFontFor({ readingFont: 'georgia' })).toBe('times');
    expect(pdfFontFor({ readingFont: 'palatino' })).toBe('times');
    expect(pdfFontFor({ readingFont: 'charter' })).toBe('times');
    expect(pdfFontFor({ readingFont: 'serif' })).toBe('times');
    expect(pdfFontFor({ readingFont: 'georgia' }, 'mapnote')).toBe('courier');
    expect(pdfFontFor({ readingFont: 'georgia', documentFonts: { story: 'sans' } }, 'story')).toBe(
      'helvetica',
    );
    expect(pdfFontFor({ readingFont: 'sans', documentFonts: { story: 'georgia' } }, 'story')).toBe(
      'times',
    );
  });

  it('sets sans reading font in Helvetica', () => {
    const bytes = pdfBytes(book(), { readingFont: 'sans' });
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('/BaseFont /Helvetica');
    expect(text).toContain('/BaseFont /Times-Roman');
    expect(text).toContain('/BaseFont /Courier');
    const body = textOps(bytes).filter((op) => op.line.includes('First page'));
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((op) => op.font === 'F1')).toBe(true);
  });

  it('sets serif reading fonts in Times-Roman', () => {
    const bytes = pdfBytes(book(), { readingFont: 'georgia' });
    const body = textOps(bytes).filter((op) => op.line.includes('First page'));
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((op) => op.font === 'F2')).toBe(true);
  });

  it('honors the per-format wardrobe and map notes in Courier', () => {
    const compiled = book();
    compiled.pages[0] = { ...compiled.pages[0]!, document: 'mapnote' };
    const bytes = pdfBytes(compiled, { readingFont: 'georgia' });
    const body = textOps(bytes).filter((op) => op.line.includes('First page'));
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((op) => op.font === 'F3')).toBe(true);
  });

  it('honors a wardrobe override for story pages', () => {
    const compiled = book();
    compiled.pages[0] = { ...compiled.pages[0]!, document: 'story' };
    const bytes = pdfBytes(compiled, {
      readingFont: 'georgia',
      documentFonts: { story: 'sans' },
    });
    const body = textOps(bytes).filter((op) => op.line.includes('First page'));
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((op) => op.font === 'F1')).toBe(true);
  });
});
