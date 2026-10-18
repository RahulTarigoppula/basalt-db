/**
 * Page layout constants and slotted-page helpers.
 *
 * Every non-meta page starts with a 16-byte header:
 *
 * ```
 *  0  type        u8   (PageType)
 *  1  flags       u8
 *  2  cellCount   u16
 *  4  freeStart   u16  first byte after the cell-pointer array
 *  6  freeEnd     u16  first byte of the cell content area (cells grow down from PAGE_SIZE)
 *  8  right       u32  leaf: reserved (0) | interior: rightmost child | overflow/freelist: next page
 * 12  fragBytes   u16  bytes of dead cell content inside [freeEnd, PAGE_SIZE) (reclaimed by defragment)
 * 14  reserved    u16
 * ```
 *
 * Cell pointers are u16 offsets stored from offset 16 upward in key order; the cells themselves are
 * opaque byte strings whose length the owner (btree/freelist) knows how to compute, so the helpers
 * here take a `sizeOf` callback where they need it.
 */
import { StorageError } from "../core/errors";

export const PAGE_SIZE = 4096;
export const HEADER_SIZE = 16;
export const SLOT_SIZE = 2;
/** Bytes available for slots + cells on a fresh page. */
export const USABLE_SIZE = PAGE_SIZE - HEADER_SIZE;

export const PageType = {
  META: 1,
  INTERIOR: 2,
  LEAF: 3,
  OVERFLOW: 4,
  FREELIST: 5,
} as const;
export type PageTypeValue = (typeof PageType)[keyof typeof PageType];

export const OFF_TYPE = 0;
export const OFF_FLAGS = 1;
export const OFF_CELL_COUNT = 2;
export const OFF_FREE_START = 4;
export const OFF_FREE_END = 6;
export const OFF_RIGHT = 8;
export const OFF_FRAG = 12;

/** Computes the byte length of the cell that starts at `offset`. */
export type CellSizeFn = (data: Uint8Array, offset: number) => number;

// --- raw integer access -------------------------------------------------------------------------

