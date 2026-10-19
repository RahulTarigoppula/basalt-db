/**
 * File backend for Node using synchronous `node:fs` calls. Kept in its own module so browser
 * bundles never import `node:fs`; import it only from Node entry points.
 */
import { closeSync, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";
import { StorageError } from "../core/errors";
import { type Backend } from "./backend";
import { PAGE_SIZE } from "./page";

export class NodeFileBackend implements Backend {
  readonly pageSize = PAGE_SIZE;
  private fd: number;
  private pages: number;
  private closed = false;

  /** Opens (creating if necessary) the file at `path`. Use `NodeFileBackend.open(path)`. */
  private constructor(readonly path: string, fd: number, pages: number) {
    this.fd = fd;
    this.pages = pages;
  }

  static open(path: string): NodeFileBackend {
    const fd = openSync(path, "a+"); // create if missing, never truncate
    closeSync(fd);
    const rw = openSync(path, "r+");
    const size = fstatSync(rw).size;
    if (size % PAGE_SIZE !== 0) {
      closeSync(rw);
      throw new StorageError(`${path}: file size ${size} is not a multiple of the page size`);
    }
    return new NodeFileBackend(path, rw, size / PAGE_SIZE);
  }

  pageCount(): number { return this.pages; }

  readSync(pageId: number, into: Uint8Array): void {
    if (pageId >= this.pages) throw new StorageError(`read of page ${pageId} beyond end of file (${this.pages} pages)`);
    let done = 0;
    while (done < PAGE_SIZE) {
      const n = readSync(this.fd, into, done, PAGE_SIZE - done, pageId * PAGE_SIZE + done);
      if (n <= 0) throw new StorageError(`short read of page ${pageId}`);
      done += n;
    }
  }

  writeSync(pageId: number, data: Uint8Array): void {
    if (pageId >= this.pages) throw new StorageError(`write of page ${pageId} beyond end of file (${this.pages} pages)`);
    let done = 0;
    while (done < PAGE_SIZE) {
      done += writeSync(this.fd, data, done, PAGE_SIZE - done, pageId * PAGE_SIZE + done);
    }
  }

  /** One `fs.writeSync` for a run of consecutive pages (commit coalesces adjacent dirty pages). */
  writeManySync(firstPageId: number, data: Uint8Array): void {
    const n = data.length / PAGE_SIZE;
    if (firstPageId + n > this.pages) throw new StorageError(`write of pages ${firstPageId}..${firstPageId + n - 1} beyond end of file (${this.pages} pages)`);
    let done = 0;
    while (done < data.length) {
      done += writeSync(this.fd, data, done, data.length - done, firstPageId * PAGE_SIZE + done);
    }
  }

  extendSync(newPageCount: number): void {
    ftruncateSync(this.fd, newPageCount * PAGE_SIZE);
    this.pages = newPageCount;
  }

  syncSync(): void { fsyncSync(this.fd); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}
