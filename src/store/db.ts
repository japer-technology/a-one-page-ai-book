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

export function dbSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
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

export async function loadLibrary(): Promise<Library> {
  if (!dbSupported()) return defaultLibrary();
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const result = await requestResult(tx.objectStore(STORE).get(KEY));
    if (result === undefined) return defaultLibrary();
    // Normalize on the way in: a hand-edited or older-schema document must
    // never reach boot as a malformed object (boot reads lib.books before any
    // guard). A document that fails validation degrades to a fresh library
    // instead of crashing the whole app.
    return normalizeLibrary(result as Library);
  } catch {
    return defaultLibrary();
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

export async function clearLibrary(): Promise<void> {
  if (!dbSupported()) return;
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB clear failed'));
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
