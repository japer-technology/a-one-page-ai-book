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
  EmotionName,
  LengthPreference,
  SeedOptions,
  StoryBible,
  StoryNode,
  Tone,
  TurnInput,
} from './types';
import { compileBook, countWords } from './compile';
import { bibleUpTo, pathToRoot, summaryUpTo } from './tree';

export interface StoryContext {
  seed: string;
  title: string;
  /** The chosen pages so far, in order (already trimmed to budget). */
  pages: string[];
  /** The direction that produced the most recent page, if any. */
  lastDirection: TurnInput | null;
  /** The distilled pre-writing brief, if the reader made one. */
  brief?: string;
  /** The living cast as known along this path (drives name consistency). */
  cast?: StoryBible;
  /** The rolling story summary as known along this path (long-term memory). */
  summary?: string;
}

const CONTEXT_WORD_BUDGET = 2600;
const BIBLE_WORD_BUDGET = 2200;
/** Pages folded into one summary update (the fast-model memory call). */
const SUMMARY_WORD_BUDGET = 2200;
/** Verbatim recent pages always keep at least this much room, whatever the fixed blocks cost. */
const MIN_PAGE_WORDS = 500;
/** The summary's own target size: compact enough to be cheap memory. */
export const SUMMARY_MAX_WORDS = 300;

/** Compact, coherence-preserving context: seed + title + as many recent pages as fit. */
export function buildContext(nodes: Record<string, StoryNode>, book: Book): StoryContext {
  return buildContextTo(nodes, book, book.frontierId);
}

/** Context compiled along the path up to a specific node (used for cast updates). */
export function buildContextTo(
  nodes: Record<string, StoryNode>,
  book: Book,
  toNodeId: string,
): StoryContext {
  const path = pathToRoot(nodes, toNodeId);
  const compiled = compileBook(nodes, book);
  const titleNode = path.find((n) => n.kind === 'title');
  const seedNode = path.find((n) => n.kind === 'seed');
  const pages: Array<{ text: string; words: number }> = [];
  for (const node of path) {
    if (node.kind !== 'page' || node.data.kind !== 'page') continue;
    const version = node.data.versions[node.data.chosenVersion - 1];
    if (!version) continue;
    pages.push({ text: version.text, words: countWords(version.text) });
  }
  const brief = seedNode && seedNode.data.kind === 'seed' ? seedNode.data.brief : '';
  const cast = bibleUpTo(nodes, toNodeId)?.bible;
  const summary = summaryUpTo(nodes, toNodeId)?.summary;
  const seedText = seedNode && seedNode.data.kind === 'seed' ? seedNode.data.text : compiled.seed;
  const titleText =
    titleNode && titleNode.data.kind === 'title' ? titleNode.data.title : compiled.title;
  // Two-tier memory, budget-redesigned: the fixed blocks (seed, title, brief,
  // summary, cast) are sized FIRST; the verbatim recent pages fill whatever
  // remains. The summary replaces the OLDEST pages, never the recent ones.
  let fixedWords = countWords(seedText) + countWords(titleText);
  if (brief) fixedWords += countWords(briefText(brief));
  if (cast) fixedWords += countWords(castText(cast));
  if (summary) fixedWords += countWords(summaryText(summary));
  const pagesBudget = Math.max(CONTEXT_WORD_BUDGET - fixedWords, MIN_PAGE_WORDS);
  const trimmed: string[] = [];
  let words = 0;
  for (let i = pages.length - 1; i >= 0; i--) {
    const page = pages[i];
    if (page === undefined) continue;
    if (words + page.words > pagesBudget) break;
    trimmed.unshift(page.text);
    words += page.words;
  }
  let lastDirection: TurnInput | null = null;
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i];
    if (node && node.data.kind === 'page') {
      lastDirection = node.data.direction;
      break;
    }
  }
  return {
    seed: seedText,
    title: titleText,
    pages: trimmed,
    lastDirection,
    brief: brief.length > 0 ? brief : undefined,
    cast,
    summary,
  };
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

/**
 * The emotion dials (§7.3). Each dial maps to *structural* narrative choices,
 * not adjectives: "dread +2" means creeping unease, withheld information,
 * shorter sentences — a tilt, never a jump-cut.
 */
export const EMOTION_META: Record<
  EmotionName,
  { icon: string; label: string; more: string; less: string }
