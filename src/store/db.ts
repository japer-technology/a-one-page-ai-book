/**
 * store/db.ts — the always-on local database.
 *
 * The entire library (books + every node + settings) is one JSON document in
 * IndexedDB — a real local file, written continuously, so nothing is ever lost
 * between sessions. Wrapped so failures degrade to in-memory use gracefully.
 */
import type { Library } from '../core/types';
import { defaultLibrary, normalizeLibrary } from '../core/schema';

const DB_NAME = 'page-turn';
const DB_VERSION = 1;
const STORE = 'library';
const KEY = 'library';

let dbPromise: Promise<IDBDatabase> | null = null;
/** The document as read, kept so a failed load can still be salvaged. */
let lastRead: unknown;

export function dbSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      // Without `onblocked` a version upgrade held open by another tab left
      // this promise pending FOREVER — and every later save awaited it, so
      // persistence died silently for the rest of the session.
      request.onblocked = () =>
        reject(new Error('IndexedDB is blocked by another Page Turn tab — close it and reload'));
      request.onsuccess = () => {
        const db = request.result;
        // A connection can be closed under us (browser eviction, another tab
        // upgrading): drop the cache so the next call reopens instead of
        // throwing InvalidStateError on every transaction.
        db.onclose = () => {
          if (dbPromise === attempt) dbPromise = null;
        };
        db.onversionchange = () => {
          db.close();
          if (dbPromise === attempt) dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    // Never cache a rejection: one transient failure must not disable
    // persistence until the page is reloaded.
    dbPromise = attempt.catch((err: unknown) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * The outcome of a boot read. `ok: false` means we could NOT read the stored
 * document — which is emphatically not the same as "there is nothing stored".
 *
 * The distinction is the difference between a slow start and total data loss:
 * the app used to treat a validation failure or a read error as "empty
 * library", render an empty shelf, and then write that empty library straight
 * over the intact record on the next autosave (or on beforeunload). Callers
 * must never persist an `ok: false` result.
 */
export interface LoadResult {
  lib: Library;
  ok: boolean;
  /** Why the read failed, for the notice shown to the reader. */
  error?: string;
  /**
   * The stored document exactly as it was read, when it failed to validate.
   * Printed to the console on a failed boot so the words are still recoverable
   * by hand — the alternative was silently replacing them with an empty shelf.
   */
  raw?: unknown;
}

export async function loadLibrary(): Promise<LoadResult> {
  if (!dbSupported()) return { lib: defaultLibrary(), ok: true };
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const result = await requestResult(tx.objectStore(STORE).get(KEY));
    lastRead = result;
    if (result === undefined) return { lib: defaultLibrary(), ok: true };
    // Normalize on the way in: a hand-edited or older-schema document must
    // never reach boot as a malformed object (boot reads lib.books before any
    // guard) — but a document that fails validation is a FAILED load, not an
    // empty library.
    return { lib: normalizeLibrary(result as Library), ok: true };
  } catch (err) {
    return {
      lib: defaultLibrary(),
      ok: false,
      error: err instanceof Error ? err.message : 'the stored library could not be read',
      raw: lastRead,
    };
  }
}

/**
 * The stored document's revision WITHOUT a full normalize (saves run often
 * and a normalize is expensive). Returns null when nothing is stored yet.
 */
export async function peekStoredLibrary(): Promise<{ updatedAt: number } | null> {
  if (!dbSupported()) return null;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const result = await requestResult(tx.objectStore(STORE).get(KEY));
    if (result === undefined || result === null) return null;
    if (typeof result === 'object' && result !== null) {
      const meta = (result as { meta?: { updatedAt?: unknown } }).meta;
      const updatedAt = meta?.updatedAt;
      if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) return { updatedAt };
    }
    return { updatedAt: 0 };
  } catch {
    return null;
  }
}

export async function saveLibrary(lib: Library): Promise<void> {
  if (!dbSupported()) return;
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(lib, KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
}

/**
 * Park an unreadable document under a separate key before anything else
 * happens. Writing a different key can never destroy the original, so this is
 * safe even when we have decided not to touch the main record at all — and it
 * turns "your books are gone" into "your books are recoverable by hand".
 */
export async function stashUnreadableDocument(raw: unknown): Promise<string | null> {
  if (!dbSupported() || raw === undefined) return null;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const key = `${KEY}.unreadable.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    tx.objectStore(STORE).put(raw, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
    });
    return key;
  } catch {
    return null;
  }
}

export async function clearLibrary(): Promise<void> {
  if (!dbSupported()) return;
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB clear failed'));
    // Transactions can abort without a request-level error event; without this
    // the "Wipe everything" path hung with no toast and no error.
    tx.onabort = () =>
      reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
  });
}

/** Ask the browser to keep this app's data (works best on file:// in Chrome/Edge). */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    // not available
  }
  return false;
}

export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      if (est.usage !== undefined && est.quota !== undefined) {
        return { usage: est.usage, quota: est.quota };
      }
    }
  } catch {
    // not available
  }
  return null;
}
