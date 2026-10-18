/**
 * Meta page encoding. Pages 0 and 1 are double-buffered meta pages; a commit writes the slot that is
 * *not* currently valid, so a crash at any point leaves at least one valid meta page.
 *
 * Layout (all big-endian):
 * ```
 *  0  magic         "BASALT01" (8 bytes)
 *  8  formatVersion u32
 * 12  pageSize      u32
 * 16  txnId         u64
 * 24  masterRoot    u32   root page of the master catalog B+tree (0 = none yet)
 * 28  freelistHead  u32   first FREELIST trunk page (0 = empty free list)
 * 32  pageCount     u32   logical number of pages in the file
 * 36  checksum      u32   CRC32 of bytes [0, 36)
 * ```
 */
import { crc32 } from "../core/encoding";
import { CorruptionError } from "../core/errors";
import { PAGE_SIZE, rd32, wr32 } from "./page";

export const META_MAGIC = "BASALT01";
export const FORMAT_VERSION = 1;
export const META_BYTES = 40;

export interface Meta {
  formatVersion: number;
  pageSize: number;
  txnId: number;
  masterRoot: number;
  freelistHead: number;
  pageCount: number;
}

const magicBytes = new TextEncoder().encode(META_MAGIC);

/** Writes `meta` into `data` (a full page buffer); the remainder of the page is zeroed. */
export function encodeMeta(meta: Meta, data: Uint8Array): void {
  data.fill(0);
  data.set(magicBytes, 0);
  wr32(data, 8, meta.formatVersion);
  wr32(data, 12, meta.pageSize);
  // txnId is a safe integer; store as two u32 halves
  wr32(data, 16, Math.floor(meta.txnId / 0x100000000));
  wr32(data, 20, meta.txnId >>> 0);
  wr32(data, 24, meta.masterRoot);
  wr32(data, 28, meta.freelistHead);
  wr32(data, 32, meta.pageCount);
  wr32(data, 36, crc32(data, 0, 36));
}

/** Decodes a meta page, or returns null if the magic/checksum/page size are invalid. */
export function decodeMeta(data: Uint8Array): Meta | null {
  for (let i = 0; i < 8; i++) if (data[i] !== magicBytes[i]) return null;
  if (crc32(data, 0, 36) !== rd32(data, 36)) return null;
  const meta: Meta = {
    formatVersion: rd32(data, 8),
    pageSize: rd32(data, 12),
    txnId: rd32(data, 16) * 0x100000000 + rd32(data, 20),
    masterRoot: rd32(data, 24),
    freelistHead: rd32(data, 28),
    pageCount: rd32(data, 32),
  };
  if (meta.pageSize !== PAGE_SIZE) return null;
  return meta;
}

/**
 * Picks the valid meta page with the highest txn id out of the two slots.
 * Returns the meta and the slot index it came from. Throws if neither slot is valid.
 */
export function selectMeta(slot0: Uint8Array, slot1: Uint8Array): { meta: Meta; slot: 0 | 1 } {
  const m0 = decodeMeta(slot0);
  const m1 = decodeMeta(slot1);
  if (m0 && m1) return m1.txnId > m0.txnId ? { meta: m1, slot: 1 } : { meta: m0, slot: 0 };
  if (m0) return { meta: m0, slot: 0 };
  if (m1) return { meta: m1, slot: 1 };
  throw new CorruptionError("no valid meta page (bad magic or checksum in both slots)");
}

/** A fresh meta for an empty database: two meta pages, no catalog root, empty free list. */
export function initialMeta(): Meta {
  return { formatVersion: FORMAT_VERSION, pageSize: PAGE_SIZE, txnId: 0, masterRoot: 0, freelistHead: 0, pageCount: 2 };
}
