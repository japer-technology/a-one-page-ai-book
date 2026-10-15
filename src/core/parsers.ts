/**
 * core/parsers.ts — tolerant parsing of LLM output.
 *
 * Local models are loosely tuned and often wrap JSON in prose or code fences.
 * These helpers extract structured data without trusting the model.
 */
import type { BibleEntry, StoryBible } from './types';

/** Strip a markdown code fence (```json ... ``` or ``` ... ```) if present. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence && fence[1] !== undefined) return fence[1].trim();
  return trimmed;
}

/**
 * Parse JSON from text that may contain surrounding prose: try the whole
 * string, then the first balanced {...} or [...] slice. Small local models
 * also love trailing commas — drop the last comma before } or ] when present
 * (string-aware, so prose inside strings is never touched).
 */
export function parseJSONLoose<T>(text: string): T {
  const candidates = [text.trim(), stripCodeFence(text)];
  // Small models write curly quotes: “[a”, “b”] is a list, not prose. The
  // de-curled variants come LAST so a value that legitimately contains a
  // curly quote still parses from the original text first.
  const decurled = (s: string): string => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  for (const candidate of [...candidates, ...candidates.map(decurled)]) {
    try {
      return JSON.parse(repairTrailingCommas(candidate)) as T;
    } catch {
      // keep looking
    }
  }
  // Try EVERY balanced slice, not just the first. A model that writes
  // "Here are 3 titles [as JSON]:" produces a balanced `[...]` in the prose
  // before its real payload; stopping at the first balanced slice rejected
  // perfectly good JSON (and the title salvage path then invented titles out
  // of the raw JSON text).
  for (const slice of balancedSlices(text)) {
    try {
      return JSON.parse(repairTrailingCommas(slice)) as T;
    } catch {
      // keep looking
    }
  }
  throw new Error(`Model output was not valid JSON. Got: ${text.slice(0, 120)}…`);
}

/** Remove a trailing comma before } or ] — the most common small-model JSON defect. */
function repairTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? '')) j++;
      const next = text[j] ?? '';
      if (next === '}' || next === ']') continue; // drop this comma
    }
    out += ch;
  }
  return out;
}

/**
 * Every balanced `{…}` / `[…]` slice in the text, in order of appearance.
 * Wrapper-level slices (the outermost pair) come first at each start position —
 * a start inside an already-closed slice yields only shorter, inner slices.
 */