> = {
  tension: {
    icon: '🕯️',
    label: 'Tension',
    more: 'Raise suspense: withhold the answer, shorten sentences, delay the reveal, end on a taut image.',
    less: 'Release suspense: resolve a thread, let the scene breathe, land on a calmer beat.',
  },
  wonder: {
    icon: '✨',
    label: 'Wonder',
    more: 'More awe: unexpected beauty, scale, imagery that opens the world wider.',
    less: 'Less awe: keep it grounded, mundane, close to the ordinary.',
  },
  warmth: {
    icon: '🤍',
    label: 'Warmth',
    more: 'More tenderness: small kindnesses between characters, softer details, emotional generosity without sentimentality.',
    less: 'Less warmth: emotional distance, restraint, characters keep to themselves.',
  },
  dread: {
    icon: '🕳️',
    label: 'Dread',
    more: 'Deepen dread: creeping unease, wrongness in the ordinary, implication over statement, nothing overt.',
    less: 'Lighten the dread: defuse the fear, let safety and steadiness return.',
  },
  humor: {
    icon: '😏',
    label: 'Humor',
    more: 'More wit: sharper dialogue, drier observations, comic timing that serves the scene.',
    less: 'Play it straight: no jokes, no irony, no comic relief.',
  },
  sadness: {
    icon: '🌧️',
    label: 'Sadness',
    more: 'More melancholy: loss, longing, quiet grief between the lines.',
    less: 'Lift the melancholy: lean on hope and forward motion.',
  },
  romance: {
    icon: '🖤',
    label: 'Romance',
    more: 'More longing: glances, unspoken want, charged proximity, tension between two people.',
    less: 'Keep romance out of it: no flirtation, no charged glances.',
  },
  joy: {
    icon: '☀️',
    label: 'Joy',
    more: 'More delight: earned happiness, small victories, moments of grace.',
    less: 'Dim the joy: sober, restrained, no celebration.',
  },
  mystery: {
    icon: '❓',
    label: 'Mystery',
    more: 'More curiosity: new questions, strange details that suggest hidden patterns, secrets half-seen.',
    less: 'Answer questions: make things clearer, close loops, explain.',
  },
  menace: {
    icon: '⚠️',
    label: 'Menace',
    more: 'More danger: a threat with teeth, stakes that could actually bite, violence in the air.',
    less: 'Defuse the threat: nothing truly dangerous here, the peril recedes.',
  },
};

const MAGNITUDE: Record<number, string> = { 1: 'slightly', 2: 'clearly', 3: 'strongly' };

export function emotionInstruction(name: EmotionName, value: number): string {
  const meta = EMOTION_META[name];
  const magnitude = MAGNITUDE[Math.abs(value)] ?? 'slightly';
  const guidance = value > 0 ? meta.more : meta.less;
  return `${meta.label}: ${magnitude} ${guidance}`;
}

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
  for (const [name, value] of Object.entries(input.emotions)) {
    if (!value) continue;
    if (!(name in EMOTION_META)) continue;
    parts.push(`Emotion dial: ${emotionInstruction(name as EmotionName, value)}`);
  }
  parts.push(
    input.sizeTarget
      ? sizeTargetInstruction(input.sizeTarget)
      : LENGTH_GUIDANCE[input.length].instruction,
  );
  if (input.document !== 'story') {
    parts.push(DOCUMENT_GUIDANCE[input.document]);
  }
  if (input.chapter === 'start') {
    parts.push(
      'CHAPTER BREAK: begin this page with a chapter heading on its own line (like "Chapter Three — A Short Evocative Title"), then write the page as the chapter\u2019s opening.',
    );
  }
  if (input.chapter === 'close') {
    parts.push(
      'BRING THIS CHAPTER TO A CLOSE: within this page, land the current chapter\u2019s thread on a chapter-ending beat — a natural resting point, not the end of the whole story.',
    );
  }
  if (input.ending) {
    parts.push(
      'ENDING PAGE: this page must bring the story to a satisfying close. Resolve the central thread, land the final image, and let the last sentence be the last sentence of the book. No new threads, no cliffhanger.',
    );
  }
  return parts.join('\n');
}

