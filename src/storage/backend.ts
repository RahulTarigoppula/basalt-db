/**
 * The byte-storage boundary. Everything above the Pager is synchronous, so a backend must offer
 * synchronous page reads/writes; only `close()` (and construction, for OPFS/IndexedDB) is async.
 *
 * Implementations: `MemoryBackend` (here), `NodeFileBackend` (`./node-backend`, Node only),
 * `OpfsBackend` (`./opfs-backend`, Web Worker only), `IndexedDbBackend` (`./idb-backend`).
 */
import { StorageError } from "../core/errors";
import { PAGE_SIZE } from "./page";

export interface Backend {
  readonly pageSize: number;
  /** Number of pages currently in the file. */
  pageCount(): number;
  /** Reads page `pageId` into `into` (exactly `pageSize` bytes). */
  readSync(pageId: number, into: Uint8Array): void;
  /** Writes `data` (exactly `pageSize` bytes) as page `pageId`; the page must exist (see `extendSync`). */
  writeSync(pageId: number, data: Uint8Array): void;
  /**
   * Optional: writes `data` (a whole number of pages) as consecutive pages starting at `firstPageId` in one call.
   * The buffer pool uses it to coalesce adjacent dirty pages at commit; without it every page is written on its own.
   */
  writeManySync?(firstPageId: number, data: Uint8Array): void;
  /** Grows (or shrinks) the file to `newPageCount` pages; new pages read as zeroes. */
  extendSync(newPageCount: number): void;
  /** Makes all previous writes durable (fsync). */
  syncSync(): void;
  close(): Promise<void>;
}

/** In-memory backend: one `Uint8Array` per page. Writes are "durable" immediately. */
export class MemoryBackend implements Backend {
  readonly pageSize = PAGE_SIZE;
  protected pages: Uint8Array[] = [];

  pageCount(): number { return this.pages.length; }

  readSync(pageId: number, into: Uint8Array): void {
    const p = this.pages[pageId];
    if (p === undefined) throw new StorageError(`read of page ${pageId} beyond end of file (${this.pages.length} pages)`);
    into.set(p);
  }

  writeSync(pageId: number, data: Uint8Array): void {
    if (pageId >= this.pages.length) throw new StorageError(`write of page ${pageId} beyond end of file (${this.pages.length} pages)`);
    this.pages[pageId]!.set(data);
  }

  extendSync(newPageCount: number): void {
    while (this.pages.length < newPageCount) this.pages.push(new Uint8Array(PAGE_SIZE));
    if (this.pages.length > newPageCount) this.pages.length = newPageCount;
  }

  syncSync(): void { /* nothing to do */ }

  async close(): Promise<void> { /* nothing to do */ }

  /** Snapshot of the whole file as one buffer (handy for tests and export). */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.pages.length * PAGE_SIZE);
    for (let i = 0; i < this.pages.length; i++) out.set(this.pages[i]!, i * PAGE_SIZE);
    return out;
  }

  /** Builds a backend from a file image (length must be a multiple of the page size). */
  static fromBytes(bytes: Uint8Array): MemoryBackend {
    if (bytes.length % PAGE_SIZE !== 0) throw new StorageError("file image length is not a multiple of the page size");
    const b = new MemoryBackend();
    for (let off = 0; off < bytes.length; off += PAGE_SIZE) b.pages.push(bytes.slice(off, off + PAGE_SIZE));
    return b;
  }
}
