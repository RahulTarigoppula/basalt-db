/**
 * Copy-on-write B+tree over the Pager.
 *
 * Pages: INTERIOR pages hold `[childPage u32][keyLen varint][key]` cells plus a rightmost child in the
 * header's `right` field; LEAF pages hold `[keyLen varint][valueLen varint][key][value | overflowPage u32]`
 * cells. A separator key `k_i` in an interior page means: subtree `child_i` holds keys `< k_i`, and the
 * subtree to its right holds keys `>= k_i` (separators are the first key of the right subtree).
 *
 * Copy-on-write: a write never modifies a page it does not own. `WriteContext.owns(pageId)` says
 * whether the page was allocated by the current transaction (or savepoint epoch); otherwise the page
 * is copied to a fresh page, the old id is freed (tagged with the transaction so no live snapshot loses
 * it), and the parent's child pointer is updated on the way back up — all the way to the root, so the
 * root id changes on the first write of every transaction. The owner reads `tree.root` back after
 * each write.
 *
 * Leaves do **not** keep sibling links: under COW a copied leaf would leave its left neighbour's
 * pointer stale. Cursors keep the root-to-leaf path instead.
 *
 * Cursor validity rule: a cursor stays valid across inserts/deletes made by the same transaction into a
 * *different* tree, and across reads of any tree. Modifying the tree a cursor is positioned on
 * invalidates the cursor (its root-to-leaf path may have been copied). The executor materialises target
 * rowids before mutating the tree it scanned.
 */
import { compareBytesAt, readVarint, varintSize, writeVarint } from "../core/encoding";
import { StorageError } from "../core/errors";
import { type PageRef } from "./bufferpool";
import {
  HEADER_SIZE, PAGE_SIZE, PageType, USABLE_SIZE, canFit, cellCount, cellOffset, cellsFootprint, collectCells,
  deleteCell, initPage, insertCell, liveBytes, pageType, rd32, rebuildPage, rightPointer, setRightPointer, wr32,
} from "./page";
import { type Pager } from "./pager";

/** What the tree needs from the enclosing write transaction (implemented by `txn/WriteTxn`). */
export interface WriteContext {
  readonly txnId: number;
  /** True if `pageId` was allocated by this transaction (current savepoint epoch): modifiable in place. */
  owns(pageId: number): boolean;
  /** Allocates a zeroed page owned by this transaction. Pinned and dirty. */
  allocate(): PageRef;
  /** Frees a page (immediately reusable if owned, else after this transaction commits and old readers end). */
  free(pageId: number): void;
}

export interface BTreeCursor {
  seekFirst(): void;
  seekLast(): void;
  /** Positions at the first key `>= key`. Returns true iff that key equals `key` exactly. */
  seek(key: Uint8Array): boolean;
  valid(): boolean;
  /** Copy of the current key. Only valid while `valid()`. */
  key(): Uint8Array;
  /** Copy of the current value (overflow chains are reassembled). Only valid while `valid()`. */
  value(): Uint8Array;
  next(): void;
  prev(): void;
}

/** Largest cell (bytes) stored on a page; guarantees at least 4 cells fit per page. */
export const MAX_CELL_SIZE = 1000;
/** Largest key accepted by the tree. */
export const MAX_KEY_SIZE = 960;
/** Pages whose live bytes drop below this are rebalanced with a sibling. */
const MIN_LIVE_BYTES = USABLE_SIZE >> 2;
const OVERFLOW_PAYLOAD = PAGE_SIZE - HEADER_SIZE;

interface Split { sep: Uint8Array; right: number }
interface Result { id: number; split?: Split }
interface DeleteResult extends Result { deleted: boolean }

// --- cell codecs --------------------------------------------------------------------------------

function valueInline(keyLen: number, valueLen: number): boolean {
  return varintSize(keyLen) + varintSize(valueLen) + keyLen + valueLen <= MAX_CELL_SIZE;
}

/** Byte length of the leaf cell at `off`. */
export function leafCellSize(d: Uint8Array, off: number): number {
  const keyLen = readVarint(d, off);
  let p = off + varintSize(keyLen);
  const valueLen = readVarint(d, p);
  p += varintSize(valueLen) + keyLen;
  return valueInline(keyLen, valueLen) ? p + valueLen - off : p + 4 - off;
}

