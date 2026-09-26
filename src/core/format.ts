/**
 * core/format.ts — tiny, dependency-free text formatting shared by the domain
 * layer and the views. Deliberately pure so core modules never have to import
 * from `ui/`.
 */

/** Thousands-separated integer, tolerant of a missing Intl implementation. */
export function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  try {
    return new Intl.NumberFormat().format(n);
  } catch {
    return String(n);
  }
}

/**
 * `1 page` / `3 pages`. Counts are read by humans throughout this app, and
 * "1 pages" appears on nearly every card, header and ledger the moment a book
 * has a single page.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${fmtNumber(count)} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}
