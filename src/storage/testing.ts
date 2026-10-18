/**
 * Test helpers for the storage layer. Not part of the public engine API.
 */
import { type Backend, MemoryBackend } from "./backend";
import { PAGE_SIZE } from "./page";

/**
 * Crash-simulating backend: wraps a `MemoryBackend` and buffers every `writeSync`/`extendSync`
 * until `syncSync()`. `crash()` throws the buffered writes away, modelling a power loss between
 * a write and its fsync. Tests reopen a `Pager` over the same instance afterwards.
 */
export class CrashSimBackend implements Backend {
  readonly pageSize = PAGE_SIZE;
  private readonly durable: MemoryBackend;
  private pending = new Map<number, Uint8Array>();
  private pendingCount: number;
  /** Counters for assertions. */
  writes = 0;
  syncs = 0;

  constructor(durable = new MemoryBackend()) {
    this.durable = durable;
    this.pendingCount = durable.pageCount();
  }

  pageCount(): number { return this.pendingCount; }

  readSync(pageId: number, into: Uint8Array): void {
    const p = this.pending.get(pageId);
    if (p) { into.set(p); return; }
    if (pageId < this.durable.pageCount()) this.durable.readSync(pageId, into);
    else into.fill(0);
  }

  writeSync(pageId: number, data: Uint8Array): void {
    this.writes++;
    const p = this.pending.get(pageId);
    if (p) p.set(data);
    else this.pending.set(pageId, data.slice());
  }

  extendSync(newPageCount: number): void { this.pendingCount = newPageCount; }

  syncSync(): void {
    this.syncs++;
    if (this.durable.pageCount() !== this.pendingCount) this.durable.extendSync(this.pendingCount);
    for (const [id, data] of this.pending) if (id < this.pendingCount) this.durable.writeSync(id, data);
    this.pending.clear();
  }

  /** Drops all unsynced writes: the durable image is exactly what the last `syncSync()` left. */
  crash(): void {
    this.pending.clear();
    this.pendingCount = this.durable.pageCount();
  }

  /** Number of buffered (not yet durable) page writes. */
  get unsyncedWrites(): number { return this.pending.size; }

  async close(): Promise<void> { /* nothing */ }
}
