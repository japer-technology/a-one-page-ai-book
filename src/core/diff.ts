/**
 * core/diff.ts — a small word-level diff for comparing two versions of a page.
 * Longest-common-subsequence over word tokens; the UI renders deletions red
 * and additions green. Pure and testable.
 */

export interface DiffPart {
  text: string;
  kind: 'same' | 'add' | 'del';
}

const TOKEN = /(\s+|\w+(?:['’]\w+)*|[^\w\s]+)/g;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Merge runs of the same kind for compact output. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;
  // LCS table.
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j]
          ? (table[i + 1]![j + 1] ?? 0) + 1
          : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i];
    const bj = b[j];
    if (ai !== undefined && ai === bj) {
      push('same', ai);
      i++;
      j++;
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      push('del', ai ?? '');
      i++;
    } else {
      push('add', bj ?? '');
      j++;
    }
  }
  while (i < n) push('del', a[i++] ?? '');
  while (j < m) push('add', b[j++] ?? '');
  return parts;
}

/** Rough statistics of a diff (for quick summaries). */
export function diffStats(parts: DiffPart[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.kind === 'add') added += part.text.trim().length;
    if (part.kind === 'del') removed += part.text.trim().length;
  }
  return { added, removed };
}
