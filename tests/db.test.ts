import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLibrary } from '../src/core/schema';

/**
 * A minimal in-memory IndexedDB, enough for store/db.ts: one store, the four
 * request kinds it uses, and a `close` the test can fire the way a browser
 * does when it evicts or another tab upgrades.
 */
class FakeStore {
  data = new Map<string, unknown>();
  get(key: string) {
    return request(() => this.data.get(key));
  }
  put(value: unknown, key: string) {
    this.data.set(key, structuredClone(value));
    return request(() => key);
  }
  delete(key: string) {
    this.data.delete(key);
    return request(() => undefined);
  }
  clear() {
    this.data.clear();
    return request(() => undefined);
  }
}

interface FakeRequest<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function request<T>(produce: () => T): FakeRequest<T> {
  const req: FakeRequest<T> = {
    result: undefined as T,
    error: null,
    onsuccess: null,
    onerror: null,
  };
  // Async like the real thing: `requestResult` attaches its handlers after the
  // call returns.
  queueMicrotask(() => {
    try {
      req.result = produce();
      req.onsuccess?.();
    } catch (err) {
      req.error = err;
      req.onerror?.();
    }
  });
  return req;
}

class FakeDb {
  stores = new Map<string, FakeStore>();
  closed = false;
  /** The browser's "your connection is gone" event; db.ts listens for it. */
  onclose: (() => void) | null = null;
  onversionchange: (() => void) | null = null;
  constructor(public name: string) {
    this.stores.set('library', new FakeStore());
  }
  get objectStoreNames() {
    return { contains: (name: string) => this.stores.has(name) };
  }
  createObjectStore(name: string) {
    this.stores.set(name, new FakeStore());
    return this.stores.get(name);
  }
  transaction(name: string) {
    if (this.closed) {
      // What Chromium throws for a connection that has been closed under us.
      throw new Error(`The database connection "${name}" is closing.`);
    }
    const store = this.stores.get(name);
    if (!store) throw new Error(`no store ${name}`);
    const tx = {
      error: null as unknown,
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      objectStore: () => store,
    };
    queueMicrotask(() => tx.oncomplete?.());
    return tx;
  }
  close() {
    this.closed = true;
    queueMicrotask(() => this.onclose?.());
  }
}

