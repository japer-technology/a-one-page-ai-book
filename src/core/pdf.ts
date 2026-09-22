/**
 * core/pdf.ts — compile a book into a print-ready PDF, dependency-free.
 *
 * A minimal PDF 1.4 writer: 6×9 inch pages, word-wrapped body text, title
 * page, one chapter per book page, the mood map and the cast appendix. The
 * body font size is fitted per book page so each page fills exactly one
 * printed page (shrinking to a floor, then overflowing only when even the
 * floor cannot fit). Font selection is honored with the PDF base-14 fonts:
 * serif choices map to Times-Roman, sans to Helvetica, mono to Courier —
 * every viewer embeds these, so no font files are needed.
 */
import type { CompiledBook } from './compile';

// ---- CP1252 (WinAnsi) encoding ---------------------------------------------

const CP1252: Record<number, number> = {
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x2018: 0x91, // '
  0x2019: 0x92, // '
  0x201a: 0x82,
  0x201c: 0x93, // "
  0x201d: 0x94, // "
  0x201e: 0x84,
  0x2020: 0x86,
  0x2021: 0x87,
  0x2022: 0x95, // •
  0x2026: 0x85, // …
  0x2030: 0x89,
  0x2039: 0x8b,
  0x203a: 0x9b,
  0x20ac: 0x80, // €
  0x2122: 0x99, // ™
};

/** Encode text as CP1252 bytes, dropping characters that cannot be represented. */
export function cp1252(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x3f;
    if (code < 0x80) {
      out.push(code);
    } else if (code >= 0xa0 && code <= 0xff) {
      out.push(code);
    } else {
      const mapped = CP1252[code];
      if (mapped !== undefined) out.push(mapped);
      else if (code < 0x100) out.push(code);
      // Unencodable (emoji, most non-Latin scripts): drop.
    }
  }
  return new Uint8Array(out);
}

// ---- Font metrics (1/1000 em) ----------------------------------------------

/** Which of the PDF base-14 fonts a line is set in. */
export type PdfFontKey = 'helvetica' | 'times' | 'courier';

export const PDF_FONT_NAMES: Record<PdfFontKey, string> = {
  helvetica: 'Helvetica',
  times: 'Times-Roman',
  courier: 'Courier',
};

const FONT_REF: Record<PdfFontKey, string> = { helvetica: 'F1', times: 'F2', courier: 'F3' };

// Helvetica widths (condensed approximations).
const HELVETICA: Record<string, number> = {
  ' ': 278,
  '!': 278,
  '"': 355,
  '#': 556,
  $: 556,
  '%': 889,
  '&': 667,
  "'": 191,
  '(': 333,
  ')': 333,
  '*': 389,
  '+': 584,
  ',': 278,
  '-': 333,
  '.': 278,
  '/': 278,
  '0': 556,
  '1': 556,
  '2': 556,
  '3': 556,
  '4': 556,
  '5': 556,
  '6': 556,
  '7': 556,
  '8': 556,
  '9': 556,
  ':': 278,
  ';': 278,
  '<': 584,
  '=': 584,
  '>': 584,
  '?': 556,
  '@': 1015,
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  '[': 278,
  '\\': 278,
  ']': 278,
  '^': 469,
  _: 556,
  '`': 333,
  a: 556,
  b: 556,
  c: 500,
  d: 556,
  e: 556,
  f: 278,
  g: 556,
  h: 556,
  i: 222,
  j: 222,
  k: 500,
  l: 222,
  m: 833,
  n: 556,
  o: 556,
  p: 556,
  q: 556,
  r: 333,
  s: 500,
  t: 278,
  u: 556,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 500,
  '{': 334,
  '|': 260,
  '}': 334,
  '~': 584,
  '—': 1000,
  '–': 556,
  '…': 1000,
  '\u2018': 222,
  '\u2019': 222,
  '\u201c': 333,
  '\u201d': 333,
  '•': 350,
};

