/**
 * ui/audit.ts — a tiny in-memory event trail for deep debugging.
 *
 * The app is local-first with no telemetry, so when something misbehaves the
 * only evidence is this ring buffer — reachable as window.__PAGE_TURN__.audit()
 * from the devtools console or the e2e driver.
 */

export const auditLog: string[] = [];

let seq = 0;

export function audit(entry: string): void {
  // A monotonic sequence + clock time: the old (Date.now() % 1_000_000)/10
  // stamp wrapped every ~16.7 minutes, scrambling entry order across the wrap.
  auditLog.push(
    `${String(++seq).padStart(5, '0')} ${new Date().toISOString().slice(11, 23)} ${entry}`,
  );
  if (auditLog.length > 200) auditLog.shift();
}