export const DOCUMENT_GUIDANCE: Record<Exclude<TurnInput['document'], 'story'>, string> = {
  letter:
    'DOCUMENT: write this page as a diegetic LETTER — open with a salutation ("Dearest Mara,"), body in the writer\u2019s voice, close with a sign-off. The letter IS the page.',
  diary:
    'DOCUMENT: write this page as a DIARY ENTRY — a short date line first, then first-person reflection on the day\u2019s events, intimate and unpolished.',
  newspaper:
    'DOCUMENT: write this page as a NEWSPAPER CLIPPING — a headline line in capitals, a byline, then short factual paragraphs of reportage. No first person.',
  mapnote:
    'DOCUMENT: write this page as MAP MARGINALIA — terse field notes tied to places and directions ("north of the cove the trees thin"), fragments, arrows of thought.',
  recipe:
    'DOCUMENT: write this page as a RECIPE — a title line, an ingredients list, numbered steps, and a short personal note at the end about who it is for.',
};

export function rulesText(rules: string[]): string {
  if (rules.length === 0) return '';
  return `STANDING RULES (apply to this page and every future page — never silently drop them):\n${rules
    .map((rule) => `- ${rule}`)
    .join('\n')}`;
}

/** Precise page sizing: word / paragraph / character targets, calibrated. */
export function sizeTargetInstruction(target: TurnInput['sizeTarget']): string {
  if (!target) return LENGTH_GUIDANCE.standard.instruction;
  const { kind, value } = target;
  if (kind === 'words') {
    return `Write a page of about ${value} words (roughly ${Math.max(1, Math.round(value / 110))}–${Math.max(2, Math.round(value / 70))} paragraphs). Hit that length as closely as the story allows.`;
  }
  if (kind === 'paragraphs') {
    return `Write a page of exactly ${value} paragraph${value === 1 ? '' : 's'}, each separated by a blank line. Let each paragraph carry one beat.`;
  }
  return `Write a page of about ${value} characters (spaces included) — roughly ${Math.max(1, Math.round(value / 6))} words. Hit that length as closely as the story allows.`;
}

/** The cast, compacted into instruction language (drives name consistency). */
export function castText(cast: StoryBible | undefined): string {
  if (!cast) return '';
  const lines: string[] = [];
  const group = (label: string, entries: StoryBible['people']) => {
    if (entries.length === 0) return;
    lines.push(
      `${label}: ${entries.map((e) => (e.note ? `${e.name} (${e.note})` : e.name)).join('; ')}`,
    );
  };
  group('People', cast.people);
  group('Places', cast.places);
  group('Things', cast.things);
  if (cast.threads.length > 0) {
    lines.push(
      `Open threads to advance or resolve (never drop them silently): ${cast.threads
        .map((t) => (t.note ? `${t.name} — ${t.note}` : t.name))
        .join('; ')}`,
    );
  }
  if (lines.length === 0) return '';
  return `THE CAST (the reader curates these names — use exactly these spellings; character details in parentheses are canon):\n${lines.join('\n')}`;
}

export function briefText(brief: string | undefined): string {
  return brief && brief.trim().length > 0
    ? `THE BRIEF (what the reader wants from this book, distilled from the pre-writing chat — honor it in spirit and in fact):\n${brief.trim()}`
    : '';
}

