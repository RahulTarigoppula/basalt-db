/**
 * The Pager owns the backend, the buffer pool, the free list and the meta pages. It hands out pinned
 * `PageRef`s, allocates/frees pages, flushes dirty pages and swaps meta pages.
 *
 * Page ids are logical: `pageCount` is the high-water mark recorded in the meta page; the backend
 * file may be longer after a rolled-back transaction extended it, and such tail pages are simply
 * reused by the next extension.
 */
import { CorruptionError, StorageError } from "../core/errors";
import { type Backend } from "./backend";
import { BufferPool, type PageRef } from "./bufferpool";
import { FreeList } from "./freelist";
import { type Meta, encodeMeta, initialMeta, selectMeta } from "./meta";
import { PAGE_SIZE } from "./page";

export type { PageRef } from "./bufferpool";

export interface PagerStats {
  pageCount: number;
  freePages: number;
  reusablePages: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;
  cachedPages: number;
  txnId: number;
}

export class Pager {
  readonly pool: BufferPool;
  readonly freelist = new FreeList();
  /** Logical page count (high-water mark); the next extension allocates this id. */
  pageCount: number;
  private meta: Meta;
  private metaSlot: 0 | 1;
  private readonly metaBuf = new Uint8Array(PAGE_SIZE);

  constructor(readonly backend: Backend, poolPages = 2048) {
    if (backend.pageSize !== PAGE_SIZE) throw new StorageError(`backend page size ${backend.pageSize} != ${PAGE_SIZE}`);
    this.pool = new BufferPool(poolPages, backend);
    if (backend.pageCount() === 0) {
      // Fresh file: format it with two identical meta pages.
      this.meta = initialMeta();
      backend.extendSync(2);
      encodeMeta(this.meta, this.metaBuf);
      backend.writeSync(0, this.metaBuf);
      backend.writeSync(1, this.metaBuf);
      backend.syncSync();
      this.metaSlot = 0;
    } else {
      if (backend.pageCount() < 2) throw new CorruptionError("file is shorter than the two meta pages");
      const s0 = new Uint8Array(PAGE_SIZE), s1 = new Uint8Array(PAGE_SIZE);
      backend.readSync(0, s0);
      backend.readSync(1, s1);
      const sel = selectMeta(s0, s1);
      this.meta = sel.meta;
      this.metaSlot = sel.slot;
      if (backend.pageCount() < this.meta.pageCount) {
        throw new CorruptionError(`file has ${backend.pageCount()} pages but meta records ${this.meta.pageCount}`);
      }
    }
    this.pageCount = this.meta.pageCount;
    this.freelist.load(this, this.meta.freelistHead);
    this.freelist.setBound(this.meta.txnId);
  }

  /** Returns a pinned reference to `pageId`. Callers must `unpin()` it. */
  get(pageId: number): PageRef {
    if (pageId < 2 || pageId >= this.pageCount) throw new StorageError(`page ${pageId} out of range [2, ${this.pageCount})`);
    return this.pool.fetch(pageId);
  }

  /** Allocates a zeroed page (from the reusable free list, else by extending the file). Pinned + dirty. */
  allocate(): PageRef {
    let id = this.freelist.take();
    if (id === undefined) {
      id = this.pageCount++;
      if (this.backend.pageCount() < this.pageCount) this.backend.extendSync(this.pageCount);
    }
    return this.pool.fresh(id);
  }

  /**
   * Returns `pageId` to the free list, tagged with the freeing transaction (`0` = reusable now, used
   * for pages allocated and freed by the same transaction).
   */
  free(pageId: number, txnId: number): void {
    if (pageId < 2 || pageId >= this.pageCount) throw new StorageError(`free of page ${pageId} out of range`);
    this.freelist.add(pageId, txnId);
    if (txnId === 0) {
      // Nobody can read it any more: avoid flushing stale contents later.
      const ref = this.pool.peek(pageId);
      if (ref && ref.pins === 0) this.pool.drop(pageId);
    }
  }

  markDirty(ref: PageRef): void { ref.dirty = true; }

  /** Writes every dirty page to the backend (does not fsync). */
  flush(): void { this.pool.flush(); }

  /** fsync. */
  sync(): void { this.backend.syncSync(); }

  /** The committed meta (a copy). */
  readMeta(): Meta { return { ...this.meta }; }

  /**
   * Writes `meta` into the meta slot that is *not* currently valid and makes it current.
   * Does not fsync: callers flush+sync before and sync after (see `TransactionManager.commit`).
   */
  writeMeta(meta: Meta): void {
    const slot: 0 | 1 = this.metaSlot === 0 ? 1 : 0;
    encodeMeta(meta, this.metaBuf);
    this.backend.writeSync(slot, this.metaBuf);
    this.metaSlot = slot;
    this.meta = { ...meta };
  }

  /** Drops a page from the cache without writing it (rollback of an uncommitted allocation). */
  discard(pageId: number): void { this.pool.drop(pageId); }

  /** Lowers the logical page count after a rollback (`pageCount` must be >= the committed count). */
  truncate(pageCount: number): void {
    if (pageCount < this.meta.pageCount) throw new StorageError("cannot truncate below the committed page count");
    for (let id = pageCount; id < this.pageCount; id++) this.pool.drop(id);
    this.pageCount = pageCount;
    this.freelist.removeAbove(pageCount);
  }

  /** Publishes the free-list reclamation watermark (oldest live reader snapshot, or last commit). */
  setReusableBound(txnId: number): void { this.freelist.setBound(txnId); }

  stats(): PagerStats {
    return {
      pageCount: this.pageCount,
      freePages: this.freelist.size,
      reusablePages: this.freelist.readyCount,
      cacheHits: this.pool.hits,
      cacheMisses: this.pool.misses,
      cacheEvictions: this.pool.evictions,
      cachedPages: this.pool.size,
      txnId: this.meta.txnId,
    };
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}
