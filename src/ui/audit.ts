/**
 * ui/audit.ts — a tiny in-memory event trail for deep debugging.
 *
 * The app is local-first with no telemetry, so when something misbehaves the
 * only evidence is this ring buffer — reachable as window.__PAGE_TURN__.audit()
 * from the devtools console or the e2e driver.
 */

export const auditLog: string[] = [];

export function audit(entry: string): void {
  auditLog.push(`${Math.floor((Date.now() % 1_000_000) / 10)} ${entry}`);
  if (auditLog.length > 200) auditLog.shift();
}
