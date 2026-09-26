/**
 * core/search.ts — typo-tolerant fuzzy matching for the library shelf.
 *
 * A small fzf-style scorer: subsequence match with bonus for word starts and
 * consecutive runs, penalty for gaps and missing chars. Pure and testable.
 */

/** Score how well `query` matches `text`; 0 = no match. Higher is better. */
export function searchScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const t = text.toLowerCase();
  if (q.length === 0) return 1;
  // An exact substring match must be unbeatable: the fuzzy scorer below awards
  // 20+ per character at word starts, so a gappy candidate used to outrank a
  // real, contiguous hit (query "dead letter": exact 111 vs a spaced
  // "d e a d l e t t e r" subsequence at 218). Earlier matches rank higher.
  const at = t.indexOf(q);
  if (at >= 0) return 1_000_000 - at;

  let score = 0;
  let qi = 0;
  let lastMatch = -2;
  let run = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    // Matched a query char.
    let add = 8;
    if (ti === lastMatch + 1) {
      run += 1;
      add += run * 4; // consecutive bonus
    } else {
      run = 0;
    }
    if (ti === 0 || /[\s\-_.:/]/.test(t[ti - 1] ?? '')) add += 12; // word-start bonus
    score += add - (ti - Math.max(lastMatch + 1, 0)) * 0.2; // gap penalty
    lastMatch = ti;
    qi++;
  }
  return qi === q.length ? Math.max(0, score) : 0; // all chars matched?
}

/** Find candidates whose text matches the query (fuzzy or exact). */
export function fuzzySearch(
  query: string,
  candidates: Array<{ text: string }>,
  threshold = 12,
): Array<{ index: number; score: number }> {
  const results: Array<{ index: number; score: number }> = [];
  candidates.forEach((candidate, index) => {
    const score = searchScore(query, candidate.text);
    if (score >= threshold) results.push({ index, score });
  });
  return results.sort((a, b) => b.score - a.score);
}
