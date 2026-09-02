/** Collision-safe node ids. crypto.randomUUID is available in every secure context (file:// included). */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for odd environments: 128 bits of Math.random is still fine for local ids.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
