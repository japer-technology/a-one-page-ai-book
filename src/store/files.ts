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
import {
  defaultLibrary,
  isBookBundle,
  normalizeBookBundle,
  normalizeLibrary,
  type BookBundle,
} from '../core/schema';
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
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Import a full library (.ptlibrary.json) or a single book (.ptbook.json). */
export async function importLibraryFile(): Promise<Library | null> {
  const file = await pickTextFile('.json');
  if (!file) return null;
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`"${file.name}" is not valid JSON`);
  }
  if (file.name.endsWith('.ptbook.json') || isBookBundle(parsed)) {
    const { book, nodes } = normalizeBookBundle(parsed);
    return { ...defaultLibrary(), books: [book], nodes };
  }
  return normalizeLibrary(parsed);
}

export async function readOpfsLibrary(): Promise<Library | null> {
  if (!hasOpfs()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('library.json');
    const file = await handle.getFile();
    return normalizeLibrary(JSON.parse(await file.text()));
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

/** True when a file actually reached disk (picker saved or download fallback). */
export async function saveTextFile(
  suggestedName: string,
  text: string,
  mime: string,
): Promise<boolean> {
  const blob = new Blob([text], { type: mime });
  const result = await writeWithPicker(suggestedName, blob);
  if (result === 'cancelled') return false;
  if (result === 'failed') downloadBlob(suggestedName, blob);
  return true;
}

/** Save the whole library (every book, every node, every decision) as one JSON file. */
export async function exportLibraryFile(lib: Library): Promise<boolean> {
  const payload = JSON.stringify(lib, null, 2);
  return saveTextFile('page-turn-library.ptlibrary.json', payload, 'application/json');
}

/** Save ONE book + its subtree as a portable .ptbook.json share file. */
export async function exportBookBundle(
  book: Book,
  nodes: Record<string, StoryNode>,
): Promise<boolean> {
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
): Promise<boolean> {
  if (format === 'midi') {
    const bytes = midiBytes(compiled);
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'audio/midi' });
    return saveBlobFile(bookFileName(compiled, 'mid'), blob);
  } else if (format === 'directorcut') {
    return saveTextFile(
      `${slugifyForName(compiled.title)}-directors-cut.md`,
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

export async function saveBlobFile(suggestedName: string, blob: Blob): Promise<boolean> {
  const result = await writeWithPicker(suggestedName, blob);
  if (result === 'cancelled') return false;
  if (result === 'failed') downloadBlob(suggestedName, blob);
  return true;
}

/**
 * The alternative file structure: the whole library as plain .md files
 * (README, index, one file per book), zipped for download.
 */
export async function exportLibraryMarkdown(lib: Library): Promise<boolean> {
  const zip = new ZipWriter();
  for (const entry of mdLibraryEntries(lib)) zip.add(entry.name, entry.content);
  const blob = new Blob([zip.finish() as unknown as BlobPart], { type: 'application/zip' });
  return saveBlobFile('page-turn-library-markdown.zip', blob);
}

/**
 * Mirror the library into OPFS as plain .md files (books/<title>.md + index.md)
 * alongside the JSON document — a fully readable on-disk file structure.
 */
export async function writeMdLibrary(lib: Library): Promise<void> {
  if (!hasOpfs()) return;
  try {
    const root = await navigator.storage.getDirectory();
    const booksDir = await root.getDirectoryHandle('books', { create: true });
    for (const entry of mdLibraryEntries(lib)) {
      const parts = entry.name.split('/');
      const dir = parts.length > 1 ? booksDir : root;
      const name = parts[parts.length - 1] ?? entry.name;
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(entry.content);
      await writable.close();
    }
  } catch {
    // best-effort mirror
  }
}

/** Mirror the library into the OPFS workspace file (a real local file, no prompts). */
export async function writeOpfsLibrary(lib: Library): Promise<boolean> {
  if (!hasOpfs()) return false;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('library.json', { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(lib));
    await writable.close();
    return true;
  } catch {
    return false;
  }
}
