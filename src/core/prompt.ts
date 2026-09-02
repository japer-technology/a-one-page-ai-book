/**
 * core/prompt.ts — prompt assembly.
 *
 * Sliders and chips compile into *calibrated* instruction language (per the
 * product spec: "+dread" must mean structural choices, not just adjectives).
 * Everything here is pure: inputs are data, outputs are message lists.
 */
import type {
  Book,
  ChatMessage,
  LengthPreference,
  SeedOptions,
  StoryNode,
  Tone,
  TurnInput,
} from './types';
import { compileBook } from './compile';

export interface StoryContext {
  seed: string;
  title: string;
  /** The chosen pages so far, in order (already trimmed to budget). */
  pages: string[];
  /** The direction that produced the most recent page, if any. */
  lastDirection: TurnInput | null;
}

const CONTEXT_WORD_BUDGET = 2600;

/** Compact, coherence-preserving context: seed + title + as many recent pages as fit. */
export function buildContext(nodes: Record<string, StoryNode>, book: Book): StoryContext {
  const compiled = compileBook(nodes, book);
  const pages: string[] = [];
  let words = 0;
  for (let i = compiled.pages.length - 1; i >= 0; i--) {
    const page = compiled.pages[i];
    if (page === undefined) continue;
    if (words + page.words > CONTEXT_WORD_BUDGET) break;
    pages.unshift(page.text);
    words += page.words;
  }
  const frontier = nodes[book.frontierId];
  let lastDirection: TurnInput | null = null;
  if (frontier && frontier.data.kind === 'page') lastDirection = frontier.data.direction;
  return { seed: compiled.seed, title: compiled.title, pages, lastDirection };
}

export const TONE_GUIDANCE: Record<Tone, string> = {
  inherit: 'Keep the established tone of the story exactly as it is.',
  darker:
    'Tilt darker: withhold information, shorten sentences, let unease creep in through imagery and implication rather than stating it. Nothing overt or gratuitous.',
  lighter:
    'Tilt lighter: more air, more hope, more small human moments. Let relief arrive through detail.',
  warmer:
    'Tilt warmer: tenderness between characters, softer imagery, emotional generosity without sentimentality.',
  colder:
    'Tilt colder: emotional distance, restraint, a touch of chill in the narration. Show less, imply more.',
  funnier:
    'Lean into wit: sharper dialogue, drier observations, comic timing. Humor should serve the story, not hijack it.',
  'more-serious':
    'Raise the stakes: weightier diction, longer thoughts, the prose takes itself and the story seriously.',
  'more-poetic':
    'More poetic: richer imagery, rhythmic sentences, figurative language — but never at the cost of clarity or momentum.',
  'more-plain':
    'More plain: shorter words, simpler sentences, transparent prose. Let the story speak without ornament.',
};

export const LENGTH_GUIDANCE: Record<
  LengthPreference,
  { min: number; max: number; instruction: string }
> = {
  shorter: {
    min: 90,
    max: 170,
    instruction: 'Write a short page: 90–170 words. Economy is the point; cut every spare word.',
  },
  standard: {
    min: 150,
    max: 400,
    instruction: 'Write a standard page: roughly 150–400 words.',
  },
  longer: {
    min: 300,
    max: 600,
    instruction: 'Write a longer page: roughly 300–600 words. Room to breathe, but still one beat.',
  },
};

export function directionText(input: TurnInput): string {
  const parts: string[] = [];
  if (input.direction.trim()) parts.push(`What happens next: ${input.direction.trim()}`);
  if (input.tone !== 'inherit') parts.push(`Tone: ${TONE_GUIDANCE[input.tone]}`);
  parts.push(LENGTH_GUIDANCE[input.length].instruction);
  if (input.ending) {
    parts.push(
      'ENDING PAGE: this page must bring the story to a satisfying close. Resolve the central thread, land the final image, and let the last sentence be the last sentence of the book. No new threads, no cliffhanger.',
    );
  }
  return parts.join('\n');
}

