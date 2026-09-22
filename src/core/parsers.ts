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
  for (const candidate of candidates) {
    try {
      return JSON.parse(repairTrailingCommas(candidate)) as T;
    } catch {
      // keep looking
    }
  }
  const slice = firstBalanced(text);
  if (slice !== null) {
    try {
      return JSON.parse(repairTrailingCommas(slice)) as T;
    } catch {
      // fall through to error
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

function firstBalanced(text: string): string | null {
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
  // Walk each candidate start, tracking nesting.
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
        if (depth === 0) return text.slice(start.index, i + 1);
      }
    }
  }
  return null;
}

/** Parse a list of strings from loosely-formatted output (JSON array, {titles:[...]}, or newline list). */
export function parseStringList(text: string): string[] {
  try {
    const parsed = parseJSONLoose<unknown>(text);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter((x) => x.length > 0);
    if (parsed && typeof parsed === 'object') {
      for (const value of Object.values(parsed)) {
        if (Array.isArray(value)) {
          const list = value.map((x) => String(x)).filter((x) => x.length > 0);
          if (list.length > 0) return list;
        }
      }
    }
  } catch {
    // fall back to line splitting below
  }
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * Parse a list of {title, tagline} objects, tolerating plain strings or
 * {titles:[...]} wrappers. When the model ignored the JSON instruction and
 * wrote a numbered list instead ("1. The Dead Letter — A story of…"), fall
 * back to line-based extraction so the title phase still gets its titles.
 */
export function parseTitleOptions(text: string): Array<{ title: string; tagline: string }> {
  let parsed: Array<{ title: string; tagline: string }> = [];
  try {
    const raw = parseJSONLoose<unknown>(text);
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? (Object.values(raw).find((v) => Array.isArray(v)) ?? [])
        : [];
    parsed = (list as unknown[])
      .map((item) => {
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
      })
      .filter((x): x is { title: string; tagline: string } => x !== null);
  } catch {
    parsed = [];
  }
  if (parsed.length > 0) return parsed;
  return parseTitleLines(text);
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
    match = line.match(/^(.+?)\s*[-:]\s*(.+)$/);
    if (match && match[1] && match[2]) {
      out.push({ title: clean(match[1]), tagline: clean(match[2]) });
      continue;
    }
    // A bare line counts as a title only when it looks like one: it starts
    // capitalized and is not a full sentence (no trailing period) — that
    // keeps refusal prose ("I cannot help with that request.") out.
    if (/^[A-Z0-9"“]/.test(line) && !line.endsWith('.')) {
      out.push({ title: clean(line), tagline: '' });
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
    // Some models answer with a bare array of objects carrying a "kind" field.
    object = { people: raw };
  }
  if (!object) {
    if (previous) return { ...base, at: previous.at, updatedAt: Date.now() };
    throw new Error('The model did not return a cast object — try again.');
  }
  const entries = (key: 'people' | 'places' | 'things' | 'threads'): BibleEntry[] => {
    const value = object?.[key] ?? object?.cast?.[key as never];
    const list: BibleEntry[] = Array.isArray(value) ? coerceEntries(value) : [];
    if (list.length === 0 && previous) {
      // Keep the previous entries for this group — never regress to empty.
      return base[key];
    }
    return list;
  };
  const caps: Record<'people' | 'places' | 'things' | 'threads', number> = {
    people: 12,
    places: 8,
    things: 10,
    threads: 12,
  };
  const people = entries('people').slice(0, caps.people);
  const places = entries('places').slice(0, caps.places);
  const things = entries('things').slice(0, caps.things);
  const threads = entries('threads').slice(0, caps.threads);
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
