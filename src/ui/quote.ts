/**
 * ui/quote.ts — share a page as a beautiful quote card: typography-first,
 * rendered to a canvas at 2× resolution and downloaded as a PNG. No network,
 * no fonts — the card uses the app's own serif stack.
 */
import type { CompiledBook } from '../core/compile';

export interface QuoteCardInput {
  title: string;
  pageNumber: number;
  text: string;
  mood?: { icon: string; label: string; value: number };
}

function cssVar(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

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

  const paper = cssVar('--paper', '#f2e9d8');
  const ink = cssVar('--ink', '#1c1712');
  const accent = cssVar('--accent', '#e8c47a');
  const bg = cssVar('--bg-card', '#211b16');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = paper;
  ctx.fillRect(48, 48, W - 96, H - 96);

  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.font = '600 44px Georgia, serif';
  ctx.fillText(input.title, W / 2, 140, W - 160);

  ctx.fillStyle = accent;
  ctx.font = '28px Georgia, serif';
  const moodLine = input.mood
    ? `${input.mood.icon} ${input.mood.label} ${input.mood.value > 0 ? '+' : ''}${input.mood.value}`
    : '';
  ctx.fillText(`Page ${input.pageNumber}${moodLine ? ` · ${moodLine}` : ''}`, W / 2, 190, W - 160);

  // Trim overlong pages to a card-friendly length.
  let text = input.text.trim();
  const words = text.split(/\s+/);
  if (words.length > 240) {
    text = words.slice(0, 240).join(' ') + ' …';
  }

  ctx.textAlign = 'left';
  ctx.font = '34px Georgia, serif';
  const lines = wrapToWidth(ctx, text, W - 260);
  const lineHeight = 54;
  let y = 280;
  for (const line of lines) {
    if (y > H - 260) break;
    if (line.length === 0) {
      y += lineHeight * 0.6;
      continue;
    }
    ctx.fillText(line, 130, y, W - 260);
    y += lineHeight;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = accent;
  ctx.font = 'italic 24px Georgia, serif';
  ctx.fillText('— a page directed in Page Turn —', W / 2, H - 90);

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
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
