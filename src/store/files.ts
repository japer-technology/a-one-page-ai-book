/**
 * store/files.ts — read and write real local files.
 *
 * Three complementary mechanisms, best-first:
 *   1. File System Access API (showOpenFilePicker / showSaveFilePicker):
 *      true read/write of user-chosen files, no download folder required.
 *   2. Origin Private File System (OPFS): a private directory the app owns —
 *      a real on-disk workspace file, no permission prompts.
 *   3. Fallbacks (<input type=file>, Blob + <a download>): everywhere else.
 */
import type { Library, StoryNode } from '../core/types';
import type { Book } from '../core/types';
import { redactUrl } from '../llm/endpoints';
import { audit } from '../ui/audit';
import { normalizeLibrary, type BookBundle } from '../core/schema';
import { collectSubtree } from '../core/tree';
import {
  bookFileName,
  toDirectorCut,
  toMarkdown,
  toPlainText,
  type CompiledBook,
} from '../core/compile';
import { epubBytes } from '../core/epub';
import { ZipWriter } from '../core/zip';
import { mdLibraryEntries } from '../core/mdfiles';
import { pdfBytes, type PdfFontPrefs } from '../core/pdf';
import { midiBytes } from '../core/midi';

/**
 * The File System Access picker methods are absent from this TypeScript
 * version's lib.dom.d.ts, so declare the minimal surface we use. The runtime
 * `hasFilePicker()` guard keeps non-supporting browsers safe.
 */
interface FilePickerTypesOption {
  description?: string;
  accept: Record<string, string[]>;
}

/**
 * `FileSystemDirectoryHandle` is async-iterable in every browser that ships
 * OPFS, but this TypeScript version's lib.dom.d.ts does not declare it.
 */
interface OpfsDirectoryHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

declare global {
  interface Window {
    showOpenFilePicker(options?: {
      multiple?: boolean;
      types?: FilePickerTypesOption[];
    }): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker(options?: {
      suggestedName?: string;
      types?: FilePickerTypesOption[];
    }): Promise<FileSystemFileHandle>;
  }
}

export function hasFilePicker(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

export function hasOpfs(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

let opfsProbe: Promise<boolean> | null = null;

/**
 * Does OPFS actually WORK here? `hasOpfs()` only checks that the method
 * exists, and on `file://` — the app's flagship deployment — `getDirectory()`
 * exists but throws SecurityError. The UI therefore promised a second on-disk
 * copy of the library that never existed. Probe once, for real.
 */
export function opfsAvailable(): Promise<boolean> {
  if (!hasOpfs()) return Promise.resolve(false);
  opfsProbe ??= (async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.getFileHandle('.page-turn-probe', { create: true });
      await root.removeEntry('.page-turn-probe').catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  })();
  return opfsProbe;
}

// ---- Reading --------------------------------------------------------------

async function pickTextFile(accept: string): Promise<File | null> {
  if (hasFilePicker()) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'Page Turn file', accept: { 'application/json': [accept] } }],
      });
      return handle === undefined ? null : await handle.getFile();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null; // user cancelled
      // fall through to <input> on any picker failure
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      window.removeEventListener('focus', onFocus);
      resolve(file);
    };
    // `oncancel` is only supported from Chrome 113 / Firefox 91 / Safari 16.4 —
    // below that (the build targets Safari 16) the handler is a silent no-op
    // and this promise never settled, so Import appeared to do nothing.
    input.onchange = () => finish(input.files?.[0] ?? null);
    input.oncancel = () => finish(null);
    // Detached inputs are unreliable in some engines: attach it, and treat the
    // chooser closing without a selection (window regains focus) as cancelled.
    input.style.display = 'none';
    document.body.appendChild(input);
    let armed = false;
    const onFocus = () => {
      if (!armed) return;
      // Give the change event a beat to land after focus returns.
      setTimeout(() => finish(input.files?.[0] ?? null), 300);
    };
    window.addEventListener('focus', onFocus);
    input.click();
    armed = true;
  });
}