// Times-Roman widths (standard AFM values for the characters we emit).
const TIMES: Record<string, number> = {
  ' ': 250,
  '!': 333,
  '"': 408,
  '#': 500,
  $: 500,
  '%': 833,
  '&': 778,
  "'": 180,
  '(': 333,
  ')': 333,
  '*': 500,
  '+': 564,
  ',': 250,
  '-': 333,
  '.': 250,
  '/': 278,
  '0': 500,
  '1': 500,
  '2': 500,
  '3': 500,
  '4': 500,
  '5': 500,
  '6': 500,
  '7': 500,
  '8': 500,
  '9': 500,
  ':': 278,
  ';': 278,
  '<': 564,
  '=': 564,
  '>': 564,
  '?': 444,
  '@': 921,
  A: 722,
  B: 667,
  C: 667,
  D: 722,
  E: 611,
  F: 556,
  G: 722,
  H: 722,
  I: 333,
  J: 389,
  K: 722,
  L: 611,
  M: 889,
  N: 722,
  O: 722,
  P: 556,
  Q: 722,
  R: 667,
  S: 556,
  T: 611,
  U: 722,
  V: 722,
  W: 944,
  X: 722,
  Y: 722,
  Z: 611,
  '[': 333,
  '\\': 278,
  ']': 333,
  '^': 469,
  _: 500,
  '`': 333,
  a: 444,
  b: 500,
  c: 444,
  d: 500,
  e: 444,
  f: 333,
  g: 500,
  h: 500,
  i: 278,
  j: 278,
  k: 500,
  l: 278,
  m: 778,
  n: 500,
  o: 500,
  p: 500,
  q: 500,
  r: 333,
  s: 389,
  t: 278,
  u: 500,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 444,
  '{': 480,
  '|': 200,
  '}': 480,
  '~': 541,
  '—': 1000,
  '–': 500,
  '…': 1000,
  '\u2018': 333,
  '\u2019': 333,
  '\u201c': 444,
  '\u201d': 444,
  '•': 350,
  '†': 500,
  '‡': 500,
  '€': 500,
  '™': 1000,
};

const WIDTHS: Record<PdfFontKey, Record<string, number>> = {
  helvetica: HELVETICA,
  times: TIMES,
  // Courier is monospaced: every glyph is 600/1000 em.
  courier: new Proxy({} as Record<string, number>, {
    get: () => 600,
  }),
};

export function textWidth(text: string, fontSize: number, font: PdfFontKey = 'helvetica'): number {
  const table = WIDTHS[font];
  let width = 0;
  for (const ch of text) {
    width += (table[ch] ?? 556) * (fontSize / 1000);
  }
  return width;
}

/** Split prose into visual lines that fit `maxWidth` at `fontSize`. */
export function wrapText(
  text: string,
  fontSize: number,
  maxWidth: number,
  font: PdfFontKey = 'helvetica',
): string[] {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const paragraph = raw.trimEnd();
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = '';
    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (textWidth(candidate, fontSize, font) <= maxWidth || current.length === 0) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current.length > 0) lines.push(current);
  }
  return lines;
}

// ---- Font selection ---------------------------------------------------------

export interface PdfFontPrefs {
  /** The reading font choice: 'georgia' | 'palatino' | 'charter' | 'serif' | 'sans'. */
  readingFont?: string;
  /** Per-format wardrobe choices: 'auto' | 'georgia' | ... | 'sans'. */
  documentFonts?: Record<string, string>;
}

/**
 * Map an app font choice to a base-14 PDF font. Serif choices (Georgia,
 * Palatino, Charter, system serif) all land on Times-Roman; sans on
 * Helvetica; map notes on Courier (their app default is monospace).
 */
export function pdfFontFor(prefs: PdfFontPrefs | undefined, document?: string): PdfFontKey {
  const choice = document ? (prefs?.documentFonts?.[document] ?? 'auto') : 'auto';
  if (choice === 'sans') return 'helvetica';
  if (choice !== 'auto') return 'times';
  if (document === 'mapnote') return 'courier';
  return prefs?.readingFont === 'sans' ? 'helvetica' : 'times';
}

// ---- The writer -------------------------------------------------------------

const PAGE_W = 432; // 6 in
const PAGE_H = 648; // 9 in
const MARGIN = 60;
const BODY_SIZE = 11;
const LEADING = 16.5;
/** The floor for auto-fitting: below this, prose becomes a footnote. */
const MIN_BODY_SIZE = 6.5;
/** Extra gap paginate leaves between wrapped visual lines. */
const LINE_GAP = 3;

interface TextLine {
  text: string;
  size: number;
  gapBefore?: number;
  center?: boolean;
  gray?: boolean;
  space?: boolean; // an empty spacer line
  font?: PdfFontKey;
}

function escapePdfString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\t/g, ' ');
}

