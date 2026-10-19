/**
 * Fixed-capacity page cache with pin counts and CLOCK (second-chance) eviction.
 *
 * Frames are allocated lazily up to `capacity`. A page is never evicted while pinned; dirty pages are
 * written through to the backend on eviction (safe under copy-on-write: a dirty page is never part of
 * a committed snapshot, so the file only *exposes* it once the meta page is swapped).
 */
import { StorageError } from "../core/errors";
import { type Backend } from "./backend";
import { PAGE_SIZE } from "./page";

/**
 * A resident page. Valid while pinned; after `unpin()` the frame may be evicted and reused, so callers
 * must not touch `data` afterwards. Set `dirty` through `Pager.markDirty`.
 */
export class PageRef {
  id = -1;
  readonly data: Uint8Array;
  dirty = false;
  pins = 0;
  /** CLOCK reference bit. */
  ref = false;

  constructor(readonly frame: number, private readonly pool: BufferPool) {
    this.data = new Uint8Array(PAGE_SIZE);
  }

  unpin(): void {
    if (this.pins <= 0) throw new StorageError(`unpin of page ${this.id} that is not pinned`);
    this.pins--;
    void this.pool;
  }
}

/** Longest run of adjacent dirty pages written with one `writeManySync` call (256 pages = 1 MB staging buffer). */
const MAX_COALESCED_PAGES = 256;

export class BufferPool {
  private readonly frames: PageRef[] = [];
  private readonly byPage = new Map<number, PageRef>();
  private hand = 0;
  hits = 0;
  misses = 0;
  evictions = 0;

  constructor(readonly capacity: number, private readonly backend: Backend) {
    if (capacity < 4) throw new StorageError("buffer pool needs at least 4 pages");
  }

  /** Number of resident pages. */
  get size(): number { return this.byPage.size; }

  /** Returns the resident frame for `pageId` without pinning it, or undefined. */
  peek(pageId: number): PageRef | undefined { return this.byPage.get(pageId); }

  /** Returns a pinned frame holding `pageId`, loading it from the backend on a miss. */
  fetch(pageId: number): PageRef {
    let ref = this.byPage.get(pageId);
    if (ref) {
      this.hits++;
    } else {
      this.misses++;
      ref = this.acquireFrame(pageId);
      this.backend.readSync(pageId, ref.data);
    }
    ref.pins++;
    ref.ref = true;
    return ref;
  }

  /** Returns a pinned, zeroed, dirty frame for a freshly allocated page (no backend read). */
  fresh(pageId: number): PageRef {
    let ref = this.byPage.get(pageId);
    if (ref) {
      if (ref.pins > 0) throw new StorageError(`page ${pageId} re-allocated while pinned`);
    } else {
      ref = this.acquireFrame(pageId);
    }
    ref.data.fill(0);
    ref.dirty = true;
    ref.pins++;
    ref.ref = true;
    return ref;
  }

  /** Drops `pageId` from the cache without writing it (rollback). No-op if not resident. */
  drop(pageId: number): void {
    const ref = this.byPage.get(pageId);
    if (!ref) return;
    if (ref.pins > 0) throw new StorageError(`cannot drop pinned page ${pageId}`);
    this.byPage.delete(pageId);
    ref.id = -1;
    ref.dirty = false;
  }

  /**
   * Writes every dirty page to the backend (no fsync) and marks them clean. Dirty pages are written in page-id order and
   * runs of adjacent ids go through `Backend.writeManySync` as one write when the backend offers it.
   */
  flush(): void {
    const dirty: PageRef[] = [];
    for (const ref of this.frames) if (ref.id >= 0 && ref.dirty) dirty.push(ref);
    if (dirty.length === 0) return;
    dirty.sort((a, b) => a.id - b.id);
    const many = this.backend.writeManySync;
    if (!many || dirty.length === 1) {
      for (const ref of dirty) { this.backend.writeSync(ref.id, ref.data); ref.dirty = false; }
      return;
    }
    let i = 0;
    while (i < dirty.length) {
      let j = i + 1;
      while (j < dirty.length && j - i < MAX_COALESCED_PAGES && dirty[j]!.id === dirty[j - 1]!.id + 1) j++;
      const run = j - i;
      if (run === 1) {
        this.backend.writeSync(dirty[i]!.id, dirty[i]!.data);
        dirty[i]!.dirty = false;
      } else {
        const needed = run * PAGE_SIZE;
        if (this.staging.length < needed) this.staging = new Uint8Array(needed);
        for (let k = 0; k < run; k++) { const ref = dirty[i + k]!; this.staging.set(ref.data, k * PAGE_SIZE); ref.dirty = false; }
        many.call(this.backend, dirty[i]!.id, needed === this.staging.length ? this.staging : this.staging.subarray(0, needed));
      }
      i = j;
    }
  }
  private staging = new Uint8Array(0);

  /** Iterates resident dirty page ids. */
  *dirtyPages(): IterableIterator<number> {
    for (const ref of this.frames) if (ref.id >= 0 && ref.dirty) yield ref.id;
  }

  /** Drops every resident page (used when the file is reopened under the same pool). */
  clear(): void {
    for (const ref of this.frames) {
      if (ref.pins > 0) throw new StorageError("cannot clear buffer pool with pinned pages");
      ref.id = -1; ref.dirty = false;
    }
    this.byPage.clear();
  }

  private acquireFrame(pageId: number): PageRef {
    let ref: PageRef;
    if (this.frames.length < this.capacity) {
      ref = new PageRef(this.frames.length, this);
      this.frames.push(ref);
    } else {
      ref = this.evict();
    }
    ref.id = pageId;
    ref.dirty = false;
    this.byPage.set(pageId, ref);
    return ref;
  }

  /** CLOCK sweep: skip pinned frames, clear reference bits, evict the first unreferenced one. */
  private evict(): PageRef {
    const n = this.frames.length;
    for (let scanned = 0; scanned < 2 * n; scanned++) {
      const ref = this.frames[this.hand]!;
      this.hand = (this.hand + 1) % n;
      if (ref.pins > 0) continue;
      if (ref.ref) { ref.ref = false; continue; }
      if (ref.dirty) {
        this.backend.writeSync(ref.id, ref.data);
        ref.dirty = false;
      }
      this.byPage.delete(ref.id);
      ref.id = -1;
      this.evictions++;
      return ref;
    }
    throw new StorageError(`buffer pool exhausted: all ${n} frames are pinned`);
  }
}
