/**
 * Storage introspection for the web inspector: a page map (every page with its type, owning table/index and fill
 * factor), the decoded contents of one page, and per-tree statistics.
 */
import { MASTER_TABLE, type SchemaSet } from "../catalog/catalog.js";
import { decodeKey, decodeRecord, readVarint, varintSize } from "../core/encoding.js";
import type { Value } from "../core/types.js";
import { interiorCellSize, leafCellSize } from "../storage/btree.js";
import { HEADER_SIZE, PAGE_SIZE, PageType, USABLE_SIZE, cellCount, cellOffset, fragBytes, freeEnd, freeStart, liveBytes, pageType, rd32, rightPointer } from "../storage/page.js";
import type { Pager } from "../storage/pager.js";

export type PageKind = "meta" | "interior" | "leaf" | "overflow" | "freelist" | "free" | "unused";

export interface PageInfo {
  pageId: number;
  type: PageKind;
  /** Owning table or index (B+tree pages and their overflow chains). */
  table?: string;
  objectType?: "table" | "index";
  /** Live bytes / usable bytes (0..1); 0 for non-tree pages. */
  fill: number;
  cells?: number;
}

export interface PageCell { index: number; key: Value[]; keyBytes: number; child?: number; value?: Value[] | string; valueBytes?: number; overflowPage?: number }

export interface PageDetail {
  pageId: number;
  type: PageKind;
  table?: string;
  header: { type: number; cellCount: number; freeStart: number; freeEnd: number; right: number; fragBytes: number; liveBytes: number; usable: number };
  cells: PageCell[];
}

export interface BTreeStats { depth: number; pages: number; leafPages: number; fill: number; entries: number }

function kindOf(t: number): PageKind {
  switch (t) {
    case PageType.INTERIOR: return "interior";
    case PageType.LEAF: return "leaf";
    case PageType.OVERFLOW: return "overflow";
    case PageType.FREELIST: return "freelist";
    default: return "unused";
  }
}

/** Visits every page of a tree rooted at `root` (interior, leaf and overflow pages). */
function walkTree(pager: Pager, root: number, visit: (id: number, data: Uint8Array) => void): void {
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (id < 2 || id >= pager.pageCount) continue;
    const ref = pager.get(id);
    const d = ref.data;
    visit(id, d);
    const t = pageType(d);
    if (t === PageType.INTERIOR) {
      const n = cellCount(d);
      for (let i = 0; i < n; i++) stack.push(rd32(d, cellOffset(d, i)));
      stack.push(rightPointer(d));
    } else if (t === PageType.LEAF) {
      const n = cellCount(d);
      for (let i = 0; i < n; i++) {
        const off = cellOffset(d, i);
        const keyLen = readVarint(d, off);
        let p = off + varintSize(keyLen);
        const valueLen = readVarint(d, p);
        p += varintSize(valueLen) + keyLen;
        const inline = varintSize(keyLen) + varintSize(valueLen) + keyLen + valueLen <= 1000;
        if (!inline) {
          let ov = rd32(d, p);
          while (ov >= 2 && ov < pager.pageCount) {
            const r2 = pager.get(ov);
            visit(ov, r2.data);
            const next = rightPointer(r2.data);
            r2.unpin();
            ov = next;
          }
        }
      }
    }
    ref.unpin();
  }
}

export function pageMap(pager: Pager, set: SchemaSet): PageInfo[] {
  const out: PageInfo[] = [];
  for (let i = 0; i < pager.pageCount; i++) out.push({ pageId: i, type: i < 2 ? "meta" : "unused", fill: 0 });
  const label = (root: number, name: string, objectType: "table" | "index"): void => {
    walkTree(pager, root, (id, d) => {
      const e = out[id]!;
      const t = pageType(d);
      e.type = kindOf(t);
      e.table = name;
      e.objectType = objectType;
      if (t === PageType.INTERIOR || t === PageType.LEAF) { e.fill = liveBytes(d) / USABLE_SIZE; e.cells = cellCount(d); }
      else if (t === PageType.OVERFLOW) e.fill = 1;
    });
  };
  if (set.masterRoot !== 0) label(set.masterRoot, MASTER_TABLE, "table");
  for (const t of set.tables.values()) label(t.root, t.schema.name, "table");
  for (const i of set.indexes.values()) label(i.root, i.schema.name, "index");
  for (const f of pager.freelist.entries()) { const e = out[f.pageId]; if (e) e.type = "free"; }
  // free-list trunk pages
  let trunk = pager.readMeta().freelistHead;
  const seen = new Set<number>();
  while (trunk >= 2 && trunk < pager.pageCount && !seen.has(trunk)) {
    seen.add(trunk);
    const e = out[trunk]!;
    e.type = "freelist";
    const ref = pager.get(trunk);
    const next = rightPointer(ref.data);
    ref.unpin();
    trunk = next;
  }
  return out;
}