function balancedSlices(text: string): string[] {
  const starts: Array<{ index: number; open: string; close: string }> = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[')
      starts.push({ index: i, open: ch, close: ch === '{' ? '}' : ']' });
  }
  // Walk each candidate start, tracking nesting. A `[`-rooted slice is tried
  // before an equally-positioned `{`-rooted one because the callers that need
  // salvage most often want a list.
  starts.sort((a, b) => a.index - b.index || (a.open === b.open ? 0 : a.open === '[' ? -1 : 1));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const start of starts) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start.index; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === start.open) depth++;
      else if (ch === start.close) {
        depth--;
        if (depth === 0) {
          const slice = text.slice(start.index, i + 1);
          if (!seen.has(slice)) {
            seen.add(slice);
            out.push(slice);
          }
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Refusals and apologies a small model writes instead of the ask ("I cannot
 * provide titles — …", "I'm sorry, but I can't help with that"). They are
 * never content: every salvage path must drop them, or a refusal becomes a
 * pickable title, a seed idea, or a "conflict".
 */
export function looksLikeRefusal(line: string): boolean {
  const text = line.trim();
  return refusalPattern().test(text) || /^as an? (?:ai|assistant|language model)\b/i.test(text);
}

/**
 * The refusal detector, built once. The rules that matter:
 *
 * - A refusal names the action it refuses ("cannot write …", "unable to help
 *   …"), possibly after "to"/"with"; the action is then followed by what it
 *   targets ("this", "that", a title/page…) or the end of the line. A title
 *   like "I Cannot Help Falling in Love" has no refused action, so it survives,
 *   and a bare pronoun after the action is no target either ("I Can't Help It",
 *   "I Cannot Do It" and "I Won't Write You a Poem" are titles — only after
 *   help/assist does a person object count, as in "I can't help YOU")
 *   — and so do "I'm Sorry, But I Love You" and "Sorry, Wrong Number": an
 *   apology lead-in only counts when a refusal clause FOLLOWS it. (Both
 *   directions were once broken: the apostrophe forms of the refusal clause
 *   were unreachable, while any line merely starting with an apology word was
 *   dropped.)
 */
let refusalRe: RegExp | null = null;
function refusalPattern(): RegExp {
  if (refusalRe) return refusalRe;
  const action =
    '(?:help|assist|provide|write|continue|generate|create|comply|offer|answer|respond|do|produce|complete|fulfill|fulfil|satisfy|participate|engage)';
  const actionGerund =
    '(?:helping|assisting|providing|writing|continuing|generating|creating|complying|offering|answering|responding|doing|producing|completing|fulfilling|satisfying|participating|engaging)';
  // What the refused action is aimed at — or the end of the line. A bare
  // pronoun is deliberately NOT here: "I can't help it", "I cannot do it"
  // and "I won't write you a poem" are titles, not refusals — except after
  // help/assist, where "I can't help YOU" refuses to assist a person.
  const targetInner =
    'this|that|in|the|a|an|my|your|our|any|no|something|about|titles?|pages?|content|requests?|questions?|stories?|story|text|prose|words|further|more|such|these|those|against|with|on|for|to|now|here|currently|at|right|yet';
  const target = `(?:${targetInner})`;
  const targetHelped = `(?:you|him|her|them|${targetInner})`;
  // "cannot" / "can't" / "won't" / "will not" / "must decline" / "unable" /
  // "not able (to)" / "not going (to)" / "don't feel comfortable" / "don't
  // think I can" / "won't be able to".
  const clause =
    "(?:cannot|can\\s+not|can['’]?t|won['’]?t|will\\s+not|must\\s+decline|unable|(?:am\\s+)?not\\s+(?:able|going)|(?:do\\s+not|don['’]?t)\\s+feel\\s+(?:comfortable|able)|(?:am\\s+)?not\\s+comfortable|(?:won['’]?t|will\\s+not)\\s+be\\s+able\\s+to|(?:do\\s+not|don['’]?t)\\s+think\\s+(?:i|we)\\s+(?:can|could)|(?:am\\s+)?not\\s+going\\s+to\\s+be\\s+able\\s+to|(?:am\\s+)?not\\s+at\\s+liberty\\s+to|(?:would|['’]d)\\s+rather\\s+not|refuse[sd]?\\s+to|could(?:\\s+not|n['’]?t)|cannot\\s+and\\s+will\\s+not)";
  const apology =
    "(?:i(?:['’]m|\\s+am)\\s+sorry\\b[^.!?\\n]{0,60}?|sorry\\b\\s*[,.;:;!—–-]\\s*|i\\s+apologi[sz]e\\b[^.!?\\n]{0,60}?|i(?:['’]m|\\s+am)\\s+afraid\\b[^.!?\\n]{0,60}?)";
  // A short opener the model puts before its apology or refusal.
  const opener = '(?:unfortunately|apologies|my\\s+apologies|regrettably)\\s*,?\\s*';
  const helped = '(?:help|assist|helping|assisting)';
  refusalRe = new RegExp(
    `^\\s*(?!i\\s+can(?:['’]t|\\s+not)\\s+help\\s+(?:the|my)\\s+way\\b)(?!i\\s+won['’]?t\\s+write\\s+your\\s+name\\b)(?:${opener})?(?:${apology})?\\s*[.,;:!?—–-]?\\s*(?:but\\s+)?i(?:['’]m|\\s+am)?\\s*(?:${clause})\\s+(?:(?:to|with|in)\\s+|in\\s+good\\s+conscience\\s+|possibly\\s+|really\\s+|ever\\s+)?(?:(?:${helped})\\b(?:\\s*(?:$|[,.;:!?…—]|(?:${targetHelped})\\b))|(?:${action}|${actionGerund})(?:\\s+(?:to\\s+)?(?:${action}|${actionGerund}))*\\b(?:\\s*(?:$|[,.:;!?…—]|(?:${target})\\b))|(?:${target})\\b)`,
    'i',
  );
  return refusalRe;
}

/** The best string an item carries: strings as-is, records by their first known field. */
const STRING_KEYS = [
  'text',
  'conflict',
  'suggestion',
  'title',
  'name',
  'premise',
  'value',
] as const;

function itemText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    for (const key of STRING_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
  }
  return '';
}

/** Parse a list of strings from loosely-formatted output (JSON array, {titles:[...]}, or newline list). */
export function parseStringList(text: string): string[] {
  const usable = (list: string[]): string[] =>
    list.filter((item) => item.length > 0 && !looksLikeRefusal(item));
  const lineSalvage = (): string[] =>
    usable(
      text
        .split('\n')
        .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
        .filter((line) => line.length > 0),
    );
  try {
    const parsed = parseJSONLoose<unknown>(text);
    if (Array.isArray(parsed)) return usable(parsed.map(itemText));
    if (parsed && typeof parsed === 'object') {
      for (const value of Object.values(parsed)) {
        if (!Array.isArray(value)) continue;
        const list = usable(value.map(itemText));
        if (list.length > 0) return list;
      }
    }
    // Whole-reply JSON with nothing usable in it IS the answer: `{"suggestions":
    // []}` must come back empty, not as one bogus idea reading the raw JSON.
    // Only when the WHOLE reply is that JSON, though: parseJSONLoose also finds
    // balanced slices inside prose, and those must still reach the line salvage
    // — a reply opening with `{"conflicts": []}` but naming the real verdict
    // afterwards keeps the verdict.
    try {
      JSON.parse(repairTrailingCommas(stripCodeFence(text).trim()));
      return [];
    } catch {
      // A fragment, not the whole answer: fall through to the line salvage.
    }
  } catch {
    // Not JSON at all: the model wrote a list, which the line salvage is for.
  }
  return lineSalvage();
}

/**
 * Parse a list of {title, tagline} objects, tolerating plain strings or
 * {titles:[...]} wrappers. When the model ignored the JSON instruction and
 * wrote a numbered list instead ("1. The Dead Letter — A story of…"), fall
 * back to line-based extraction so the title phase still gets its titles.
 */
export function parseTitleOptions(text: string): Array<{ title: string; tagline: string }> {
  const toOption = (item: unknown): { title: string; tagline: string } | null => {
    if (typeof item === 'string') return { title: item, tagline: '' };
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const title =
        typeof record.title === 'string'
          ? record.title
          : typeof record.name === 'string'
            ? record.name
            : '';
      if (!title) return null;
      return { title, tagline: typeof record.tagline === 'string' ? record.tagline : '' };
    }
    return null;
  };

  let json: unknown;
  try {
    json = parseJSONLoose<unknown>(text);
  } catch {
    // Not JSON at all: the model wrote a list, which the line salvage below
    // is built for.
    return parseTitleLines(text);
  }

  // An array, a `{titles: [...]}` wrapper, or the single `{title, tagline}`
  // object a small model returns instead of a list of one.
  const list: unknown[] | undefined = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? (Object.values(json).find((value) => Array.isArray(value)) ??
        (toOption(json) !== null ? [json] : undefined))
      : undefined;
  if (list === undefined) return parseTitleLines(text);

  // JSON that parsed IS the answer, even when it holds nothing: re-reading the
  // JSON text as a line list turned `{"titles": []}` into a title card reading
  // `{"titles`, and a book can be named after it. A refusal returned in the
  // JSON shape is still a refusal, not a pickable title.
  return list
    .map(toOption)
    .filter(
      (x): x is { title: string; tagline: string } => x !== null && !looksLikeRefusal(x.title),
    );
}

/**
 * Line-based salvage for prose answers: strips list markers, understands
 * "Title — tagline", "Title - tagline", "Title: tagline" and bare titles,
 * and skips the filler lines models wrap around lists.
 */
function parseTitleLines(text: string): Array<{ title: string; tagline: string }> {
  const out: Array<{ title: string; tagline: string }> = [];
  for (const raw of text.split('\n')) {
    const line = raw
      .trim()
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
      .replaceAll('**', '')
      .trim();
    if (line.length === 0 || line.length > 90) continue; // prose, not a title
    if (looksLikeRefusal(line)) continue; // a refusal is not a title
    if (/^(here(?:'s| are)?|sure!?|certainly|of course|i propose|the following)\b/i.test(line))
      continue;
    if (line.endsWith(':')) continue;

    const clean = (s: string): string => s.replace(/^["'“”]+|["'“”]+$/g, '').trim();

    let match = line.match(/^["'“]([^"'”]+)["'”]\s*[—–-]\s*(.+)$/);
    if (match && match[1] && match[2]) {
      out.push({ title: clean(match[1]), tagline: clean(match[2]) });
      continue;
    }
    match = line.match(/^(.+?)\s*[—–]\s*(.+)$/);
    if (match && match[1] && match[2]) {
      out.push({ title: clean(match[1]), tagline: clean(match[2]) });
      continue;
    }
    match = line.match(/^(.+?)(?:\s+-\s*|\s*:\s*)(.+)$/);
    if (match && match[1] && match[2]) {
      out.push({ title: clean(match[1]), tagline: clean(match[2]) });
      continue;
    }
    // A bare line counts as a title only when it looks like one: it starts
    // capitalized and is not a full sentence. A trailing period is stripped
    // when the line is short enough to be a title ("The Dead Letter."); the
    // refusal filter has already run, and longer period-terminated lines are
    // prose.
    const bare = line.endsWith('.') ? line.slice(0, -1).trim() : line;
    if (/^[A-Z0-9"“]/.test(bare) && (!line.endsWith('.') || bare.split(/\s+/).length <= 6)) {
      out.push({ title: clean(bare), tagline: '' });
    }
  }
  return out;
}

/**
 * Parse the living-cast JSON the model returns for the bible update:
 * {"people": [{"name","note"}], "places": [...], "things": [...]}.
 * Tolerates wrappers, string entries, and prose around the object. Falls back
 * to the previous cast (merged with whatever names the model did return)
 * rather than throwing — the cast must never regress to empty on a wobble.
 */
export function parseBible(text: string, previous: StoryBible | null = null): StoryBible {
  const base = {
    people: previous?.people ?? [],
    places: previous?.places ?? [],
    things: previous?.things ?? [],
    threads: previous?.threads ?? [],
    relations: previous?.relations ?? [],
    summary: previous?.summary ?? '',
  };
  let raw: unknown = null;
  try {
    raw = parseJSONLoose<unknown>(text);
  } catch {
    raw = null;
  }
  let object: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    object = raw as Record<string, unknown>;
  } else if (raw && typeof raw === 'object' && Array.isArray(raw)) {
    // Some models answer with a bare array of objects carrying a "kind" field
    // (people/places/things/threads). Dispatch each entry by that field — the
    // old code dumped everything into people, so every prompt presented
    // places and things as characters.
    const groups: Record<'people' | 'places' | 'things' | 'threads', unknown[]> = {
      people: [],
      places: [],
      things: [],
      threads: [],
    };
    for (const item of raw) {
      const kind =
        item &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).kind === 'string'
          ? String((item as Record<string, unknown>).kind).toLowerCase()
          : '';
      const target = /place|location|setting/.test(kind)
        ? 'places'
        : /thing|object|item|prop/.test(kind)
          ? 'things'
          : /thread|question|mystery|open/.test(kind)
            ? 'threads'
            : 'people';
      groups[target].push(item);
    }
    object = groups;
  }
  if (!object) {
    if (previous) return { ...base, at: previous.at, updatedAt: Date.now() };
    throw new Error('The model did not return a cast object — try again.');
  }
  const caps: Record<'people' | 'places' | 'things' | 'threads', number> = {
    people: 12,
    places: 8,
    things: 10,
    threads: 12,
  };
  const entries = (key: 'people' | 'places' | 'things' | 'threads'): BibleEntry[] => {
    const cap = caps[key];
    const value = object?.[key] ?? object?.cast?.[key as never];
    const list: BibleEntry[] = Array.isArray(value) ? coerceEntries(value) : [];
    if (list.length === 0) {
      // Keep the previous entries for this group — never regress to empty,
      // and never truncate them: the reader can add entries over the cap by
      // hand, and slicing here would delete exactly their newest one.
      return previous ? base[key] : list;
    }
    if (!previous) return list.slice(0, cap);
    // The model rewrites the group, and the panel PROMISES the reader's
    // curation survives ("you curate the cast … the model writes with these
    // names"): an entry the reader added (or renamed by hand) used to vanish
    // as soon as an update happened not to mention it — and because the cap
    // sliced the MERGED list, a full model list also silently evicted the
    // reader's entries from its tail.
    //
    // Two invariants, and their interaction: the reader's curation must
    // survive, AND the model's UPDATES must still apply when a group sits at
    // its cap — and a long story's cast sits at cap permanently. (Slicing the
    // whole model list to the remaining room froze every note forever: at cap
    // room is 0, so even refreshes of known names were dropped.) Split the
    // model's entries: known names are updates and never consume room; only
    // brand-new names compete for the room the cap has left; entries the model
    // stopped mentioning are carried over untouched.
    const lower = (entry: BibleEntry): string => entry.name.trim().toLowerCase();
    const known = new Set(base[key].map(lower));
    const updates = list.filter((entry) => known.has(lower(entry)));
    const additions = list.filter((entry) => !known.has(lower(entry)));
    const room = Math.max(0, cap - base[key].length);
    const admitted = additions.slice(0, room);
    const covered = new Set([...updates, ...admitted].map(lower));
    const carry = base[key].filter((entry) => !covered.has(lower(entry)));
    // The effective cap is never below what the group already holds: the
    // reader's own additions may go over the cap, and a reply that merely
    // refreshes the known names must not truncate them from the tail.
    return [...updates, ...admitted, ...carry].slice(0, Math.max(cap, base[key].length));
  };
  const people = entries('people');
  const places = entries('places');
  const things = entries('things');
  const threads = entries('threads');
  const relations = parseRelations(object.relations, base.relations);
  const summary =
    typeof object.summary === 'string' && object.summary.trim().length > 0
      ? object.summary.trim()
      : base.summary;
  if (people.length === 0 && places.length === 0 && things.length === 0) {
    if (previous) return { ...base, at: previous.at, updatedAt: Date.now() };
    throw new Error('The model returned an empty cast — try again.');
  }
  return {
    people,
    places,
    things,
    threads,
    relations,
    summary,
    at: previous?.at ?? 1,
    updatedAt: Date.now(),
  };
}

/** Parse relationship triples: [{"from","to","kind"}] or ["A — B — kind"]. */
function parseRelations(raw: unknown, previous: StoryBible['relations']): StoryBible['relations'] {
  if (!Array.isArray(raw)) return previous;
  const out: StoryBible['relations'] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      const [from, kind, to] = item.split(/\s*[—–-]\s*/);
      if (from?.trim() && to?.trim() && kind?.trim()) {
        pushRelation(out, seen, { from: from.trim(), to: to.trim(), kind: kind.trim() });
      }
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const from = typeof record.from === 'string' ? record.from.trim() : '';
      const to = typeof record.to === 'string' ? record.to.trim() : '';
      const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
      if (from && to && kind) pushRelation(out, seen, { from, to, kind });
    }
  }
  return out.length > 0 ? out : previous;
}

function pushRelation(
  out: StoryBible['relations'],
  seen: Set<string>,
  r: StoryBible['relations'][number],
): void {
  // Ordered key: "A mentors B" and "B mentors A" are different relationships.
  const key = `${r.from.toLowerCase()}\u0000${r.to.toLowerCase()}\u0000${r.kind.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(r);
}

function coerceEntries(list: unknown[]): BibleEntry[] {
  const out: BibleEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item === 'string' && item.trim().length > 0) {
      pushEntry(out, seen, { name: item.trim(), note: '' });
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const name =
        typeof record.name === 'string'
          ? record.name.trim()
          : typeof record.title === 'string'
            ? record.title.trim()
            : '';
      if (!name) continue;
      const note = typeof record.note === 'string' ? record.note.trim() : '';
      const details = typeof record.details === 'string' ? record.details.trim() : '';
      pushEntry(out, seen, { name, note, details: details.length > 0 ? details : undefined });
    }
  }
  return out;
}

function pushEntry(out: BibleEntry[], seen: Set<string>, entry: BibleEntry): void {
  const key = entry.name.toLowerCase();
  if (key.length === 0 || seen.has(key)) return;
  seen.add(key);
  out.push(entry);
}