/**
 * Read a chosen .json file and return its PARSED payload, untouched.
 *
 * Callers hand this to `api.importDropped`, which already implements the right
 * semantics for both formats (a `.ptbook.json` is ADDED to the shelf, with its
 * ids cloned on collision; a `.ptlibrary.json` replaces the library after a
 * confirmation). Returning a normalized Library from here meant a single-book
 * file — which the toolbar's own tooltip invites — silently REPLACED the whole
 * shelf with that one book.
 */
export async function readImportFile(): Promise<unknown | null> {
  const file = await pickTextFile('.json');
  if (!file) return null;
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`"${file.name}" is not valid JSON`);
  }
}

export async function readOpfsLibrary(): Promise<{
  lib: Library;
  mirroredAt: string | null;
} | null> {
  // The real probe, not `hasOpfs()`: on file:// the method exists but throws.
  if (!(await opfsAvailable())) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('library.json');
    const file = await handle.getFile();
    const lib = normalizeLibrary(JSON.parse(await file.text()));
    let mirroredAt: string | null = null;
    try {
      const stamp = await root.getFileHandle('mirror-stamp.txt');
      mirroredAt = (await (await stamp.getFile()).text()).trim() || null;
    } catch {
      // no stamp — pre-stamp mirror
    }
    return { lib, mirroredAt };
  } catch {
    return null;
  }
}

// ---- Writing --------------------------------------------------------------

/**
 * Try the File System Access picker. Distinguishes "user cancelled" from
 * failure so callers can stay silent instead of falling back to a download
 * the user never asked for (or claiming an export that didn't happen).
 */