/** Byte length of the interior cell at `off`. */
export function interiorCellSize(d: Uint8Array, off: number): number {
  const keyLen = readVarint(d, off + 4);
  return 4 + varintSize(keyLen) + keyLen;
}

/** Offset of the key inside the leaf cell at `off` (its length is `readVarint(d, off)`). */
function leafKeyOffset(d: Uint8Array, off: number): number {
  const keyLen = readVarint(d, off);
  const p = off + varintSize(keyLen);
  return p + varintSize(readVarint(d, p));
}

function interiorKeyOffset(d: Uint8Array, off: number): number {
  return off + 4 + varintSize(readVarint(d, off + 4));
}

function buildLeafCell(key: Uint8Array, value: Uint8Array, overflowPage: number): Uint8Array {
  const inline = valueInline(key.length, value.length);
  const hdr = varintSize(key.length) + varintSize(value.length);
  const cell = new Uint8Array(hdr + key.length + (inline ? value.length : 4));
  let p = writeVarint(cell, 0, key.length);
  p = writeVarint(cell, p, value.length);
  cell.set(key, p);
  p += key.length;
  if (inline) cell.set(value, p);
  else wr32(cell, p, overflowPage);
  return cell;
}

function buildInteriorCell(child: number, key: Uint8Array): Uint8Array {
  const cell = new Uint8Array(4 + varintSize(key.length) + key.length);
  wr32(cell, 0, child);
  const p = writeVarint(cell, 4, key.length);
  cell.set(key, p);
  return cell;
}

/** Key bytes of a standalone cell (copied). */
function cellKey(cell: Uint8Array, interior: boolean): Uint8Array {
  const off = interior ? interiorKeyOffset(cell, 0) : leafKeyOffset(cell, 0);
  const len = interior ? readVarint(cell, 4) : readVarint(cell, 0);
  return cell.slice(off, off + len);
}

/** Child pointer at position `idx` (idx == cellCount means the rightmost child). */
function childAt(d: Uint8Array, idx: number): number {
  return idx === cellCount(d) ? rightPointer(d) : rd32(d, cellOffset(d, idx));
}

function setChildAt(d: Uint8Array, idx: number, child: number): void {
  if (idx === cellCount(d)) setRightPointer(d, child);
  else wr32(d, cellOffset(d, idx), child);
}

/**
 * Binary search in a leaf. Returns the index of the matching cell, or `-(insertionPoint) - 1`.
 */
function searchLeaf(d: Uint8Array, key: Uint8Array): number {
  let lo = 0, hi = cellCount(d) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const off = cellOffset(d, mid);
    const c = compareBytesAt(d, leafKeyOffset(d, off), readVarint(d, off), key);
    if (c < 0) lo = mid + 1;
    else if (c > 0) hi = mid - 1;
    else return mid;
  }
  return -(lo + 1);
}

