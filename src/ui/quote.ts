/**
 * ui/quote.ts — share a page as a beautiful quote card: typography-first,
 * rendered to a canvas at 2× resolution and downloaded as a PNG. The card
 * uses its own FIXED print palette (cream paper, near-black ink, deep gold)
 * so contrast is excellent in every theme. No network, no fonts beyond the
 * system serif stack.
 */
import type { CompiledBook } from '../core/compile';

export interface QuoteCardInput {
  title: string;
  pageNumber: number;
  text: string;
  mood?: { icon: string; label: string; value: number };
}

// Fixed print palette — deliberately independent of the app theme.
const PLAQUE = '#17110b';
const PAPER = '#f6eedd';
const INK = '#211b12';
const ACCENT = '#7a5810';
const MUTED = '#6b5c40';

/** Wrap prose to a pixel width using canvas measurement. */
function wrapToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
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
      if (ctx.measureText(candidate).width <= maxWidth || current.length === 0) {
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

export function renderQuoteCard(input: QuoteCardInput): HTMLCanvasElement {
  const W = 1200;
  const H = 1500;
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.scale(scale, scale);

  // Plaque + card with a soft shadow.
  ctx.fillStyle = PLAQUE;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(70, 78, W - 140, H - 140);
  ctx.fillStyle = PAPER;
  ctx.fillRect(52, 56, W - 104, H - 112);

  // Ornament rule.
  ctx.fillStyle = ACCENT;
  ctx.fillRect(W / 2 - 140, 120, 280, 3);

  // Title — dark ink on cream: maximum contrast.
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.font = '600 46px Georgia, serif';
  const titleWords = input.title.split(/\s+/);
  const titleLines: string[] = [];
  let current = '';
  for (const word of titleWords) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > W - 220 && current) {
      titleLines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) titleLines.push(current);
  let y = 190;
  for (const line of titleLines.slice(0, 3)) {
    ctx.fillText(line, W / 2, y, W - 200);
    y += 58;
  }

  // Mood line — deep gold (readable on cream).
  ctx.fillStyle = ACCENT;
  ctx.font = '600 26px Georgia, serif';
  const moodLine = input.mood
    ? `Page ${input.pageNumber} · ${input.mood.icon} ${input.mood.label} ${input.mood.value > 0 ? '+' : ''}${input.mood.value}`
    : `Page ${input.pageNumber}`;
  ctx.fillText(moodLine, W / 2, y + 20, W - 200);

  // Trim overlong pages to a card-friendly length.
  let text = input.text.trim();
  const words = text.split(/\s+/);
  if (words.length > 220) {
    text = words.slice(0, 220).join(' ') + ' …';
  }

  // Body — dark ink, generous line height.
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = '33px Georgia, serif';
  const lines = wrapToWidth(ctx, text, W - 260);
  let by = y + 96;
  for (const line of lines) {
    if (by > H - 250) break;
    if (line.length === 0) {
      by += 30;
      continue;
    }
    ctx.fillText(line, 130, by, W - 260);
    by += 54;
  }

  // Footer.
  ctx.textAlign = 'center';
  ctx.fillStyle = MUTED;
  ctx.font = 'italic 23px Georgia, serif';
  ctx.fillText('— a page directed in Page Turn —', W / 2, H - 96);

  return canvas;
}

export function downloadQuoteCard(input: QuoteCardInput, fileName: string): void {
  const canvas = renderQuoteCard(input);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }, 'image/png');
}

export function quoteCardFor(compiled: CompiledBook, pageNumber: number): void {
  const page = compiled.pages.find((p) => p.number === pageNumber);
  if (!page) return;
  const slug = compiled.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  downloadQuoteCard(
    { title: compiled.title, pageNumber: page.number, text: page.text, mood: page.mood },
    `${slug || 'book'}-page-${page.number}-card.png`,
  );
}
