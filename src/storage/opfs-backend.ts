/**
 * Origin Private File System backend. Uses `FileSystemSyncAccessHandle`, which exists only inside
 * Web Workers, so the engine runs in a Worker when it is file-backed in the browser.
 *
 * All operations after `open()` are synchronous, matching the Pager's requirements exactly.
 */
import { StorageError } from "../core/errors";
import { type Backend } from "./backend";
import { PAGE_SIZE } from "./page";

export class OpfsBackend implements Backend {
  readonly pageSize = PAGE_SIZE;
  private pages: number;
  private closed = false;

  private constructor(readonly name: string, private readonly handle: FileSystemSyncAccessHandle, pages: number) {
    this.pages = pages;
  }

  /** Opens (creating if necessary) `name` in the origin's private file system root. Worker only. */
  static async open(name: string): Promise<OpfsBackend> {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      throw new StorageError("OPFS is not available in this environment");
    }
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle(name, { create: true });
    if (typeof file.createSyncAccessHandle !== "function") {
      throw new StorageError("FileSystemSyncAccessHandle is only available inside a Web Worker");
    }
    const handle = await file.createSyncAccessHandle();
    const size = handle.getSize();
    if (size % PAGE_SIZE !== 0) {
      handle.close();
      throw new StorageError(`${name}: file size ${size} is not a multiple of the page size`);
    }
    return new OpfsBackend(name, handle, size / PAGE_SIZE);
  }

  pageCount(): number { return this.pages; }

  readSync(pageId: number, into: Uint8Array): void {
    if (pageId >= this.pages) throw new StorageError(`read of page ${pageId} beyond end of file (${this.pages} pages)`);
    const n = this.handle.read(into, { at: pageId * PAGE_SIZE });
    if (n !== PAGE_SIZE) throw new StorageError(`short read of page ${pageId}: ${n} bytes`);
  }

  writeSync(pageId: number, data: Uint8Array): void {
    if (pageId >= this.pages) throw new StorageError(`write of page ${pageId} beyond end of file (${this.pages} pages)`);
    const n = this.handle.write(data, { at: pageId * PAGE_SIZE });
    if (n !== PAGE_SIZE) throw new StorageError(`short write of page ${pageId}: ${n} bytes`);
  }

  /** One access-handle write for a run of consecutive pages (commit coalesces adjacent dirty pages). */
  writeManySync(firstPageId: number, data: Uint8Array): void {
    const n = data.length / PAGE_SIZE;
    if (firstPageId + n > this.pages) throw new StorageError(`write of pages ${firstPageId}..${firstPageId + n - 1} beyond end of file (${this.pages} pages)`);
    const written = this.handle.write(data, { at: firstPageId * PAGE_SIZE });
    if (written !== data.length) throw new StorageError(`short write of pages ${firstPageId}..${firstPageId + n - 1}: ${written} bytes`);
  }

  extendSync(newPageCount: number): void {
    this.handle.truncate(newPageCount * PAGE_SIZE);
    this.pages = newPageCount;
  }

  syncSync(): void { this.handle.flush(); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handle.flush();
    this.handle.close();
  }

  /** Deletes a database file from OPFS (must not be open). */
  static async remove(name: string): Promise<void> {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name);
  }
}
