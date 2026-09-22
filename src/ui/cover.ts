/**
 * ui/cover.ts — procedural book covers, painted on canvas. Deterministic per
 * title (a hash picks the palette and ornament), tinted by the book's
 * dominant mood. No images, no fonts beyond the app's own stacks.
 */
import type { CompiledBook } from '../core/compile';

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h;
}

const PALETTES: Array<[string, string, string]> = [
  ['#2b1d2f', '#7a4e7a', '#e8c47a'],
  ['#122a33', '#2f6f7a', '#d9a94e'],
  ['#2c1f1a', '#7a5230', '#e8c47a'],
  ['#1d2b22', '#4f7a5c', '#d9c58a'],
  ['#23203a', '#5c5a8a', '#e8c47a'],
  ['#331d22', '#8a4e5c', '#e8c47a'],
];

export function coverFor(compiled: CompiledBook): {
  palette: [string, string, string];
  hue: number;
} {
  const h = hash(compiled.title);
  const palette = PALETTES[h % PALETTES.length] ?? PALETTES[0]!;
  return { palette, hue: h % 360 };
}

/** Paint the cover. The canvas backing store should be 2× the CSS size. */
export function paintCover(canvas: HTMLCanvasElement, compiled: CompiledBook): void {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { palette } = coverFor(compiled);
  const [bg, mid, accent] = palette;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Ornament: concentric arcs seeded by the title.
  ctx.strokeStyle = mid;
  ctx.lineWidth = Math.max(2, W / 120);
  const cx = W / 2;
  const cy = H * 0.4;
  for (let i = 0; i < 4; i++) {
    ctx.globalAlpha = 0.5 - i * 0.1;
    ctx.beginPath();
    ctx.arc(cx, cy, H * (0.16 + i * 0.09), -Math.PI * 0.8, Math.PI * 0.2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Mood tint.
  const mood = compiled.pages.map((p) => p.mood).find((m) => m !== undefined);
  if (mood) {
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(W * 0.82, H * 0.2, H * 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Title.
  ctx.fillStyle = '#f2e9d8';
  ctx.textAlign = 'center';
  ctx.font = `600 ${Math.round(W / 9)}px Georgia, serif`;
  const words = compiled.title.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > W * 0.78 && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  let y = H * 0.62;
  for (const line of lines.slice(0, 4)) {
    ctx.fillText(line, cx, y, W * 0.84);
    y += W / 7.5;
  }

  // Footer.
  ctx.fillStyle = accent;
  ctx.font = `italic ${Math.round(W / 16)}px Georgia, serif`;
  ctx.fillText('a Page Turn book', cx, H * 0.9);
}
