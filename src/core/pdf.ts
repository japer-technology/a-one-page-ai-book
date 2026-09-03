/**
 * core/pdf.ts — compile a book into a print-ready PDF, dependency-free.
 *
 * A minimal PDF 1.4 writer: Helvetica/WinAnsi, 6×9 inch pages, word-wrapped
 * body text, title page, one chapter per book page (overflow paginates), the
 * mood map and the cast appendix. Pure functions returning bytes, so the
 * writer is unit-testable without a browser.
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

// ---- Helvetica widths (1/1000 em, condensed approximations) -----------------

const WIDTHS: Record<string, number> = {
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
};

export function textWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    width += (WIDTHS[ch] ?? 556) * (fontSize / 1000);
  }
  return width;
}

/** Split prose into visual lines that fit `maxWidth` at `fontSize`. */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
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
      if (textWidth(candidate, fontSize) <= maxWidth || current.length === 0) {
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

// ---- The writer -------------------------------------------------------------

const PAGE_W = 432; // 6 in
const PAGE_H = 648; // 9 in
const MARGIN = 60;
const BODY_SIZE = 11;
const LEADING = 16.5;

interface TextLine {
  text: string;
  size: number;
  gapBefore?: number;
  center?: boolean;
  gray?: boolean;
  space?: boolean; // an empty spacer line
}

function escapePdfString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Render a list of lines into page-sized content streams. */
function paginate(lines: TextLine[], streams: Uint8Array[]): void {
  let y = PAGE_H - MARGIN;
  let ops: string[] = [];
  const flush = () => {
    streams.push(cp1252(`BT\n${ops.join('\n')}\nET`));
    ops = [];
    y = PAGE_H - MARGIN;
  };
  for (const line of lines) {
    const height = line.size + (line.gapBefore ?? 0) + 3;
    if (line.space) {
      y -= LEADING;
      continue;
    }
    if (y - height < MARGIN) flush();
    y -= line.size + (line.gapBefore ?? 0);
    const color = line.gray ? '0.45 0.42 0.38 rg' : '0.13 0.11 0.09 rg';
    const x = line.center ? (PAGE_W - textWidth(line.text, line.size)) / 2 : MARGIN;
    ops.push(
      `BT /F1 ${line.size} Tf ${color} 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfString(line.text)}) Tj ET`,
    );
    y -= 3;
  }
  flush();
}

export function pdfBytes(compiled: CompiledBook): Uint8Array {
  const streams: Uint8Array[] = [];

  // Title page.
  const titleLines: TextLine[] = [
    { text: compiled.title, size: 22, gapBefore: 180, center: true },
    {
      text: 'A book directed page by page in Page Turn',
      size: 11,
      gapBefore: 26,
      center: true,
      gray: true,
    },
  ];
  if (compiled.seed) {
    titleLines.push({
      text: `Seed: ${compiled.seed}`,
      size: 10,
      gapBefore: 18,
      center: true,
      gray: true,
    });
  }
  const mood = compiled.pages
    .map((page) =>
      page.mood
        ? `Page ${page.number} ${page.mood.label} ${page.mood.value > 0 ? '+' : ''}${page.mood.value}`
        : null,
    )
    .filter((m): m is string => m !== null)
    .join('  ·  ');
  if (mood) titleLines.push({ text: mood, size: 9, gapBefore: 14, center: true, gray: true });
  paginate(titleLines, streams);

  // Chapters.
  for (const page of compiled.pages) {
    const lines: TextLine[] = [
      {
        text: `Page ${page.number}${page.mood ? `   ·   ${page.mood.label} ${page.mood.value > 0 ? '+' : ''}${page.mood.value}` : ''}`,
        size: 9,
        gray: true,
      },
      { text: '', size: BODY_SIZE, gapBefore: 8, space: true },
      ...wrapText(page.text, BODY_SIZE, PAGE_W - MARGIN * 2).map((text) => ({
        text,
        size: BODY_SIZE,
        space: text.length === 0,
      })),
    ];
    paginate(lines, streams);
  }

  // Cast appendix (flows after the last page).
  if (compiled.cast) {
    const lines: TextLine[] = [{ text: 'The cast', size: 16, gapBefore: 24 }];
    const group = (
      label: string,
      entries: Array<{ name: string; note: string; details?: string }>,
    ) => {
      if (entries.length === 0) return;
      lines.push({ text: label, size: 12, gapBefore: 12 });
      for (const entry of entries) {
        const note = entry.note ? ` — ${entry.note}` : '';
        const details = entry.details ? ` (${entry.details})` : '';
        lines.push({ text: `${entry.name}${note}${details}`, size: 10 });
      }
    };
    group('People', compiled.cast.people);
    group('Places', compiled.cast.places);
    group('Things', compiled.cast.things);
    group('Open threads', compiled.cast.threads);
    paginate(lines, streams);
  }

  if (compiled.endingNote) {
    paginate([{ text: 'The End', size: 14, gapBefore: 40, center: true }], streams);
  }

  return assemblePdf(streams);
}

/** Assemble the PDF skeleton around prebuilt content streams. */
export function assemblePdf(streams: Uint8Array[]): Uint8Array {
  const encoder = new TextEncoder();
  const pageCount = streams.length;
  const catalogNum = 1;
  const pagesNum = 2;
  const firstPageNum = 3;
  const firstStreamNum = firstPageNum + pageCount;
  const fontNum = firstStreamNum + pageCount;

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
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
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
  object(
    fontNum,
    encoder.encode(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ),
  );

  const xrefOffset = offset;
  let xref = `xref\n0 ${fontNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= fontNum; i++) {
    xref += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${fontNum + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
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
