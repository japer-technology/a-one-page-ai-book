/**
 * core/parsers.ts — tolerant parsing of LLM output.
 *
 * Local models are loosely tuned and often wrap JSON in prose or code fences.
 * These helpers extract structured data without trusting the model.
 */

/** Strip a markdown code fence (```json ... ``` or ``` ... ```) if present. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence && fence[1] !== undefined) return fence[1].trim();
  return trimmed;
}

/**
 * Parse JSON from text that may contain surrounding prose: try the whole
 * string, then the first balanced {...} or [...] slice.
 */
export function parseJSONLoose<T>(text: string): T {
  const candidates = [text.trim(), stripCodeFence(text)];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // keep looking
    }
  }
  const slice = firstBalanced(text);
  if (slice !== null) {
    try {
      return JSON.parse(slice) as T;
    } catch {
      // fall through to error
    }
  }
  throw new Error(`Model output was not valid JSON. Got: ${text.slice(0, 120)}…`);
}

function firstBalanced(text: string): string | null {
  const starts: Array<{ index: number; open: string; close: string }> = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
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

/** Parse a list of {title, tagline} objects, tolerating plain strings or {titles:[...]} wrappers. */
export function parseTitleOptions(text: string): Array<{ title: string; tagline: string }> {
  const raw = parseJSONLoose<unknown>(text);
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? (Object.values(raw).find((v) => Array.isArray(v)) ?? [])
      : [];
  return (list as unknown[])
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
}
