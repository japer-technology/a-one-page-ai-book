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
    const outcome = await exportCompiledFile(compiled, format, {
      readingFont: api.lib.settings.readingFont,
      documentFonts: api.lib.settings.documentFonts,
    });
    // A cancelled picker is a silent no-op. A single-book export must NOT
    // reset the whole-library backup nudge (exporting one chapter used to
    // silence the only backup prompt the app has).
    if (outcome === 'saved') {
      api.toast('Book exported', 'success');
    } else if (outcome === 'download-attempted') {
      api.toast(
        'Export started — check your Downloads folder. Allow downloads if it is missing.',
        'info',
      );
    }
  } catch (err) {
    api.toast(err instanceof Error ? err.message : 'Export failed', 'error');
  }
}
