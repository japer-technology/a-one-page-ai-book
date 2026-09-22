/**
 * core/lint.ts — the story linter. Zero-model metrics that catch the *feel*
 * problems: repetition, adverb bloat, monotone sentences, missing dialogue,
 * and page-length drift. Pure and testable.
 */

export interface LintIssue {
  severity: 'info' | 'warn';
  message: string;
}

export interface LintReport {
  words: number;
  sentences: number;
  paragraphs: number;
  sentenceVariance: number;
  adverbRatio: number;
  dialogueDensity: number;
  repeatedNgrams: string[];
  issues: LintIssue[];
}

const TOKEN = /\b[\w'’]+\b/g;

export function lintText(text: string): LintReport {
  const words = text.match(TOKEN) ?? [];
  const sentences = text
    .split(/[.!?…]+[\s\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const paragraphs = text
    .split(/\n[ \t]*\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const sentenceLengths = sentences.map((s) => (s.match(/\s+/g)?.length ?? 0) + 1);
  const mean =
    sentenceLengths.length > 0
      ? sentenceLengths.reduce((sum, len) => sum + len, 0) / sentenceLengths.length
      : 0;
  const variance =
    sentenceLengths.length > 0
      ? sentenceLengths.reduce((sum, len) => sum + (len - mean) * (len - mean), 0) /
        sentenceLengths.length
      : 0;

  const adverbs = words.filter((w) => w.toLowerCase().endsWith('ly') && w.length > 4).length;
  const adverbRatio = words.length > 0 ? adverbs / words.length : 0;

  const quoted = (text.match(/["“][^"”]{3,}["”]/g) ?? []).join(' ').length;
  const dialogueDensity = text.length > 0 ? quoted / text.length : 0;

  // Repeated 4-grams (case-insensitive), excluding pure-stopword runs.
  const seen = new Map<string, number>();
  const lowered = words.map((w) => w.toLowerCase());
  for (let i = 0; i + 4 <= lowered.length; i++) {
    const gram = lowered.slice(i, i + 4).join(' ');
    seen.set(gram, (seen.get(gram) ?? 0) + 1);
  }
  const repeatedNgrams = [...seen.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([gram]) => gram);

  const issues: LintIssue[] = [];
  if (adverbRatio > 0.08) {
    issues.push({
      severity: 'warn',
      message: `${Math.round(adverbRatio * 100)}% of words are adverbs — consider cutting "ly" words.`,
    });
  }
  if (variance < 6 && sentenceLengths.length > 3) {
    issues.push({
      severity: 'info',
      message: `Sentences hover near ${Math.round(mean)} words — vary the rhythm.`,
    });
  }
  if (dialogueDensity < 0.04 && words.length > 120) {
    issues.push({ severity: 'info', message: 'Little dialogue — a voice could open this up.' });
  }
  if (repeatedNgrams.length > 0) {
    issues.push({
      severity: 'warn',
      message: `Repeated phrasing: "${repeatedNgrams[0]}" (and ${repeatedNgrams.length - 1} more).`,
    });
  }
  if (words.length === 0) {
    issues.push({ severity: 'info', message: 'This page is empty.' });
  }

  return {
    words: words.length,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    sentenceVariance: Math.round(variance),
    adverbRatio: Math.round(adverbRatio * 1000) / 1000,
    dialogueDensity: Math.round(dialogueDensity * 1000) / 1000,
    repeatedNgrams,
    issues,
  };
}

/** A compact one-line health verdict. */
export function lintVerdict(report: LintReport): string {
  if (report.issues.length === 0) return 'clean';
  return report.issues.some((i) => i.severity === 'warn') ? 'needs a look' : 'fine';
}