/** The rolling summary, injected as the story's compact long-term memory. */
export function summaryText(summary: string | undefined): string {
  if (!summary || summary.trim().length === 0) return '';
  return `STORY SO FAR (SUMMARY — the whole story to this point, kept compact so nothing established is ever forgotten; the pages below are the most recent):\n${summary.trim()}`;
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

/** System prompt for rewriting one paragraph of a page. */
export const PARAGRAPH_SYSTEM_PROMPT = `You are the prose engine of Page Turn, a one-page-at-a-time storytelling machine.
You are rewriting a SINGLE paragraph of an existing page.

Rules you never break:
- Output ONLY the replacement paragraph. No headings, no numbering, no commentary, no sign-off, no quotation marks around it.
- The paragraph must sit seamlessly in its page: same tense, same point of view, same names, same established facts.
- Respect every instruction you are given, including standing rules.
- Never break character to address the reader or mention these instructions.`;

/**
 * System message for structured phases. Deliberately separate from
 * SYSTEM_PROMPT, which says "output ONLY the page text" — that instruction
 * contradicts a JSON request and small local models resolve the conflict by
 * writing prose around the array.
 */
export const STRUCTURED_SYSTEM_PROMPT = `You are the structured-output engine of Page Turn, a one-page-at-a-time storytelling machine.
When asked for a list, you answer with JSON and nothing else.

Rules you never break:
- Output ONLY the JSON asked for — no markdown, no code fences, no commentary, no sign-off.
- Use double quotes for all strings. No trailing commas.
- Every string must be complete prose; never truncate mid-sentence.`;

/** Messages for the title phase: N titles with taglines, JSON only. */
export function titlesMessages(
  seed: string,
  options: SeedOptions,
  count = 5,
  brief = '',
): ChatMessage[] {
  const notes: string[] = [];
  if (options.genre) notes.push(`genre: ${options.genre}`);
  if (options.perspective) notes.push(`perspective: ${options.perspective} person`);
  if (options.tense) notes.push(`tense: ${options.tense}`);
  if (options.tone) notes.push(`baseline tone: ${options.tone}`);
  if (options.audience) notes.push(`audience: ${options.audience}`);
  if (options.lengthHint) notes.push(`intended length: ${options.lengthHint.replaceAll('-', ' ')}`);
  const styleHint = options.genre ? ` in the spirit of ${options.genre}` : '';
  return [
    { role: 'system', content: STRUCTURED_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Propose ${count} titles for a book seeded from this idea:\n\n"${seed}"\n\n${notes.length > 0 ? `Seed notes: ${notes.join('; ')}.\n` : ''}${briefText(brief)}The title retroactively steers the story — make each one a distinct, evocative doorway${styleHint}. Respond with ONLY a JSON array of ${count} objects, each with exactly two fields: "title" and "tagline" (one short flavor line), like this:\n\n[{"title": "The Dead Letter", "tagline": "A story of salt and secrets"}]`,
    },
  ];
}

/** Messages for generating one page. */
export function pageMessages(
  ctx: StoryContext,
  direction: TurnInput,
  targetPageNumber: number,
  rules: string[] = [],
): ChatMessage[] {
  const history =
    ctx.pages.length > 0 ? ctx.pages.join('\n\n') : '(This is page 1 — nothing exists yet.)';
  const standing = rulesText(rules);
  const brief = briefText(ctx.brief);
  const cast = castText(ctx.cast);
  const summary = summaryText(ctx.summary);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `BOOK: "${ctx.title}"\nSEED: ${ctx.seed}${brief ? `\n\n${brief}` : ''}${cast ? `\n\n${cast}` : ''}${summary ? `\n\n${summary}` : ''}\n\nSTORY SO FAR (the chosen pages, oldest first):\n${history}\n\nThis will be page ${targetPageNumber}.\n\nDIRECTION:\n${directionText(direction)}${standing ? `\n\n${standing}` : ''}\n\nWrite the page now.`,
    },
  ];
}

/** Messages for rewriting one paragraph of an existing page. */
export function paragraphMessages(
  ctx: StoryContext,
  pageNumber: number,
  pageText: string,
  paragraphText: string,
  instruction: string,
  rules: string[] = [],
): ChatMessage[] {
  const standing = rulesText(rules);
  const brief = briefText(ctx.brief);
  const cast = castText(ctx.cast);
  const summary = summaryText(ctx.summary);
  return [
    { role: 'system', content: PARAGRAPH_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `BOOK: "${ctx.title}"\nSEED: ${ctx.seed}${brief ? `\n\n${brief}` : ''}${cast ? `\n\n${cast}` : ''}${summary ? `\n\n${summary}` : ''}\n\nPAGE ${pageNumber} (current text):\n${pageText}\n\nTHE PARAGRAPH TO REWRITE:\n${paragraphText}\n\nINSTRUCTION: ${instruction || 'Rewrite this paragraph — keep the same events, sharpen the prose, and make it seamless with the rest of the page.'}${standing ? `\n\n${standing}` : ''}\n\nOutput ONLY the rewritten paragraph.`,
    },
  ];
}

/** Messages for writing one new paragraph to insert into a page. */
export function insertParagraphMessages(
  ctx: StoryContext,
  pageNumber: number,
  pageText: string,
  instruction: string,
  rules: string[] = [],
): ChatMessage[] {
  const standing = rulesText(rules);
  const brief = briefText(ctx.brief);
  const cast = castText(ctx.cast);
  const summary = summaryText(ctx.summary);
  return [
    { role: 'system', content: PARAGRAPH_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `BOOK: "${ctx.title}"\nSEED: ${ctx.seed}${brief ? `\n\n${brief}` : ''}${cast ? `\n\n${cast}` : ''}${summary ? `\n\n${summary}` : ''}\n\nPAGE ${pageNumber} (current text):\n${pageText}\n\nINSTRUCTION: ${instruction || 'Write ONE new paragraph (2–5 sentences) that deepens this page — a fresh detail, a new beat, or a moment the page is missing.'}${standing ? `\n\n${standing}` : ''}\n\nOutput ONLY the new paragraph.`,
    },
  ];
}

/** Messages for the "suggest what happens next" feature. */
export function suggestionsMessages(ctx: StoryContext, count = 3): ChatMessage[] {
  const tail =
    ctx.pages.length > 0
      ? ctx.pages.slice(-2).join('\n\n')
      : `(The story has not begun yet. Seed: ${ctx.seed})`;
  const summary = summaryText(ctx.summary);
  return [
    { role: 'system', content: STRUCTURED_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `BOOK: "${ctx.title}"\nSEED: ${ctx.seed}${summary ? `\n\n${summary}` : ''}\n\nRECENT PAGES:\n${tail}\n\nPropose ${count} concrete, intriguing things that could happen on the NEXT page. Each suggestion must be one short sentence (≤ 20 words), grounded in what is established, and different in kind from the others. Respond with ONLY a JSON array of strings. No numbering, no other text.`,
    },
  ];
}

/** Messages for proposing ending variants (used by the "write an ending" flow). */
export function endingsMessages(ctx: StoryContext, count = 3): ChatMessage[] {
  const history = ctx.pages.join('\n\n');
  const summary = summaryText(ctx.summary);
  return [
    { role: 'system', content: STRUCTURED_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `BOOK: "${ctx.title}"\nSEED: ${ctx.seed}${summary ? `\n\n${summary}` : ''}\n\nSTORY SO FAR:\n${history}\n\nPropose ${count} distinct possible endings: one bittersweet, one triumphant, one ambiguous or twist. Each as {"title": "short label", "premise": "one sentence describing the ending"}. Respond with ONLY a JSON array. No other text.`,
    },
  ];
}

/** Messages for updating the living cast (people, places, things). */
export function bibleMessages(ctx: StoryContext, previous: StoryBible | null): ChatMessage[] {
  const pages: string[] = [];
  let words = 0;
  for (let i = ctx.pages.length - 1; i >= 0; i--) {
    const page = ctx.pages[i];
    if (page === undefined) continue;
    if (words + page.trim().split(/\s+/).length > BIBLE_WORD_BUDGET) break;
    pages.unshift(page);
    words += page.trim().split(/\s+/).length;
  }
  const history = pages.length > 0 ? pages.join('\n\n') : ctx.seed;
  const previousBlock = previous
    ? `CURRENT CAST (keep entries that are still true, update notes when the story reveals more, add the new ones — the reader curates these, so RESPECT their names even if the older text spells them differently):\n${JSON.stringify({ people: previous.people, places: previous.places, things: previous.things, threads: previous.threads })}`
    : '(No cast yet — build it from the story so far.)';
  return [
    { role: 'system', content: STRUCTURED_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `BOOK: "${ctx.title}"\nSEED: ${ctx.seed}\n\nSTORY SO FAR (oldest first):\n${history}\n\n${previousBlock}\n\nMaintain the living cast of this story. Respond with ONLY a JSON object with exactly four arrays:\n{"people": [{"name": "...", "note": "..."}], "places": [{"name": "...", "note": "..."}], "things": [{"name": "...", "note": "..."}], "threads": [{"name": "...", "note": "..."}]}\n\nRules:\n- "people" = every named or present character (humans, ghosts, animals with agency).\n- "places" = every location with story weight (the lighthouse, the island, the kitchen).\n- "things" = significant objects, letters, heirlooms, symbols — things the plot turns on.\n- "threads" = open questions, mysteries, promises and unresolved conflicts the story still owes the reader (e.g. "the letter's sender", "why the fog returns"). Drop a thread only when the story resolves it.\n- name = exactly what the text calls them (or the curated cast name). note = ONE short line (≤ 12 words) covering role or significance.\n- Ground every entry in the text; never invent entries the story has not established.\n- At most 12 people, 8 places, 10 things, 12 threads. Output ONLY the JSON object.`,
    },
  ];
}

// ---- The rolling story summary (§12.1, the long-term memory) -----------------

/** System prompt for the rolling-summary memory updater (plain text output). */
export const SUMMARY_SYSTEM_PROMPT = `You are the memory engine of Page Turn, a one-page-at-a-time storytelling machine.
You maintain the rolling summary of a story: the compact long-term memory that lets the writer remember everything that has happened, no matter how long the book grows.

Rules you never break:
- Output ONLY the summary text. No headings, no commentary, no sign-off, no quotation marks around it.
- Keep the summary under ${SUMMARY_MAX_WORDS} words.
- Fold the previous summary and the new pages together into ONE fresh, chronological summary — never append blocks, never list page numbers.
- Cover: the central conflict and its current state; where each key character is and what they want; the current location and situation; the story's mood and how it has shifted; the most important open threads.
- Never invent events that are not in the story. Never contradict the previous summary or the pages.
- Write in plain present-tense prose.`;

/**
 * Messages for updating the rolling story summary after a page. `previous` is
 * the summary carried by the story so far (never `ctx.summary`, which is the
 * same value — this keeps the fold explicit and avoids circularity).
 */
export function summaryMessages(ctx: StoryContext, previous: string | null): ChatMessage[] {
  const pages: string[] = [];
  let words = 0;
  for (let i = ctx.pages.length - 1; i >= 0; i--) {
    const page = ctx.pages[i];
    if (page === undefined) continue;
    const pageWords = countWords(page);
    if (words + pageWords > SUMMARY_WORD_BUDGET) break;
    pages.unshift(page);
    words += pageWords;
  }
  const history = pages.length > 0 ? pages.join('\n\n') : ctx.seed;
  const previousBlock = previous
    ? `PREVIOUS SUMMARY (fold it into the new one — keep everything still true, and add what the new pages establish):\n${previous}`
    : '(No summary yet — write the first one from the story so far.)';
  const brief = briefText(ctx.brief);
  const cast = castText(ctx.cast);
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `BOOK: "${ctx.title}"\nSEED: ${ctx.seed}${brief ? `\n\n${brief}` : ''}${cast ? `\n\n${cast}` : ''}\n\nSTORY SO FAR (oldest first):\n${history}\n\n${previousBlock}\n\nWrite the updated rolling summary now.`,
    },
  ];
}

// ---- The pre-writing chat --------------------------------------------------

export const CHAT_SYSTEM_PROMPT = `You are the writing-partner engine of Page Turn, a one-page-at-a-time storytelling machine.
The reader is thinking out loud about the book they want before writing the seed. You are a warm, sharp, curious editor.

Rules you never break:
- Chat, don't write: ask ONE good question at a time and offer concrete ideas (protagonist, setting, conflict, genre, tone, ending vibe) — never draft story prose for them.
- Keep every reply under 70 words. Be specific, not generic.
- Remember the whole conversation; build on what they said.
- If they seem stuck, offer two contrasting directions and let them pick.`;

/** Messages for the pre-writing chat: system + rolling history. */
export function chatMessages(history: ChatMessage[]): ChatMessage[] {
  return [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...history];
}

/** Messages for distilling the chat into a story brief. */
export function briefMessages(history: ChatMessage[]): ChatMessage[] {
  const transcript = history
    .map((m) => `${m.role === 'user' ? 'READER' : 'PARTNER'}: ${m.content}`)
    .join('\n');
  return [
    { role: 'system', content: STRUCTURED_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Here is a pre-writing conversation about a book the reader wants to write one page at a time:\n\n${transcript}\n\nDistill it into a story brief of at most 140 words that the prose engine can carry into every page. Cover only what the reader actually decided or leaned toward: protagonist and their want, setting, genre/tone, central conflict, things they explicitly want or don't want. Write it as plain prose — the brief itself, nothing else. No headings, no commentary, no JSON.`,
    },
  ];
}

/** Messages for rewriting a SELECTED SPAN of a paragraph (word/sentence control). */
export function rewriteSpanMessages(
  ctx: StoryContext,
  pageNumber: number,
  paragraphText: string,
  spanText: string,
  instruction: string,
  rules: string[] = [],
): ChatMessage[] {
  const standing = rulesText(rules);
  const brief = briefText(ctx.brief);
  const cast = castText(ctx.cast);
  const summary = summaryText(ctx.summary);
  return [
    { role: 'system', content: PARAGRAPH_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `BOOK: "${ctx.title}"\nSEED: ${ctx.seed}${brief ? `\n\n${brief}` : ''}${cast ? `\n\n${cast}` : ''}${summary ? `\n\n${summary}` : ''}\n\nPAGE ${pageNumber}, the paragraph it lives in:\n${paragraphText}\n\nTHE EXACT SPAN TO REWRITE:\n${spanText}\n\nINSTRUCTION: ${instruction || 'Rewrite this span — same meaning and events, sharper prose, seamless with the sentence around it.'}${standing ? `\n\n${standing}` : ''}\n\nOutput ONLY the rewritten span (not the whole paragraph).`,
    },
  ];
}