/** Index of the child subtree that may contain `key` (smallest i with key < sep_i, else rightmost). */
function searchInterior(d: Uint8Array, key: Uint8Array): number {
  let lo = 0, hi = cellCount(d);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const off = cellOffset(d, mid);
    const c = compareBytesAt(d, interiorKeyOffset(d, off), readVarint(d, off + 4), key);
    if (c > 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Index m splitting `cells` into two halves of roughly equal footprint, with `lo <= m <= hi`. */
function splitPoint(cells: readonly Uint8Array[], lo: number, hi: number): number {
  const half = cellsFootprint(cells) >>> 1;
  let acc = 0, m = 0;
  while (m < cells.length && acc + cells[m]!.length + 2 <= half) { acc += cells[m]!.length + 2; m++; }
  return Math.min(hi, Math.max(lo, m));
}

// --- tree ----------------------------------------------------------------------------------------

export class BTree {
  private rootId: number;

  /**
   * @param pager   page source
   * @param rootPageId root page of an existing tree (see `BTree.create` for a new one)
   * @param txn     write context; omit for a read-only view of a snapshot
   */
  constructor(private readonly pager: Pager, rootPageId: number, private readonly txn?: WriteContext) {
    if (rootPageId < 2) throw new StorageError(`invalid B+tree root page ${rootPageId}`);
    this.rootId = rootPageId;
  }

  /** Allocates an empty tree (a single empty leaf) inside `txn`. */
  static create(pager: Pager, txn: WriteContext): BTree {
    const ref = txn.allocate();
    initPage(ref.data, PageType.LEAF);
    const id = ref.id;
    ref.unpin();
    return new BTree(pager, id, txn);
  }

  /** Current root page id; changes after copy-on-write writes. */
  get root(): number { return this.rootId; }

  get writable(): boolean { return this.txn !== undefined; }

  /** Point lookup; returns a copy of the value or null. */
  get(key: Uint8Array): Uint8Array | null {
    let id = this.rootId;
    for (;;) {
      const ref = this.pager.get(id);
      const d = ref.data;
      if (pageType(d) === PageType.LEAF) {
        const pos = searchLeaf(d, key);
        const v = pos >= 0 ? this.readValue(d, cellOffset(d, pos)) : null;
        ref.unpin();
        return v;
      }
      id = childAt(d, searchInterior(d, key));
      ref.unpin();
    }
  }

  /** Inserts or replaces `key`. Copy-on-write: `root` may change. */
  insert(key: Uint8Array, value: Uint8Array): void {
    const txn = this.requireTxn();
    if (key.length > MAX_KEY_SIZE) throw new StorageError(`key of ${key.length} bytes exceeds MAX_KEY_SIZE (${MAX_KEY_SIZE})`);
    const r = this.insertRec(this.rootId, key, value);
    this.rootId = r.id;
    if (r.split) this.growRoot(txn, r.split);
  }

  /** Deletes `key`; returns whether it existed. Copy-on-write: `root` may change. */
  delete(key: Uint8Array): boolean {
    const txn = this.requireTxn();
    const r = this.deleteRec(this.rootId, key);
    if (!r.deleted) return false;
    this.rootId = r.id;
    if (r.split) this.growRoot(txn, r.split);
    // Collapse interior roots left with a single (rightmost) child.
    for (;;) {
      const ref = this.pager.get(this.rootId);
      const d = ref.data;
      if (pageType(d) !== PageType.INTERIOR || cellCount(d) !== 0) { ref.unpin(); break; }
      const child = rightPointer(d);
      ref.unpin();
      txn.free(this.rootId);
      this.rootId = child;
    }
    return true;
  }

  cursor(): BTreeCursor { return new Cursor(this); }

  /** Number of entries (walks every leaf page; O(pages)). */
  count(): number {
    const c = new Cursor(this);
    c.seekFirst();
    let total = 0;
    while (c.valid()) {
      total += c.leafCellCount();
      c.nextLeaf();
    }
    return total;
  }

  /** Height of the tree (1 = root is a leaf). */
  depth(): number {
    let id = this.rootId, depth = 1;
    for (;;) {
      const ref = this.pager.get(id);
      const d = ref.data;
      if (pageType(d) === PageType.LEAF) { ref.unpin(); return depth; }
      id = childAt(d, 0);
      ref.unpin();
      depth++;
    }
  }

  /** Frees every page of the tree (DROP TABLE/INDEX). The tree must not be used afterwards. */
  destroy(): void {
    const txn = this.requireTxn();
    this.destroyRec(txn, this.rootId);
  }

  // --- internals: shared -----------------------------------------------------------------------

  /** @internal used by Cursor */
  get pagerRef(): Pager { return this.pager; }

  private requireTxn(): WriteContext {
    if (!this.txn) throw new StorageError("B+tree opened read-only (no write transaction)");
    return this.txn;
  }

  /** Makes `ref` modifiable: returns it if owned, otherwise a pinned COW copy (old page freed). */
  private ensureOwned(ref: PageRef): PageRef {
    const txn = this.txn!;
    if (txn.owns(ref.id)) { ref.dirty = true; return ref; }
    const copy = txn.allocate();
    copy.data.set(ref.data);
    const old = ref.id;
    ref.unpin();
    txn.free(old);
    return copy;
  }

  private growRoot(txn: WriteContext, split: Split): void {
    const ref = txn.allocate();
    rebuildPage(ref.data, PageType.INTERIOR, split.right, [buildInteriorCell(this.rootId, split.sep)]);
    this.rootId = ref.id;
    ref.unpin();
  }

  /** @internal */
  readValue(d: Uint8Array, off: number): Uint8Array {
    const keyLen = readVarint(d, off);
    let p = off + varintSize(keyLen);
    const valueLen = readVarint(d, p);
    p += varintSize(valueLen) + keyLen;
    if (valueInline(keyLen, valueLen)) return d.slice(p, p + valueLen);
    return this.readOverflow(rd32(d, p), valueLen);
  }

  private readOverflow(first: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    let id = first, done = 0;
    while (done < len) {
      if (id === 0) throw new StorageError("overflow chain ended early");
      const ref = this.pager.get(id);
      const n = Math.min(OVERFLOW_PAYLOAD, len - done);
      out.set(ref.data.subarray(HEADER_SIZE, HEADER_SIZE + n), done);
      done += n;
      id = rightPointer(ref.data);
      ref.unpin();
    }
    return out;
  }

  private writeOverflow(txn: WriteContext, value: Uint8Array): number {
    let first = 0;
    let prev: PageRef | null = null;
    for (let off = 0; off < value.length; off += OVERFLOW_PAYLOAD) {
      const ref = txn.allocate();
      initPage(ref.data, PageType.OVERFLOW);
      ref.data.set(value.subarray(off, Math.min(value.length, off + OVERFLOW_PAYLOAD)), HEADER_SIZE);
      if (prev) { setRightPointer(prev.data, ref.id); prev.unpin(); } else first = ref.id;
      prev = ref;
    }
    prev?.unpin();
    return first;
  }

  /** Frees the overflow chain (if any) referenced by the leaf cell at `off`. */
  private freeCellOverflow(txn: WriteContext, d: Uint8Array, off: number): void {
    const keyLen = readVarint(d, off);
    let p = off + varintSize(keyLen);
    const valueLen = readVarint(d, p);
    if (valueInline(keyLen, valueLen)) return;
    p += varintSize(valueLen) + keyLen;
    let id = rd32(d, p);
    while (id !== 0) {
      const ref = this.pager.get(id);
      const next = rightPointer(ref.data);
      ref.unpin();
      txn.free(id);
      id = next;
    }
  }

  private destroyRec(txn: WriteContext, id: number): void {
    const ref = this.pager.get(id);
    const d = ref.data;
    const n = cellCount(d);
    if (pageType(d) === PageType.LEAF) {
      for (let i = 0; i < n; i++) this.freeCellOverflow(txn, d, cellOffset(d, i));
      ref.unpin();
    } else {
      const children: number[] = [];
      for (let i = 0; i <= n; i++) children.push(childAt(d, i));
      ref.unpin();
      for (const c of children) this.destroyRec(txn, c);
    }
    txn.free(id);
  }

  // --- internals: insert -----------------------------------------------------------------------

  private insertRec(pageId: number, key: Uint8Array, value: Uint8Array): Result {
    let ref = this.pager.get(pageId);
    if (pageType(ref.data) === PageType.LEAF) {
      ref = this.ensureOwned(ref);
      return this.insertIntoLeaf(ref, key, value);
    }
    const i = searchInterior(ref.data, key);
    const child = childAt(ref.data, i);
    ref.unpin();
    const r = this.insertRec(child, key, value);
    ref = this.ensureOwned(this.pager.get(pageId));
    if (r.id !== child) setChildAt(ref.data, i, r.id);
    if (r.split) return this.insertSeparator(ref, i, r.split);
    const id = ref.id;
    ref.unpin();
    return { id };
  }

  /** `ref` is an owned, pinned leaf. Unpins it. */
  private insertIntoLeaf(ref: PageRef, key: Uint8Array, value: Uint8Array): Result {
    const txn = this.txn!;
    const d = ref.data;
    let pos = searchLeaf(d, key);
    if (pos >= 0) {
      const off = cellOffset(d, pos);
      this.freeCellOverflow(txn, d, off);
      deleteCell(d, pos, leafCellSize(d, off));
    } else {
      pos = -pos - 1;
    }
    const overflow = valueInline(key.length, value.length) ? 0 : this.writeOverflow(txn, value);
    const cell = buildLeafCell(key, value, overflow);
    if (canFit(d, cell.length)) {
      insertCell(d, pos, cell, leafCellSize);
      const id = ref.id;
      ref.unpin();
      return { id };
    }
    const cells = collectCells(d, leafCellSize);
    cells.splice(pos, 0, cell);
    return this.splitLeaf(ref, cells, pos);
  }

  /**
   * Rewrites owned leaf `ref` with the first part of `cells` and a new sibling with the rest. Unpins.
   * Appends (and prepends) split unevenly so sequential inserts leave full leaves behind instead of
   * half-empty ones; `insertedAt` is the index of the cell that caused the split.
   */
  private splitLeaf(ref: PageRef, cells: Uint8Array[], insertedAt: number): Result {
    const last = cells.length - 1;
    const m = insertedAt === last ? last : insertedAt === 0 ? 1 : splitPoint(cells, 1, last);
    rebuildPage(ref.data, PageType.LEAF, 0, cells.slice(0, m));
    const right = this.txn!.allocate();
    rebuildPage(right.data, PageType.LEAF, 0, cells.slice(m));
    const sep = cellKey(cells[m]!, false);
    const id = ref.id, rightId = right.id;
    ref.unpin();
    right.unpin();
    return { id, split: { sep, right: rightId } };
  }

  /**
   * `ref` is an owned, pinned interior page whose child at position `i` just split into
   * (childAt(i), split.right). Inserts the separator; splits this page if needed. Unpins.
   */
  private insertSeparator(ref: PageRef, i: number, split: Split): Result {
    const d = ref.data;
    const left = childAt(d, i);
    setChildAt(d, i, split.right);
    const cell = buildInteriorCell(left, split.sep);
    if (canFit(d, cell.length)) {
      insertCell(d, i, cell, interiorCellSize);
      const id = ref.id;
      ref.unpin();
      return { id };
    }
    const cells = collectCells(d, interiorCellSize);
    cells.splice(i, 0, cell);
    return this.splitInterior(ref, cells, rightPointer(d));
  }

  /** Rewrites owned interior `ref` with the left half of `cells`, promotes the middle, and creates the right half. Unpins. */
  private splitInterior(ref: PageRef, cells: Uint8Array[], rightmost: number): Result {
    const m = splitPoint(cells, 1, cells.length - 2);
    const promoted = cells[m]!;
    rebuildPage(ref.data, PageType.INTERIOR, rd32(promoted, 0), cells.slice(0, m));
    const right = this.txn!.allocate();
    rebuildPage(right.data, PageType.INTERIOR, rightmost, cells.slice(m + 1));
    const id = ref.id, rightId = right.id;
    ref.unpin();
    right.unpin();
    return { id, split: { sep: cellKey(promoted, true), right: rightId } };
  }

  // --- internals: delete -----------------------------------------------------------------------

  private deleteRec(pageId: number, key: Uint8Array): DeleteResult {
    const txn = this.txn!;
    let ref = this.pager.get(pageId);
    if (pageType(ref.data) === PageType.LEAF) {
      const pos = searchLeaf(ref.data, key);
      if (pos < 0) { ref.unpin(); return { id: pageId, deleted: false }; }
      ref = this.ensureOwned(ref);
      const d = ref.data;
      const off = cellOffset(d, pos);
      this.freeCellOverflow(txn, d, off);
      deleteCell(d, pos, leafCellSize(d, off));
      const id = ref.id;
      ref.unpin();
      return { id, deleted: true };
    }
    const i = searchInterior(ref.data, key);
    const child = childAt(ref.data, i);
    ref.unpin();
    const r = this.deleteRec(child, key);
    if (!r.deleted) return r;
    ref = this.ensureOwned(this.pager.get(pageId));
    const d = ref.data;
    if (r.id !== child) setChildAt(d, i, r.id);
    if (r.split) return { ...this.insertSeparator(ref, i, r.split), deleted: true };
    const childRef = this.pager.get(r.id);
    const underfull = liveBytes(childRef.data) < MIN_LIVE_BYTES;
    childRef.unpin();
    if (underfull && cellCount(d) > 0) return { ...this.rebalance(ref, i), deleted: true };
    const id = ref.id;
    ref.unpin();
    return { id, deleted: true };
  }

  /**
   * `ref` is an owned, pinned interior page whose child at position `i` is underfull. Merges it with
   * an adjacent sibling or redistributes cells between the two. Unpins `ref`.
   */
  private rebalance(ref: PageRef, i: number): Result {
    const txn = this.txn!;
    const d = ref.data;
    const li = i < cellCount(d) ? i : i - 1; // left sibling position; right is li + 1
    const leftRef = this.ensureOwned(this.pager.get(childAt(d, li)));
    const rightRef = this.ensureOwned(this.pager.get(childAt(d, li + 1)));
    setChildAt(d, li, leftRef.id);
    setChildAt(d, li + 1, rightRef.id);
    const interior = pageType(leftRef.data) === PageType.INTERIOR;
    const sizeOf = interior ? interiorCellSize : leafCellSize;

    const cells = collectCells(leftRef.data, sizeOf);
    if (interior) {
      // The parent separator moves down between the two halves, pointing at left's rightmost child.
      const sepOff = cellOffset(d, li);
      const sepLen = readVarint(d, sepOff + 4);
      const sepKeyOff = interiorKeyOffset(d, sepOff);
      cells.push(buildInteriorCell(rightPointer(leftRef.data), d.slice(sepKeyOff, sepKeyOff + sepLen)));
    }
    for (const c of collectCells(rightRef.data, sizeOf)) cells.push(c);
    const rightmost = rightPointer(rightRef.data);

    if (cellsFootprint(cells) <= USABLE_SIZE) {
      // Merge everything into left; drop right and the separator between them.
      rebuildPage(leftRef.data, interior ? PageType.INTERIOR : PageType.LEAF, interior ? rightmost : 0, cells);
      const leftId = leftRef.id, rightId = rightRef.id;
      leftRef.unpin();
      rightRef.unpin();
      txn.free(rightId);
      deleteCell(d, li, interiorCellSize(d, cellOffset(d, li)));
      setChildAt(d, li, leftId);
      const id = ref.id;
      ref.unpin();
      return { id };
    }

    // Redistribute.
    let sep: Uint8Array;
    if (interior) {
      const m = splitPoint(cells, 1, cells.length - 2);
      const promoted = cells[m]!;
      rebuildPage(leftRef.data, PageType.INTERIOR, rd32(promoted, 0), cells.slice(0, m));
      rebuildPage(rightRef.data, PageType.INTERIOR, rightmost, cells.slice(m + 1));
      sep = cellKey(promoted, true);
    } else {
      const m = splitPoint(cells, 1, cells.length - 1);
      rebuildPage(leftRef.data, PageType.LEAF, 0, cells.slice(0, m));
      rebuildPage(rightRef.data, PageType.LEAF, 0, cells.slice(m));
      sep = cellKey(cells[m]!, false);
    }
    const leftId = leftRef.id;
    leftRef.unpin();
    rightRef.unpin();
    // Replace the separator at li (its length may change, so delete + insert; may split this page).
    deleteCell(d, li, interiorCellSize(d, cellOffset(d, li)));
    const cell = buildInteriorCell(leftId, sep);
    if (canFit(d, cell.length)) {
      insertCell(d, li, cell, interiorCellSize);
      const id = ref.id;
      ref.unpin();
      return { id };
    }
    const all = collectCells(d, interiorCellSize);
    all.splice(li, 0, cell);
    return this.splitInterior(ref, all, rightPointer(d));
  }
}

// --- cursor --------------------------------------------------------------------------------------

class Cursor implements BTreeCursor {
  private readonly pages: number[] = [];
  private readonly idx: number[] = [];
  private isValid = false;
  private readonly pager: Pager;

  constructor(private readonly tree: BTree) { this.pager = tree.pagerRef; }

  valid(): boolean { return this.isValid; }

  seekFirst(): void { this.reset(); this.descend(this.tree.root, false); }

  seekLast(): void { this.reset(); this.descend(this.tree.root, true); }

  seek(key: Uint8Array): boolean {
    this.reset();
    let id = this.tree.root;
    for (;;) {
      const ref = this.pager.get(id);
      const d = ref.data;
      this.pages.push(id);
      if (pageType(d) === PageType.LEAF) {
        const pos = searchLeaf(d, key);
        const n = cellCount(d);
        ref.unpin();
        if (pos >= 0) { this.idx.push(pos); this.isValid = true; return true; }
        const at = -pos - 1;
        this.idx.push(at);
        if (at < n) { this.isValid = true; return false; }
        this.isValid = true; // positioned past the last cell of this leaf: move to the next leaf
        this.idx[this.idx.length - 1] = n - 1;
        this.next();
        return false;
      }
      const i = searchInterior(d, key);
      this.idx.push(i);
      id = childAt(d, i);
      ref.unpin();
    }
  }

  key(): Uint8Array {
    const { d, off, ref } = this.currentCell();
    const len = readVarint(d, off);
    const ko = leafKeyOffset(d, off);
    const k = d.slice(ko, ko + len);
    ref.unpin();
    return k;
  }

  value(): Uint8Array {
    const { d, off, ref } = this.currentCell();
    const v = this.tree.readValue(d, off);
    ref.unpin();
    return v;
  }

  next(): void {
    if (!this.isValid) return;
    const leaf = this.pages.length - 1;
    const ref = this.pager.get(this.pages[leaf]!);
    const n = cellCount(ref.data);
    ref.unpin();
    if (++this.idx[leaf]! < n) return;
    this.nextLeaf();
  }

  prev(): void {
    if (!this.isValid) return;
    const leaf = this.pages.length - 1;
    if (--this.idx[leaf]! >= 0) return;
    // climb until a level where we can step left, then descend to the rightmost leaf
    for (let lvl = leaf - 1; lvl >= 0; lvl--) {
      if (--this.idx[lvl]! >= 0) {
        const ref = this.pager.get(this.pages[lvl]!);
        const child = childAt(ref.data, this.idx[lvl]!);
        ref.unpin();
        this.pages.length = lvl + 1;
        this.idx.length = lvl + 1;
        this.descend(child, true);
        return;
      }
    }
    this.isValid = false;
  }

  /** @internal Moves to the first cell of the next leaf (or invalidates). */
  nextLeaf(): void {
    const leaf = this.pages.length - 1;
    for (let lvl = leaf - 1; lvl >= 0; lvl--) {
      const ref = this.pager.get(this.pages[lvl]!);
      const n = cellCount(ref.data);
      if (++this.idx[lvl]! <= n) {
        const child = childAt(ref.data, this.idx[lvl]!);
        ref.unpin();
        this.pages.length = lvl + 1;
        this.idx.length = lvl + 1;
        this.descend(child, false);
        return;
      }
      ref.unpin();
    }
    this.isValid = false;
  }

  /** @internal Number of cells in the current leaf. */
  leafCellCount(): number {
    const ref = this.pager.get(this.pages[this.pages.length - 1]!);
    const n = cellCount(ref.data);
    ref.unpin();
    return n;
  }

  private reset(): void { this.pages.length = 0; this.idx.length = 0; this.isValid = false; }

  /** Appends the path from `id` down to its leftmost (or rightmost) leaf. */
  private descend(id: number, last: boolean): void {
    for (;;) {
      const ref = this.pager.get(id);
      const d = ref.data;
      const n = cellCount(d);
      this.pages.push(id);
      if (pageType(d) === PageType.LEAF) {
        this.idx.push(last ? n - 1 : 0);
        this.isValid = n > 0;
        ref.unpin();
        return;
      }
      const i = last ? n : 0;
      this.idx.push(i);
      id = childAt(d, i);
      ref.unpin();
    }
  }

  private currentCell(): { d: Uint8Array; off: number; ref: PageRef } {
    if (!this.isValid) throw new StorageError("cursor is not positioned on an entry");
    const leaf = this.pages.length - 1;
    const ref = this.pager.get(this.pages[leaf]!);
    const d = ref.data;
    return { d, off: cellOffset(d, this.idx[leaf]!), ref };
  }
}