/**
 * Render a list of lines into page-sized content streams. `leading` is the
 * height of a spacer (blank) line — fitted pages scale it with their font.
 */
function paginate(lines: TextLine[], streams: Uint8Array[], leading = LEADING): void {
  let y = PAGE_H - MARGIN;
  let ops: string[] = [];
  const flush = () => {
    streams.push(cp1252(`BT\n${ops.join('\n')}\nET`));
    ops = [];
    y = PAGE_H - MARGIN;
  };
  const maxWidth = PAGE_W - MARGIN * 2;
  for (const line of lines) {
    if (line.space) {
      y -= leading;
      if (y < MARGIN) flush();
      continue;
    }
    const font = line.font ?? 'helvetica';
    // EVERY line wraps — titles, seeds, mood lines, cast notes: nothing may
    // ever draw past the page edge.
    const pieces = wrapText(line.text, line.size, maxWidth, font);
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (piece === undefined || piece.length === 0) continue;
      const gap = i === 0 ? (line.gapBefore ?? 0) : 0;
      if (y - line.size - gap < MARGIN) flush();
      y -= line.size + gap;
      const color = line.gray ? '0.45 0.42 0.38 rg' : '0.13 0.11 0.09 rg';
      const x = line.center
        ? Math.max(MARGIN, (PAGE_W - textWidth(piece, line.size, font)) / 2)
        : MARGIN;
      ops.push(
        `BT /${FONT_REF[font]} ${line.size} Tf ${color} 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfString(piece)}) Tj ET`,
      );
      y -= LINE_GAP;
    }
  }
  flush();
}

/** Height a wrapped body occupies at `size`, mirroring paginate exactly. */
function bodyHeightAt(text: string, size: number, maxWidth: number, font: PdfFontKey): number {
  const leading = size * (LEADING / BODY_SIZE);
  let height = 0;
  for (const raw of text.split('\n')) {
    const paragraph = raw.trimEnd();
    if (paragraph.length === 0) {
      height += leading;
      continue;
    }
    height += wrapText(paragraph, size, maxWidth, font).length * (size + LINE_GAP);
  }
  return height;
}

/**
 * The largest body size in [MIN_BODY_SIZE, BODY_SIZE] for which the whole
 * book page — running head, spacer, and wrapped body — fits on ONE printed
 * page. Pages that cannot fit even at the floor keep the floor size and
 * overflow onto a second page (paginate handles it).
 */