/** Wipe every key the app owns, for assertions about the empty case. */
function fakeIndexedDB() {
  const opened: FakeDb[] = [];
  let opens = 0;
  const factory = {
    open(name: string) {
      opens++;
      let db: FakeDb | undefined = opened.find((candidate) => candidate.name === name);
      const fresh = db === undefined;
      if (!db) {
        db = new FakeDb(name);
        opened.push(db);
      } else {
        // Opening a closed database hands back a live connection.
        db.closed = false;
      }
      const req = {
        result: undefined as FakeDb | undefined,
        error: null as unknown,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      };
      queueMicrotask(() => {
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory, opened, openCount: () => opens };
}

let fake: ReturnType<typeof fakeIndexedDB>;

/** A freshly imported store/db.ts talking to a brand-new fake database. */
async function freshDb() {
  vi.resetModules();
  vi.stubGlobal('indexedDB', fake.factory);
  return await import('../src/store/db');
}

beforeEach(() => {
  fake = fakeIndexedDB();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('store/db persistence', () => {
  it('reopens after the browser closes the connection', async () => {
    // Symptom: the cached connection was kept forever (`dbPromise` holds
    // `attempt.catch(…)`, which never equals `attempt`), so every later read
    // and write threw InvalidStateError and the reader's writing stopped being
    // saved at all — "your latest changes are only in memory" on every save.
    const db = await freshDb();
    const first = await db.loadLibrary();
    expect(first.ok).toBe(true);
    expect(fake.openCount()).toBe(1);

    fake.opened[0]!.closed = true;
    fake.opened[0]!.onclose?.();

    const second = await db.loadLibrary();
    expect(second.ok, `second load failed: ${second.error ?? ''}`).toBe(true);
    expect(fake.openCount(), 'the closed connection was reused').toBe(2);
    // ...and writing works again, which is the part the reader feels.
    await expect(db.saveLibrary(defaultLibrary())).resolves.toBeUndefined();
  });

  it('keeps saving after a version change from another tab', async () => {
    const db = await freshDb();
    await db.loadLibrary();
    fake.opened[0]!.onversionchange?.();
    await expect(db.saveLibrary(defaultLibrary())).resolves.toBeUndefined();
    expect(fake.openCount()).toBe(2);
  });

  it('never caches a failed open', async () => {
    const db = await freshDb();
    const broken = {
      open: () => {
        const req = {
          result: undefined,
          error: new Error('quota'),
          onupgradeneeded: null as (() => void) | null,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onblocked: null as (() => void) | null,
        };
        queueMicrotask(() => req.onerror?.());
        return req;
      },
    };
    vi.stubGlobal('indexedDB', broken);
    const failed = await db.loadLibrary();
    expect(failed.ok).toBe(false);
    // The next attempt uses a working database instead of the cached rejection.
    vi.stubGlobal('indexedDB', fake.factory);
    const retry = await db.loadLibrary();
    expect(retry.ok).toBe(true);
    expect(fake.openCount()).toBe(1);
  });
});

describe('store/db wipe', () => {
  it("leaves nothing of the reader's words behind", async () => {
    // The button says "Delete every book, every page, every decision?" — and it
    // only removed the main record, so the complete copy parked by
    // `stashUnreadableDocument` stayed in the profile forever, invisible.
    const db = await freshDb();
    await db.saveLibrary(defaultLibrary());
    const stashed = await db.stashUnreadableDocument({
      books: [{ title: 'The Dead Letter' }],
      nodes: { p1: { text: 'the words themselves' } },
    });
    expect(stashed).not.toBeNull();
    const store = fake.opened[0]!.stores.get('library')!;
    expect(store.data.size).toBe(2);

    await db.clearLibrary();
    expect([...store.data.keys()]).toEqual([]);
  });

  it('a stash that was queued before a wipe never lands after it', async () => {
    // A failed boot read spawns a stash; the reader then confirms “Delete
    // every book, every page, every decision?”. The stash's put used to land
    // after the wipe's clear(), re-parking a full copy of the deleted story.
    const db = await freshDb();
    await db.loadLibrary();
    // Close the connection so the next openDB is genuinely async — the race
    // lives in that window.
    fake.opened[0]!.closed = true;
    fake.opened[0]!.onclose?.();
    const stashing = db.stashUnreadableDocument({ words: 'the words themselves' });
    await db.clearLibrary();
    expect(await stashing).toBeNull();
    const store = fake.opened[0]!.stores.get('library')!;
    expect([...store.data.keys()]).toEqual([]);
  });

  it('reports a failed peek instead of “nothing stored”', async () => {
    // Collapsing the two states let a stale tab skip the cross-tab guard and
    // overwrite another tab's newer document.
    const db = await freshDb();
    await db.saveLibrary(defaultLibrary());
    const first = await db.peekStoredLibrary();
    expect(first.ok).toBe(true);
    expect(first.stored).not.toBeNull();

    fake.opened[0]!.closed = true;
    fake.opened[0]!.onclose?.();
    const broken = {
      open: () => {
        const req = {
          result: undefined,
          error: new Error('quota'),
          onupgradeneeded: null as (() => void) | null,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onblocked: null as (() => void) | null,
        };
        queueMicrotask(() => req.onerror?.());
        return req;
      },
    };
    vi.stubGlobal('indexedDB', broken);
    const failed = await db.peekStoredLibrary();
    expect(failed.ok).toBe(false);
    expect(failed.stored).toBeNull();
  });
});
