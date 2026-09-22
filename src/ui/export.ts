/**
 * ui/export.ts — export a compiled book with a toast on failure. Every
 * export path funnels through here so a malformed book or a refused picker
 * can never fail silently.
 */
import type { AppApi } from './ctx';
import { exportCompiledFile, type ExportFormat } from '../store/files';
import type { CompiledBook } from '../core/compile';

export async function exportCompiled(
  api: AppApi,
  compiled: CompiledBook,
  format: ExportFormat,
): Promise<void> {
  try {
    const exported = await exportCompiledFile(compiled, format, {
      readingFont: api.lib.settings.readingFont,
      documentFonts: api.lib.settings.documentFonts,
    });
    // A cancelled picker is a no-op: the backup nudge must keep counting.
    if (exported) api.markExported();
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Export failed', 'error');
  }
}
