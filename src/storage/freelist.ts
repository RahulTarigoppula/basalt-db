/**
 * Free-page list with MVCC-aware reclamation.
 *
 * Every freed page is tagged with the id of the transaction that freed it. A page freed by txn `T`
 * is still referenced by snapshots whose txn id is `< T`, so it may only be handed out again once
 * every live reader has a snapshot id `>= T`. `setBound(b)` publishes that watermark (the oldest live
 * reader's snapshot id, or the last committed txn id when nobody is reading); entries with
 * `txnId <= b` move to the *ready* set that `take()` serves. Pages freed by the in-flight writer carry
 * its (not yet committed) txn id, which is always `> bound`, so a writer never recycles its own
 * pre-images before commit. Tag `0` marks pages that nobody can reference (allocated and freed within
 * the same transaction); they are reusable immediately.
 *
 * Persistence: at commit the whole list is written into a chain of FREELIST trunk pages
 * (`[pageId u32][txnId u64]` entries after the common 16-byte header, next trunk in the `right`
 * field) and the head is stored in the meta page. The previous chain's pages are themselves freed,
 * tagged with the committing txn, so the free list is copy-on-write like everything else.
 */
import { CorruptionError } from "../core/errors";
import { type PageRef } from "./bufferpool";
import { HEADER_SIZE, PAGE_SIZE, PageType, cellCount, initPage, pageType, rd32, rightPointer, setRightPointer, wr16, wr32, OFF_CELL_COUNT } from "./page";
import { type Pager } from "./pager";

const ENTRY_SIZE = 12;
/** Entries per FREELIST trunk page. */
export const FREELIST_ENTRIES_PER_PAGE = Math.floor((PAGE_SIZE - HEADER_SIZE) / ENTRY_SIZE);

/** What `FreeList.persist` needs from the committing transaction. */
export interface FreeListWriteContext {
  readonly txnId: number;
  allocate(): PageRef;
}

export class FreeList {
  /** pageId -> txnId that freed it, for every free page (ready or not). */
  private readonly all = new Map<number, number>();
  /** Pages whose tag is <= bound: reusable now. */
  private readonly ready = new Set<number>();
  private bound = 0;
  /** Trunk pages holding the persisted copy of this list (freed when a new copy is written). */
  trunkPages: number[] = [];

  /** Total number of free pages (reusable or still pinned by old snapshots). */
  get size(): number { return this.all.size; }
  /** Number of pages reusable right now. */
  get readyCount(): number { return this.ready.size; }
  get reusableBound(): number { return this.bound; }

  /** Records `pageId` as freed by `txnId` (0 = reusable immediately). Idempotent. */
  add(pageId: number, txnId: number): void {
    this.all.set(pageId, txnId);
    if (txnId <= this.bound) this.ready.add(pageId);
    else this.ready.delete(pageId);
  }

  /** Hands out a reusable page id, or undefined if none is eligible. */
  take(): number | undefined {
    if (this.ready.size === 0) return undefined;
    const id = this.ready.values().next().value as number;
    this.ready.delete(id);
    this.all.delete(id);
    return id;
  }

  /** Publishes the reclamation watermark: entries tagged `<= bound` become reusable. */
  setBound(bound: number): void {
    this.bound = bound;
    if (this.ready.size === this.all.size) return;
    for (const [id, tag] of this.all) if (tag <= bound) this.ready.add(id);
  }

  /** Un-frees `pageId` (rollback of the transaction that freed it). */
  remove(pageId: number): void {
    this.all.delete(pageId);
    this.ready.delete(pageId);
  }

  /** Un-frees every page tagged exactly `txnId` (rollback of an uncommitted writer). */
  removeTagged(txnId: number): void {
    for (const [id, tag] of this.all) if (tag === txnId) { this.all.delete(id); this.ready.delete(id); }
  }

  /** Drops entries at or beyond `pageCount` (the file was logically truncated by a rollback). */
  removeAbove(pageCount: number): void {
    for (const id of this.all.keys()) if (id >= pageCount) { this.all.delete(id); this.ready.delete(id); }
  }

  /** True if `pageId` is currently free (any tag). */
  has(pageId: number): boolean { return this.all.has(pageId); }

  /** All entries, for inspection. */
  entries(): { pageId: number; txnId: number }[] {
    const out: { pageId: number; txnId: number }[] = [];
    for (const [pageId, txnId] of this.all) out.push({ pageId, txnId });
    return out;
  }

  /** Loads the persisted list from the trunk chain starting at `head` (0 = empty). */
  load(pager: Pager, head: number): void {
    this.all.clear();
    this.ready.clear();
    this.trunkPages = [];
    let id = head;
    const seen = new Set<number>();
    while (id !== 0) {
      if (seen.has(id)) throw new CorruptionError(`free-list trunk chain loops at page ${id}`);
      seen.add(id);
      const ref = pager.get(id);
      try {
        const d = ref.data;
        if (pageType(d) !== PageType.FREELIST) throw new CorruptionError(`page ${id} is not a free-list trunk page`);
        const n = cellCount(d);
        for (let i = 0; i < n; i++) {
          const off = HEADER_SIZE + i * ENTRY_SIZE;
          const pageId = rd32(d, off);
          const txnId = rd32(d, off + 4) * 0x100000000 + rd32(d, off + 8);
          this.all.set(pageId, txnId);
        }
        this.trunkPages.push(id);
        id = rightPointer(d);
      } finally {
        ref.unpin();
      }
    }
  }

  /**
   * Writes the list into fresh trunk pages allocated through `ctx` and returns the new head page id.
   * The old trunk pages are freed (tagged with `ctx.txnId`) and included in the new list.
   */
  persist(pager: Pager, ctx: FreeListWriteContext): number {
    for (const p of this.trunkPages) this.add(p, ctx.txnId);
    this.trunkPages = [];
    const pages: PageRef[] = [];
    // Allocating a trunk page may consume a ready entry, which shrinks the list; loop until stable.
    for (;;) {
      const needed = Math.ceil(this.all.size / FREELIST_ENTRIES_PER_PAGE);
      if (pages.length >= needed) break;
      pages.push(ctx.allocate());
    }
    const entries = [...this.all];
    let k = 0;
    for (let i = 0; i < pages.length; i++) {
      const ref = pages[i]!;
      const d = ref.data;
      initPage(d, PageType.FREELIST);
      const n = Math.min(FREELIST_ENTRIES_PER_PAGE, entries.length - k);
      for (let j = 0; j < n; j++, k++) {
        const [pageId, txnId] = entries[k]!;
        const off = HEADER_SIZE + j * ENTRY_SIZE;
        wr32(d, off, pageId);
        wr32(d, off + 4, Math.floor(txnId / 0x100000000));
        wr32(d, off + 8, txnId >>> 0);
      }
      wr16(d, OFF_CELL_COUNT, n);
      setRightPointer(d, i + 1 < pages.length ? pages[i + 1]!.id : 0);
      pager.markDirty(ref);
      ref.unpin();
      this.trunkPages.push(ref.id);
    }
    return pages.length > 0 ? pages[0]!.id : 0;
  }
}