export function describePage(pager: Pager, set: SchemaSet, pageId: number): PageDetail {
  if (pageId < 0 || pageId >= pager.pageCount) throw new RangeError(`page ${pageId} out of range`);
  const map = pageMap(pager, set);
  const info = map[pageId]!;
  if (pageId < 2) {
    return { pageId, type: "meta", header: { type: 0, cellCount: 0, freeStart: 0, freeEnd: 0, right: 0, fragBytes: 0, liveBytes: 0, usable: USABLE_SIZE }, cells: [] };
  }
  const ref = pager.get(pageId);
  const d = ref.data;
  const t = pageType(d);
  const header = { type: t, cellCount: cellCount(d), freeStart: freeStart(d), freeEnd: freeEnd(d), right: rightPointer(d), fragBytes: fragBytes(d), liveBytes: (t === PageType.LEAF || t === PageType.INTERIOR) ? liveBytes(d) : PAGE_SIZE - HEADER_SIZE, usable: USABLE_SIZE };
  const cells: PageCell[] = [];
  const isTable = info.objectType === "table";
  if (t === PageType.LEAF) {
    for (let i = 0; i < header.cellCount; i++) {
      const off = cellOffset(d, i);
      const keyLen = readVarint(d, off);
      let p = off + varintSize(keyLen);
      const valueLen = readVarint(d, p);
      p += varintSize(valueLen);
      const keyBytes = d.subarray(p, p + keyLen);
      p += keyLen;
      const size = leafCellSize(d, off);
      const inline = size === p - off + valueLen;
      let key: Value[];
      try { key = decodeKey(keyBytes); } catch { key = ["<binary>"]; }
      const cell: PageCell = { index: i, key, keyBytes: keyLen, valueBytes: valueLen };
      if (!inline) cell.overflowPage = rd32(d, p);
      else if (valueLen > 0) {
        const vb = d.subarray(p, p + valueLen);
        if (isTable) { try { cell.value = decodeRecord(vb); } catch { cell.value = `<${valueLen} bytes>`; } }
        else cell.value = `<${valueLen} bytes>`;
      }
      cells.push(cell);
    }
  } else if (t === PageType.INTERIOR) {
    for (let i = 0; i < header.cellCount; i++) {
      const off = cellOffset(d, i);
      const child = rd32(d, off);
      const keyLen = readVarint(d, off + 4);
      const kp = off + 4 + varintSize(keyLen);
      let key: Value[];
      try { key = decodeKey(d.subarray(kp, kp + keyLen)); } catch { key = ["<binary>"]; }
      cells.push({ index: i, key, keyBytes: keyLen, child });
      void interiorCellSize;
    }
  }
  ref.unpin();
  return { pageId, type: info.type, table: info.table, header, cells };
}

export function btreeStats(pager: Pager, root: number): BTreeStats {
  let pages = 0, leafPages = 0, live = 0, entries = 0, depth = 1;
  walkTree(pager, root, (_id, d) => {
    const t = pageType(d);
    if (t === PageType.LEAF) { leafPages++; entries += cellCount(d); live += liveBytes(d); pages++; }
    else if (t === PageType.INTERIOR) { live += liveBytes(d); pages++; }
    else pages++;
  });
  // depth: descend the leftmost path
  let id = root;
  for (;;) {
    if (id < 2 || id >= pager.pageCount) break;
    const ref = pager.get(id);
    const d = ref.data;
    if (pageType(d) !== PageType.INTERIOR) { ref.unpin(); break; }
    id = rd32(d, cellOffset(d, 0));
    ref.unpin();
    depth++;
  }
  const treePages = Math.max(1, pages);
  return { depth, pages, leafPages, fill: live / (treePages * USABLE_SIZE), entries };
}
