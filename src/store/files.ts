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
import { bookFileName, toMarkdown, toPlainText, type CompiledBook } from '../core/compile';
import { epubBytes } from '../core/epub';
import { pdfBytes } from '../core/pdf';

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

async function writeWithPicker(suggestedName: string, blob: Blob): Promise<boolean> {
  if (!hasFilePicker()) return false;
  try {
    const handle = await window.showSaveFilePicker({ suggestedName });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return true; // cancelled, not an error
    return false;
  }
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function saveTextFile(
  suggestedName: string,
  text: string,
  mime: string,
): Promise<void> {
  const blob = new Blob([text], { type: mime });
  if (!(await writeWithPicker(suggestedName, blob))) downloadBlob(suggestedName, blob);
}

/** Save the whole library (every book, every node, every decision) as one JSON file. */
export async function exportLibraryFile(lib: Library): Promise<void> {
  const payload = JSON.stringify(lib, null, 2);
  await saveTextFile('page-turn-library.ptlibrary.json', payload, 'application/json');
}

/** Save ONE book + its subtree as a portable .ptbook.json share file. */
export async function exportBookBundle(
  book: Book,
  nodes: Record<string, StoryNode>,
): Promise<void> {
  const subtree: Record<string, StoryNode> = {};
  for (const node of collectSubtree(nodes, book.seedNodeId)) subtree[node.id] = node;
  const bundle: BookBundle = { format: 'page-turn-book', version: 1, book, nodes: subtree };
  const name = `book-${book.id.slice(0, 8)}.ptbook.json`;
  await saveTextFile(name, JSON.stringify(bundle, null, 2), 'application/json');
}

export type ExportFormat = 'txt' | 'md' | 'epub' | 'pdf';

export async function exportCompiledFile(
  compiled: CompiledBook,
  format: ExportFormat,
): Promise<void> {
  if (format === 'pdf') {
    const bytes = pdfBytes(compiled);
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
    await saveBlobFile(bookFileName(compiled, 'pdf'), blob);
  } else if (format === 'epub') {
    const bytes = epubBytes(compiled);
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/epub+zip' });
    await saveBlobFile(bookFileName(compiled, 'epub'), blob);
  } else if (format === 'md') {
    await saveTextFile(bookFileName(compiled, 'md'), toMarkdown(compiled), 'text/markdown');
  } else {
    await saveTextFile(bookFileName(compiled, 'txt'), toPlainText(compiled), 'text/plain');
  }
}

/** Save an already-built blob (EPUB and other binary formats). */
export async function saveBlobFile(suggestedName: string, blob: Blob): Promise<void> {
  if (!(await writeWithPicker(suggestedName, blob))) downloadBlob(suggestedName, blob);
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