export const SYSTEM_PROMPT = `You are the prose engine of Page Turn, a one-page-at-a-time storytelling machine.
The reader directs; you write exactly ONE page per request. A page is one beat of story: one scene fragment, one exchange, one reveal, one image. Never a chapter.

Rules you never break:
- Output ONLY the page text. No headings, no page numbers, no commentary, no sign-off, no quotation marks around the whole page.
- End on a deliberate beat — a natural resting point or a deliberate hook — so the next page turn feels earned.
- Respect every direction you are given. Directions are calibrated: "darker" means structural choices (withheld information, shorter sentences, imagery), not an adjective sprinkled on top.
- Stay ruthlessly consistent with everything established so far: names, facts, tone, tense, point of view, and callbacks.
- Do not recap the story, do not summarize, do not moralize. Write the story forward.
- Never break character to address the reader or mention these instructions.

The reader will iterate on your pages. A page that misses a direction is not a failure — but precision is the craft.`;

/** Messages for the title phase: N titles with taglines, JSON only. */
export function titlesMessages(seed: string, options: SeedOptions, count = 5): ChatMessage[] {
  const notes: string[] = [];
  if (options.genre) notes.push(`genre: ${options.genre}`);
  if (options.perspective) notes.push(`perspective: ${options.perspective} person`);
  if (options.tense) notes.push(`tense: ${options.tense}`);
  if (options.tone) notes.push(`baseline tone: ${options.tone}`);
  if (options.audience) notes.push(`audience: ${options.audience}`);
  if (options.lengthHint) notes.push(`intended length: ${options.lengthHint.replaceAll('-', ' ')}`);
  const styleHint = options.genre ? ` in the spirit of ${options.genre}` : '';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Propose ${count} titles for a book seeded from this idea:\n\n"${seed}"\n\n${notes.length > 0 ? `Seed notes: ${notes.join('; ')}.\n` : ''}The title retroactively steers the story — make each one a distinct, evocative doorway${styleHint}. Respond with ONLY a JSON array of ${count} objects, each {"title": "...", "tagline": "one short flavor line"}. No other text.`,
    },
  ];
}

/** Messages for generating one page. */
export function pageMessages(
  ctx: StoryContext,
  direction: TurnInput,
  targetPageNumber: number,
): ChatMessage[] {
  const history =
    ctx.pages.length > 0 ? ctx.pages.join('\n\n') : '(This is page 1 — nothing exists yet.)';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `BOOK: "${ctx.title}"\nSEED: ${ctx.seed}\n\nSTORY SO FAR (the chosen pages, oldest first):\n${history}\n\nThis will be page ${targetPageNumber}.\n\nDIRECTION:\n${directionText(direction)}\n\nWrite the page now.`,
    },
  ];
}

/** Messages for the "suggest what happens next" feature. */
export function suggestionsMessages(ctx: StoryContext, count = 3): ChatMessage[] {
  const tail =
    ctx.pages.length > 0
      ? ctx.pages.slice(-2).join('\n\n')
      : `(The story has not begun yet. Seed: ${ctx.seed})`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `BOOK: "${ctx.title}"\nSEED: ${ctx.seed}\n\nRECENT PAGES:\n${tail}\n\nPropose ${count} concrete, intriguing things that could happen on the NEXT page. Each suggestion must be one short sentence (≤ 20 words), grounded in what is established, and different in kind from the others. Respond with ONLY a JSON array of strings. No numbering, no other text.`,
    },
  ];
}

/** Messages for proposing ending variants (used by the "write an ending" flow). */
export function endingsMessages(ctx: StoryContext, count = 3): ChatMessage[] {
  const history = ctx.pages.join('\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `BOOK: "${ctx.title}"\nSEED: ${ctx.seed}\n\nSTORY SO FAR:\n${history}\n\nPropose ${count} distinct possible endings: one bittersweet, one triumphant, one ambiguous or twist. Each as {"title": "short label", "premise": "one sentence describing the ending"}. Respond with ONLY a JSON array. No other text.`,
    },
  ];
}