async function writeWithPicker(
  suggestedName: string,
  blob: Blob,
): Promise<'saved' | 'cancelled' | 'failed'> {
  if (!hasFilePicker()) return 'failed';
  try {
    const handle = await window.showSaveFilePicker({ suggestedName });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return 'saved';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    return 'failed';
  }
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  // Firefox ignores clicks on detached anchors — attach first.
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/**
 * Save a text file. Returns how it left the app: `saved` (picker confirmed the
 * write), `download-attempted` (browser download started — it normally lands
 * in the Downloads folder, but a blocked download is indistinguishable), or
 * `cancelled` (the reader dismissed the picker).
 */
export type SaveOutcome = 'saved' | 'download-attempted' | 'cancelled';

export async function saveTextFile(
  suggestedName: string,
  text: string,
  mime: string,
): Promise<SaveOutcome> {
  const blob = new Blob([text], { type: mime });
  const result = await writeWithPicker(suggestedName, blob);
  if (result === 'cancelled') return 'cancelled';
  if (result === 'failed') {
    downloadBlob(suggestedName, blob);
    return 'download-attempted';
  }
  return 'saved';
}

/**
 * Save the whole library (every book, every node, every decision) as one JSON
 * file — WITHOUT the API key. The file is meant to be moved between machines
 * and shared; embedding a working bearer secret (or credentials typed into the
 * base URL) made a routine backup a credential leak.
 */
/**
 * The portable library document: everything EXCEPT the bearer secret and any
 * credentials typed into the base URL. Kept separate so the redaction itself
 * is unit-testable.
 */
export function redactedLibrary(lib: Library): Library {
  return {
    ...lib,
    settings: {
      ...lib.settings,
      endpoint: {
        ...lib.settings.endpoint,
        apiKey: '',
        baseUrl: redactUrl(lib.settings.endpoint.baseUrl),
      },
    },
  };
}

export async function exportLibraryFile(lib: Library): Promise<SaveOutcome> {
  const payload = JSON.stringify(redactedLibrary(lib), null, 2);
  return saveTextFile('page-turn-library.ptlibrary.json', payload, 'application/json');
}

/** Save ONE book + its subtree as a portable .ptbook.json share file. */
export async function exportBookBundle(
  book: Book,
  nodes: Record<string, StoryNode>,
): Promise<SaveOutcome> {
  const subtree: Record<string, StoryNode> = {};
  for (const node of collectSubtree(nodes, book.seedNodeId)) subtree[node.id] = node;
  const bundle: BookBundle = { format: 'page-turn-book', version: 1, book, nodes: subtree };
  const name = `book-${book.id.slice(0, 8)}.ptbook.json`;
  return saveTextFile(name, JSON.stringify(bundle, null, 2), 'application/json');
}

export type ExportFormat = 'txt' | 'md' | 'epub' | 'pdf' | 'midi' | 'directorcut';

/**
 * Export a compiled book. Returns true when a file actually landed on disk
 * (a cancelled picker is a silent false — not an error, not an export).
 * `fonts` carries the app's reading-font choices so the PDF/EPUB honor the
 * reader's font selection (serif → Times, sans → Helvetica, map notes →
 * Courier).
 */
export async function exportCompiledFile(
  compiled: CompiledBook,
  format: ExportFormat,
  fonts?: PdfFontPrefs,
): Promise<SaveOutcome> {
  if (format === 'midi') {
    const bytes = midiBytes(compiled);
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'audio/midi' });
    return saveBlobFile(bookFileName(compiled, 'mid'), blob);
  } else if (format === 'directorcut') {
    // The same id suffix every other format carries: two books with the same
    // title used to suggest the SAME filename, silently overwriting one
    // export with the other.
    return saveTextFile(
      `${slugifyForName(compiled.title)}-${compiled.id.slice(0, 8)}-directors-cut.md`,
      toDirectorCut(compiled),
      'text/markdown',
    );
  } else if (format === 'pdf') {
    const bytes = pdfBytes(compiled, fonts);
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
    return saveBlobFile(bookFileName(compiled, 'pdf'), blob);
  } else if (format === 'epub') {
    const bytes = epubBytes(compiled, fonts);
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/epub+zip' });
    return saveBlobFile(bookFileName(compiled, 'epub'), blob);
  } else if (format === 'md') {
    return saveTextFile(bookFileName(compiled, 'md'), toMarkdown(compiled), 'text/markdown');
  }
  return saveTextFile(bookFileName(compiled, 'txt'), toPlainText(compiled), 'text/plain');
}

/** Save an already-built blob (EPUB and other binary formats). */
function slugifyForName(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'book'
  );
}

export async function saveBlobFile(suggestedName: string, blob: Blob): Promise<SaveOutcome> {
  const result = await writeWithPicker(suggestedName, blob);
  if (result === 'cancelled') return 'cancelled';
  if (result === 'failed') {
    downloadBlob(suggestedName, blob);
    return 'download-attempted';
  }
  return 'saved';
}

/**
 * The alternative file structure: the whole library as plain .md files
 * (README, index, one file per book), zipped for download.
 */
export async function exportLibraryMarkdown(lib: Library): Promise<SaveOutcome> {
  const zip = new ZipWriter();
  for (const entry of mdLibraryEntries(lib)) zip.add(entry.name, entry.content);
  const blob = new Blob([zip.finish() as unknown as BlobPart], { type: 'application/zip' });
  return saveBlobFile('page-turn-library-markdown.zip', blob);
}

/**
 * Mirror the library into OPFS as plain .md files (books/<title>.md + index.md)
 * alongside the JSON document — a fully readable on-disk file structure.
 *
 * Gated on `opfsAvailable()` rather than `hasOpfs()`: on `file://` — the app's
 * flagship deployment — the method EXISTS but every call throws SecurityError,
 * so the gate let the mirror run, fail, and (worse, in `writeOpfsLibrary`)
 * write a SecurityError into the audit log on every single save.
 */