export function rd16(d: Uint8Array, o: number): number { return (d[o]! << 8) | d[o + 1]!; }
export function wr16(d: Uint8Array, o: number, v: number): void { d[o] = (v >>> 8) & 0xff; d[o + 1] = v & 0xff; }
export function rd32(d: Uint8Array, o: number): number {
  return ((d[o]! << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!) >>> 0;
}
export function wr32(d: Uint8Array, o: number, v: number): void {
  d[o] = (v >>> 24) & 0xff; d[o + 1] = (v >>> 16) & 0xff; d[o + 2] = (v >>> 8) & 0xff; d[o + 3] = v & 0xff;
}

// --- header accessors ---------------------------------------------------------------------------

/** Zeroes `data` and writes an empty page header of the given type. */
export function initPage(data: Uint8Array, type: PageTypeValue): void {
  data.fill(0);
  data[OFF_TYPE] = type;
  wr16(data, OFF_FREE_START, HEADER_SIZE);
  wr16(data, OFF_FREE_END, PAGE_SIZE);
}

export function pageType(d: Uint8Array): number { return d[OFF_TYPE]!; }
export function cellCount(d: Uint8Array): number { return rd16(d, OFF_CELL_COUNT); }
export function freeStart(d: Uint8Array): number { return rd16(d, OFF_FREE_START); }
export function freeEnd(d: Uint8Array): number { return rd16(d, OFF_FREE_END); }
export function rightPointer(d: Uint8Array): number { return rd32(d, OFF_RIGHT); }
export function setRightPointer(d: Uint8Array, v: number): void { wr32(d, OFF_RIGHT, v); }
export function fragBytes(d: Uint8Array): number { return rd16(d, OFF_FRAG); }

/** Offset of cell `i` (0-based, in slot order). */
export function cellOffset(d: Uint8Array, i: number): number { return rd16(d, HEADER_SIZE + i * SLOT_SIZE); }

/** Bytes available for a new cell without defragmenting (includes the slot). */
export function contiguousFree(d: Uint8Array): number { return freeEnd(d) - freeStart(d); }

/** Total reclaimable free bytes (contiguous + fragmented). */
export function totalFree(d: Uint8Array): number { return contiguousFree(d) + fragBytes(d); }

/** Bytes used by live cells and their slots. */
export function liveBytes(d: Uint8Array): number { return USABLE_SIZE - totalFree(d); }

/** True if a cell of `cellLen` bytes can be inserted (possibly after defragmentation). */
export function canFit(d: Uint8Array, cellLen: number): boolean { return totalFree(d) >= cellLen + SLOT_SIZE; }

// --- slot operations ----------------------------------------------------------------------------

/**
 * Inserts `cell` as cell number `index`, shifting later slots. Defragments first if the contiguous
 * free area is too small. Throws if the cell does not fit at all (callers check `canFit`).
 */
export function insertCell(d: Uint8Array, index: number, cell: Uint8Array, sizeOf: CellSizeFn): void {
  const len = cell.length;
  const count = cellCount(d);
  if (contiguousFree(d) < len + SLOT_SIZE) {
    if (totalFree(d) < len + SLOT_SIZE) throw new StorageError(`cell of ${len} bytes does not fit in page`);
    defragment(d, sizeOf);
  }
  const fe = freeEnd(d) - len;
  d.set(cell, fe);
  // shift slots [index, count) up by one
  const slotPos = HEADER_SIZE + index * SLOT_SIZE;
  const endPos = HEADER_SIZE + count * SLOT_SIZE;
  if (slotPos < endPos) d.copyWithin(slotPos + SLOT_SIZE, slotPos, endPos);
  wr16(d, slotPos, fe);
  wr16(d, OFF_CELL_COUNT, count + 1);
  wr16(d, OFF_FREE_START, endPos + SLOT_SIZE);
  wr16(d, OFF_FREE_END, fe);
}

/** Removes cell `index` whose length is `cellLen`; its bytes become fragmented (or free if adjacent). */
export function deleteCell(d: Uint8Array, index: number, cellLen: number): void {
  const count = cellCount(d);
  const slotPos = HEADER_SIZE + index * SLOT_SIZE;
  const off = rd16(d, slotPos);
  const endPos = HEADER_SIZE + count * SLOT_SIZE;
  if (slotPos + SLOT_SIZE < endPos) d.copyWithin(slotPos, slotPos + SLOT_SIZE, endPos);
  wr16(d, OFF_CELL_COUNT, count - 1);
  wr16(d, OFF_FREE_START, endPos - SLOT_SIZE);
  if (off === freeEnd(d)) wr16(d, OFF_FREE_END, off + cellLen);
  else wr16(d, OFF_FRAG, fragBytes(d) + cellLen);
}

const defragScratch = new Uint8Array(PAGE_SIZE);

/** Repacks all live cells at the end of the page so the free area is contiguous. */
export function defragment(d: Uint8Array, sizeOf: CellSizeFn): void {
  const count = cellCount(d);
  let fe = PAGE_SIZE;
  const tmp = defragScratch;
  for (let i = 0; i < count; i++) {
    const off = cellOffset(d, i);
    const len = sizeOf(d, off);
    fe -= len;
    tmp.set(d.subarray(off, off + len), fe);
    wr16(d, HEADER_SIZE + i * SLOT_SIZE, fe);
  }
  d.set(tmp.subarray(fe), fe);
  wr16(d, OFF_FREE_END, fe);
  wr16(d, OFF_FRAG, 0);
}

/**
 * Rebuilds a page from an ordered list of cells (used by splits/merges). Keeps `type` and writes
 * `right`. Throws if the cells do not fit.
 */
export function rebuildPage(d: Uint8Array, type: PageTypeValue, right: number, cells: readonly Uint8Array[]): void {
  initPage(d, type);
  setRightPointer(d, right);
  let fe = PAGE_SIZE;
  const n = cells.length;
  for (let i = 0; i < n; i++) {
    const c = cells[i]!;
    fe -= c.length;
    if (fe < HEADER_SIZE + (i + 1) * SLOT_SIZE) throw new StorageError("cells do not fit in page during rebuild");
    d.set(c, fe);
    wr16(d, HEADER_SIZE + i * SLOT_SIZE, fe);
  }
  wr16(d, OFF_CELL_COUNT, n);
  wr16(d, OFF_FREE_START, HEADER_SIZE + n * SLOT_SIZE);
  wr16(d, OFF_FREE_END, fe);
}

/** Copies every cell of the page out into fresh arrays, in slot order. */
export function collectCells(d: Uint8Array, sizeOf: CellSizeFn): Uint8Array[] {
  const count = cellCount(d);
  const out = new Array<Uint8Array>(count);
  for (let i = 0; i < count; i++) {
    const off = cellOffset(d, i);
    out[i] = d.slice(off, off + sizeOf(d, off));
  }
  return out;
}

/** Sum of `len + SLOT_SIZE` for a cell list: the space it would occupy on one page. */
export function cellsFootprint(cells: readonly Uint8Array[]): number {
  let total = 0;
  for (let i = 0; i < cells.length; i++) total += cells[i]!.length + SLOT_SIZE;
  return total;
}