function fitBodySize(text: string, font: PdfFontKey, maxWidth: number): number {
  const budget = PAGE_H - MARGIN * 2;
  const headerHeight = 9 + LINE_GAP; // the "Page N · mood" running head
  const heightAt = (size: number): number => {
    const leading = size * (LEADING / BODY_SIZE);
    return headerHeight + leading + bodyHeightAt(text, size, maxWidth, font);
  };
  if (heightAt(BODY_SIZE) <= budget) return BODY_SIZE;
  let lo = MIN_BODY_SIZE;
  let hi = BODY_SIZE;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(mid) <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function pdfBytes(compiled: CompiledBook, prefs?: PdfFontPrefs): Uint8Array {
  const streams: Uint8Array[] = [];
  const baseFont = pdfFontFor(prefs);
  const maxWidth = PAGE_W - MARGIN * 2;

  // Title page.
  const titleLines: TextLine[] = [
    { text: compiled.title, size: 22, gapBefore: 180, center: true, font: baseFont },
    {
      text: 'A book directed page by page in Page Turn',
      size: 11,
      gapBefore: 26,
      center: true,
      gray: true,
      font: baseFont,
    },
  ];
  if (compiled.seed) {
    titleLines.push({
      text: `Seed: ${compiled.seed}`,
      size: 10,
      gapBefore: 18,
      center: true,
      gray: true,
      font: baseFont,
    });
  }
  const mood = compiled.pages
    .map((page) =>
      page.mood
        ? `${page.kind === 'prologue' ? 'Prologue' : `Page ${page.number}`} ${page.mood.label} ${page.mood.value > 0 ? '+' : ''}${page.mood.value}`
        : null,
    )
    .filter((m): m is string => m !== null)
    .join('  ·  ');
  if (mood) {
    titleLines.push({
      text: mood,
      size: 9,
      gapBefore: 14,
      center: true,
      gray: true,
      font: baseFont,
    });
  }
  paginate(titleLines, streams);

  // Chapters: each book page fits ONE printed page (font auto-fitted).
  for (const page of compiled.pages) {
    const font = pdfFontFor(prefs, page.document);
    const size = fitBodySize(page.text, font, maxWidth);
    const leading = size * (LEADING / BODY_SIZE);
    const lines: TextLine[] = [
      {
        text: `${page.kind === 'prologue' ? 'Prologue' : `Page ${page.number}`}${page.mood ? `   ·   ${page.mood.label} ${page.mood.value > 0 ? '+' : ''}${page.mood.value}` : ''}`,
        size: 9,
        gray: true,
        font,
      },
      { text: '', size, gapBefore: 8, space: true },
      ...wrapText(page.text, size, maxWidth, font).map((text) => ({
        text,
        size,
        space: text.length === 0,
        font,
      })),
    ];
    paginate(lines, streams, leading);
  }

  // Cast appendix (flows after the last page).
  if (compiled.cast) {
    const lines: TextLine[] = [{ text: 'The cast', size: 16, gapBefore: 24, font: baseFont }];
    const group = (
      label: string,
      entries: Array<{ name: string; note: string; details?: string }>,
    ) => {
      if (entries.length === 0) return;
      lines.push({ text: label, size: 12, gapBefore: 12, font: baseFont });
      for (const entry of entries) {
        const note = entry.note ? ` — ${entry.note}` : '';
        const details = entry.details ? ` (${entry.details})` : '';
        lines.push({ text: `${entry.name}${note}${details}`, size: 10, font: baseFont });
      }
    };
    group('People', compiled.cast.people);
    group('Places', compiled.cast.places);
    group('Things', compiled.cast.things);
    group('Open threads', compiled.cast.threads);
    paginate(lines, streams);
  }

  if (compiled.endingNote) {
    paginate([{ text: 'The End', size: 14, gapBefore: 40, center: true, font: baseFont }], streams);
  }

  return assemblePdf(streams);
}

/**
 * Assemble the PDF skeleton around prebuilt content streams. Three base-14
 * fonts are always declared (Helvetica, Times-Roman, Courier) so streams can
 * mix the app's font selection without any embedded font files.
 */
export function assemblePdf(streams: Uint8Array[]): Uint8Array {
  const encoder = new TextEncoder();
  const pageCount = streams.length;
  const catalogNum = 1;
  const pagesNum = 2;
  const firstPageNum = 3;
  const firstStreamNum = firstPageNum + pageCount;
  const helveticaNum = firstStreamNum + pageCount;
  const timesNum = helveticaNum + 1;
  const courierNum = helveticaNum + 2;
  const lastObjectNum = courierNum;

  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    offset += bytes.length;
  };
  const object = (num: number, body: Uint8Array) => {
    offsets[num] = offset;
    push(encoder.encode(`${num} 0 obj\n`));
    push(body);
    push(encoder.encode('\nendobj\n'));
  };

  push(encoder.encode('%PDF-1.4\n'));

  object(catalogNum, encoder.encode('<< /Type /Catalog /Pages 2 0 R >>'));
  const kids = Array.from({ length: pageCount }, (_, i) => `${firstPageNum + i} 0 R`).join(' ');
  object(pagesNum, encoder.encode(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`));

  for (let i = 0; i < pageCount; i++) {
    const contentNum = firstStreamNum + i;
    object(
      firstPageNum + i,
      encoder.encode(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${helveticaNum} 0 R /F2 ${timesNum} 0 R /F3 ${courierNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
      ),
    );
  }
  streams.forEach((stream, i) => {
    object(
      firstStreamNum + i,
      (() => {
        const head = encoder.encode(`<< /Length ${stream.length} >>\nstream\n`);
        const tail = encoder.encode('\nendstream');
        const out = new Uint8Array(head.length + stream.length + tail.length);
        out.set(head, 0);
        out.set(stream, head.length);
        out.set(tail, head.length + stream.length);
        return out;
      })(),
    );
  });
  for (const [num, name] of [
    [helveticaNum, 'Helvetica'],
    [timesNum, 'Times-Roman'],
    [courierNum, 'Courier'],
  ] as const) {
    object(
      num,
      encoder.encode(
        `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`,
      ),
    );
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${lastObjectNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= lastObjectNum; i++) {
    xref += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${lastObjectNum + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  push(encoder.encode(xref));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