export async function writeMdLibrary(lib: Library): Promise<void> {
  if (!(await opfsAvailable())) return;
  try {
    const root = await navigator.storage.getDirectory();
    const booksDir = await root.getDirectoryHandle('books', { create: true });
    const wanted = new Set<string>();
    for (const entry of mdLibraryEntries(lib)) {
      const parts = entry.name.split('/');
      const dir = parts.length > 1 ? booksDir : root;
      const name = parts[parts.length - 1] ?? entry.name;
      wanted.add(entry.name);
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(entry.content);
      await writable.close();
    }
    // The mirror is WRITE-ONLY otherwise: a deleted book, a rename or a full
    // "wipe everything" left its markdown behind on disk forever — so the
    // Danger-zone promise was not true, and the mirror accumulated ghosts.
    for await (const [name, handle] of (booksDir as OpfsDirectoryHandle).entries()) {
      if (handle.kind !== 'file') continue;
      if (wanted.has(`books/${name}`)) continue;
      await booksDir.removeEntry(name).catch(() => undefined);
    }
  } catch {
    // best-effort mirror
  }
}

/** Remove the OPFS workspace entirely (used by "Wipe everything"). */
export async function clearOpfsLibrary(): Promise<void> {
  if (!(await opfsAvailable())) return;
  try {
    const root = await navigator.storage.getDirectory();
    // Wipe EVERYTHING the app owns — including `library.json.tmp`, which a
    // failed/interrupted write could otherwise leave behind with the full
    // story text after the reader pressed "Delete every book…".
    for await (const [name] of (root as OpfsDirectoryHandle).entries()) {
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
  } catch {
    // best-effort
  }
}

/** Mirror the library into the OPFS workspace file (a real local file, no prompts). */
export async function writeOpfsLibrary(lib: Library): Promise<boolean> {
  // `hasOpfs()` is true on `file://` even though every OPFS call there throws
  // SecurityError; the real probe is what keeps this from failing (and logging
  // a scary SecurityError) on every save in the app's primary deployment.
  if (!(await opfsAvailable())) return false;
  try {
    const root = await navigator.storage.getDirectory();
    const payload = JSON.stringify(lib);
    // Write beside the live file and swap it in. `createWritable()` truncates
    // on open, so an interruption mid-write left a truncated `library.json` —
    // and that is the copy boot falls back to when IndexedDB is unreadable.
    const temp = await root.getFileHandle('library.json.tmp', { create: true });
    const writable = await temp.createWritable();
    await writable.write(payload);
    await writable.close();
    // `move?.(…)` does NOT throw when the browser lacks `FileSystemFileHandle.
    // move` — optional-call returns undefined — so the "no move()" fallback
    // never ran: the live `library.json` was never created or updated, while
    // the stamp was refreshed to "now" and this function returned true. Boot's
    // recovery path then read a stale or absent mirror that claimed to be
    // current. Branch on the method's existence instead of on a throw.
    const moveFn = (
      temp as FileSystemFileHandle & {
        move?: (dir: FileSystemDirectoryHandle, name: string) => Promise<void>;
      }
    ).move;
    let swapped = false;
    if (typeof moveFn === 'function') {
      try {
        await moveFn.call(temp, root, 'library.json');
        swapped = true;
      } catch {
        // move() exists but refused (a different OPFS backend): copy instead.
      }
    }
    if (!swapped) {
      const handle = await root.getFileHandle('library.json', { create: true });
      const writable2 = await handle.createWritable();
      await writable2.write(payload);
      await writable2.close();
      await root.removeEntry('library.json.tmp').catch(() => undefined);
    }
    // Stamp when the mirror was current, so a recovery-by-mirror can say how
    // stale it is instead of silently adopting a weeks-old copy as the truth.
    const stamp = await root.getFileHandle('mirror-stamp.txt', { create: true });
    const stampWritable = await stamp.createWritable();
    await stampWritable.write(new Date().toISOString());
    await stampWritable.close();
    return true;
  } catch (err) {
    // The mirror failing must not be silent: the UI promises a second copy.
    audit(`opfs mirror write failed err=${String(err)}`);
    return false;
  }
}
