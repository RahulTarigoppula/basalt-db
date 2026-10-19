/**
 * IndexedDB fallback backend for browsers (or contexts) without OPFS sync access handles.
 *
 * IndexedDB is asynchronous, but the Pager needs synchronous page I/O, so this backend loads the
 * **whole file into memory at `open()`** and writes back lazily: `writeSync` only marks pages dirty,
 * and `syncSync()` schedules an asynchronous flush of the dirty pages in one IDB transaction.
 *
 * **Durability caveat.** A commit is durable only once the scheduled flush has completed. If the
 * page is closed or crashes between `syncSync()` and the flush finishing, the last commit(s) may be
 * lost - but the on-disk image is still *consistent*: a flush writes data pages and meta pages in
 * one IDB transaction, and IDB transactions are atomic, so a reopen sees either the old or the new
 * commit, never a torn one. Call `await backend.close()` (or `await backend.flushed()`) to wait for
 * durability. Prefer `OpfsBackend` whenever it is available.
 */
import { StorageError } from "../core/errors";
import { type Backend } from "./backend";
import { PAGE_SIZE } from "./page";

const STORE = "pages";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new StorageError("IndexedDB request failed"));
  });
}

function awaitTxn(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new StorageError("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new StorageError("IndexedDB transaction aborted"));
  });
}

export class IndexedDbBackend implements Backend {
  readonly pageSize = PAGE_SIZE;
  private pages: Uint8Array[];
  private dirty = new Set<number>();
  /** Page count as last flushed; pages at or beyond it that no longer exist are deleted on flush. */
  private storedCount: number;
  private flushPromise: Promise<void> | null = null;
  private flushScheduled = false;
  private closed = false;

  private constructor(readonly name: string, private readonly db: IDBDatabase, pages: Uint8Array[]) {
    this.pages = pages;
    this.storedCount = pages.length;
  }

  /** Opens database `name` (one IDB database per Basalt file) and loads every page into memory. */
  static async open(name: string): Promise<IndexedDbBackend> {
    if (typeof indexedDB === "undefined") throw new StorageError("IndexedDB is not available in this environment");
    const openReq = indexedDB.open(`basalt:${name}`, 1);
    openReq.onupgradeneeded = () => { openReq.result.createObjectStore(STORE); };
    const db = await request(openReq);
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const keys = (await request(store.getAllKeys())) as number[];
    const values = (await request(store.getAll())) as ArrayBuffer[];
    const pages: Uint8Array[] = [];
    for (let i = 0; i < keys.length; i++) pages[keys[i]!] = new Uint8Array(values[i]!);
    for (let i = 0; i < pages.length; i++) if (pages[i] === undefined) pages[i] = new Uint8Array(PAGE_SIZE);
    await awaitTxn(tx);
    return new IndexedDbBackend(name, db, pages);
  }

  pageCount(): number { return this.pages.length; }

  readSync(pageId: number, into: Uint8Array): void {
    const p = this.pages[pageId];
    if (p === undefined) throw new StorageError(`read of page ${pageId} beyond end of file (${this.pages.length} pages)`);
    into.set(p);
  }

  writeSync(pageId: number, data: Uint8Array): void {
    const p = this.pages[pageId];
    if (p === undefined) throw new StorageError(`write of page ${pageId} beyond end of file (${this.pages.length} pages)`);
    p.set(data);
    this.dirty.add(pageId);
  }

  extendSync(newPageCount: number): void {
    while (this.pages.length < newPageCount) { this.dirty.add(this.pages.length); this.pages.push(new Uint8Array(PAGE_SIZE)); }
    if (this.pages.length > newPageCount) this.pages.length = newPageCount;
  }

  /** Schedules an asynchronous flush of dirty pages (see the durability caveat in the module doc). */
  syncSync(): void {
    if (this.flushScheduled || this.closed) return;
    this.flushScheduled = true;
    const prev = this.flushPromise ?? Promise.resolve();
    this.flushPromise = prev.then(() => { this.flushScheduled = false; return this.flushNow(); });
  }

  /** Resolves once every scheduled flush has completed. */
  async flushed(): Promise<void> {
    while (this.flushPromise) {
      const p = this.flushPromise;
      await p;
      if (this.flushPromise === p) this.flushPromise = null;
    }
  }

  private async flushNow(): Promise<void> {
    if (this.dirty.size === 0 && this.storedCount === this.pages.length) return;
    const tx = this.db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const ids = [...this.dirty].filter((id) => id < this.pages.length);
    this.dirty.clear();
    for (const id of ids) store.put(this.pages[id]!.slice().buffer, id);
    for (let id = this.pages.length; id < this.storedCount; id++) store.delete(id);
    this.storedCount = this.pages.length;
    await awaitTxn(tx);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.syncSync();
    await this.flushed();
    this.closed = true;
    this.db.close();
  }

  /** Deletes the IndexedDB database backing `name` (must not be open). */
  static async remove(name: string): Promise<void> {
    await request(indexedDB.deleteDatabase(`basalt:${name}`));
  }
}
