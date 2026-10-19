/**
 * Leaf operators: SeqScan (rowid order, optional rowid bounds, both directions), RowidLookup, IndexScan (equality prefix +
 * range, covering or with base-row lookup), SubqueryScan, CteScan (materialised once per execution), WorkingTable
 * (recursive CTE), Values and Materialize.
 */
import type { IndexInfo, TableInfo } from "../../catalog/catalog.js";
import { KeyReader, compareBytes, encodeKey } from "../../core/encoding.js";
import type { Row, Value } from "../../core/types.js";
import type { Layout } from "../../planner/layout.js";
import type { BoundCte } from "../../sql/bound.js";
import type { BTree, BTreeCursor } from "../../storage/btree.js";
import { EMPTY_ROW, type ExecContext, type Operator } from "../context.js";
import type { CompiledExpr } from "../expr.js";
import { normalize, truthy } from "../functions.js";
import { decodeTableRow, rowidKeyBytes, startsWith } from "../rows.js";
import { OpBase } from "./base.js";

export interface ScanBound { expr: CompiledExpr; inclusive: boolean }

export class SeqScan extends OpBase {
  private tree!: BTree;
  private cursor!: BTreeCursor;
  private hiKey: Uint8Array | undefined;
  private hiInclusive = true;
  private done = true;

  constructor(layout: Layout, private readonly table: TableInfo, private readonly filter: ((rows: Row[], ctx: ExecContext) => boolean) | undefined,
    private readonly lo: ScanBound | undefined, private readonly hi: ScanBound | undefined, private readonly direction: 1 | -1) { super(layout); }

  protected onOpen(): void {
    this.tree = this.ctx.shared.readTree(this.table.schema.name);
    this.cursor = this.tree.cursor();
    this.done = false;
    this.hiKey = undefined;
    let loKey: Uint8Array | undefined, hiKey: Uint8Array | undefined;
    let loInc = true, hiInc = true;
    this.rows[0] = EMPTY_ROW;
    if (this.lo) { const v = this.lo.expr(this.rows, this.ctx); if (v === null) { this.done = true; return; } loKey = encodeKey([normalize(v)]); loInc = this.lo.inclusive; }
    if (this.hi) { const v = this.hi.expr(this.rows, this.ctx); if (v === null) { this.done = true; return; } hiKey = encodeKey([normalize(v)]); hiInc = this.hi.inclusive; }
    if (this.direction > 0) {
      if (loKey) { const exact = this.cursor.seek(loKey); if (exact && !loInc) this.cursor.next(); } else this.cursor.seekFirst();
      this.hiKey = hiKey; this.hiInclusive = hiInc;
    } else {
      if (hiKey) {
        const exact = this.cursor.seek(hiKey);
        if (!this.cursor.valid()) this.cursor.seekLast();
        else if (!exact || !hiInc) this.cursor.prev();
      } else this.cursor.seekLast();
      this.hiKey = loKey; this.hiInclusive = loInc; // the stop bound when walking backwards
    }
  }

  next(): Row | null {
    if (this.done) return null;
    const c = this.cursor;
    while (c.valid()) {
      const key = c.key();
      if (this.hiKey) {
        const cmp = compareBytes(key, this.hiKey);
        if (this.direction > 0 ? (cmp > 0 || (cmp === 0 && !this.hiInclusive)) : (cmp < 0 || (cmp === 0 && !this.hiInclusive))) { this.done = true; return null; }
      }
      const row = decodeTableRow(this.table, key, c.value());
      if (this.direction > 0) c.next(); else c.prev();
      if (this.filter) { this.rows[0] = row; if (!this.filter(this.rows, this.ctx)) continue; }
      this.stats.rows++;
      return row;
    }
    this.done = true;
    return null;
  }

  protected override onClose(): void { this.done = true; }
}

export class RowidLookup extends OpBase {
  private row: Row | null = null;
  constructor(layout: Layout, private readonly table: TableInfo, private readonly rowid: CompiledExpr, private readonly filter: ((rows: Row[], ctx: ExecContext) => boolean) | undefined) { super(layout); }

  protected onOpen(): void {
    this.row = null;
    this.rows[0] = EMPTY_ROW;
    const v = this.rowid(this.rows, this.ctx);
    if (v === null) return;
    const n = normalize(v);
    if (typeof n === "number" && !Number.isInteger(n)) return;
    if (typeof n !== "bigint" && typeof n !== "number") return;
    const key = rowidKeyBytes(typeof n === "bigint" ? n : BigInt(n));
    const tree = this.ctx.shared.readTree(this.table.schema.name);
    const value = tree.get(key);
    if (value === null) return;
    const row = decodeTableRow(this.table, key, value);
    if (this.filter) { this.rows[0] = row; if (!this.filter(this.rows, this.ctx)) return; }
    this.row = row;
  }

  next(): Row | null {
    const r = this.row;
    this.row = null;
    if (r) this.stats.rows++;
    return r;
  }
}

export class IndexScan extends OpBase {
  private cursor!: BTreeCursor;
  private tableTree!: BTree;
  private prefix: Uint8Array = new Uint8Array(0);
  private stopKey: Uint8Array | undefined;
  private stopInclusive = true;
  private done = true;
  private readonly ncols: number;

  constructor(layout: Layout, private readonly table: TableInfo, private readonly index: IndexInfo, private readonly eq: CompiledExpr[], private readonly eqIsNullTest: boolean[],
    private readonly lo: ScanBound | undefined, private readonly hi: ScanBound | undefined, private readonly covering: boolean,
    private readonly filter: ((rows: Row[], ctx: ExecContext) => boolean) | undefined, private readonly direction: 1 | -1) {
    super(layout);
    this.ncols = table.schema.columns.length;
  }

  protected onOpen(): void {
    const shared = this.ctx.shared;
    this.cursor = shared.readTree(this.index.schema.name).cursor();
    this.tableTree = shared.readTree(this.table.schema.name);
    this.done = false;
    this.stopKey = undefined;
    this.rows[0] = EMPTY_ROW;
    const eqVals: Value[] = [];
    for (let i = 0; i < this.eq.length; i++) {
      const v = this.eq[i]!(this.rows, this.ctx);
      if (v === null && !this.eqIsNullTest[i]) { this.done = true; return; }
      eqVals.push(normalize(v));
    }
    this.prefix = encodeKey(eqVals);
    let loKey: Uint8Array | undefined, hiKey: Uint8Array | undefined, loInc = true, hiInc = true;
    if (this.lo) { const v = this.lo.expr(this.rows, this.ctx); if (v === null) { this.done = true; return; } loKey = encodeKey([...eqVals, normalize(v)]); loInc = this.lo.inclusive; }
    if (this.hi) { const v = this.hi.expr(this.rows, this.ctx); if (v === null) { this.done = true; return; } hiKey = encodeKey([...eqVals, normalize(v)]); hiInc = this.hi.inclusive; }
    if (this.direction > 0) {
      if (loKey) { this.cursor.seek(loKey); if (!loInc) this.skipPrefix(loKey, 1); }
      else this.cursor.seek(this.prefix);
      this.stopKey = hiKey; this.stopInclusive = hiInc;
    } else {
      const upper = hiKey ?? this.prefix;
      if (hiKey && !hiInc) { this.cursor.seek(hiKey); } else { const u = new Uint8Array(upper.length + 1); u.set(upper); u[upper.length] = 0xff; this.cursor.seek(u); }
      if (!this.cursor.valid()) this.cursor.seekLast(); else this.cursor.prev();
      this.stopKey = loKey; this.stopInclusive = loInc;
    }
  }

  /** Advances past every entry whose leading bytes equal `k` (exclusive bound). */
  private skipPrefix(k: Uint8Array, dir: 1 | -1): void {
    while (this.cursor.valid() && startsWith(this.cursor.key(), k)) { if (dir > 0) this.cursor.next(); else this.cursor.prev(); }
  }

  next(): Row | null {
    if (this.done) return null;
    const c = this.cursor;
    while (c.valid()) {
      const key = c.key();
      if (!startsWith(key, this.prefix)) { this.done = true; return null; }
      if (this.stopKey) {
        const head = key.subarray(0, Math.min(key.length, this.stopKey.length));
        const cmp = compareBytes(head, this.stopKey);
        if (this.direction > 0 ? (cmp > 0 || (cmp === 0 && !this.stopInclusive)) : (cmp < 0 || (cmp === 0 && !this.stopInclusive))) { this.done = true; return null; }
      }
      if (this.direction > 0) c.next(); else c.prev();
      const vals = decodeAll(key);
      const rowid = vals[vals.length - 1] as bigint;
      let row: Row;
      if (this.covering) {
        row = new Array<Value>(this.ncols + 1).fill(null);
        this.index.schema.columns.forEach((col, i) => { row[col] = vals[i]!; });
        row[this.ncols] = rowid;
      } else {
        const tk = rowidKeyBytes(rowid);
        const tv = this.tableTree.get(tk);
        if (tv === null) continue; // dangling entry (should not happen)
        row = decodeTableRow(this.table, tk, tv);
      }
      if (this.filter) { this.rows[0] = row; if (!this.filter(this.rows, this.ctx)) continue; }
      this.stats.rows++;
      return row;
    }
    this.done = true;
    return null;
  }

  protected override onClose(): void { this.done = true; }
}

function decodeAll(key: Uint8Array): Value[] {
  const r = new KeyReader(key);
  const out: Value[] = [];
  while (!r.done) out.push(r.next());
  return out;
}

/** Runs an inner plan in a nested scope: `rows[1]` of the inner plan is an empty row (no lateral references). */
export class SubqueryScan extends OpBase {
  constructor(layout: Layout, private readonly inner: Operator) { super(layout); }
  protected onOpen(): void { this.inner.open(this.ctx.child([EMPTY_ROW, ...this.ctx.outerRows])); }
  next(): Row | null { const r = this.inner.next(); if (r !== null) this.stats.rows++; return r; }
  protected override onClose(): void { this.inner.close(); }
}

/** Materialises a CTE body once per statement execution and replays it. */
export class CteScan extends OpBase {
  private buf: Row[] = [];
  private pos = 0;
  constructor(layout: Layout, private readonly cte: BoundCte, private readonly inner: Operator) { super(layout); }
  protected onOpen(): void {
    let rows = this.ctx.shared.cteRows.get(this.cte);
    if (!rows) {
      rows = [];
      this.inner.open(this.ctx.child([]));
      try { for (let r = this.inner.next(); r !== null; r = this.inner.next()) rows.push(r); } finally { this.inner.close(); }
      this.ctx.shared.cteRows.set(this.cte, rows);
    }
    this.buf = rows;
    this.pos = 0;
  }
  next(): Row | null { if (this.pos >= this.buf.length) return null; this.stats.rows++; return this.buf[this.pos++]!; }
}

export class WorkingTable extends OpBase {
  private buf: Row[] = [];
  private pos = 0;
  constructor(layout: Layout, private readonly cte: BoundCte) { super(layout); }
  protected onOpen(): void { this.buf = this.ctx.shared.workingTables.get(this.cte) ?? []; this.pos = 0; }
  next(): Row | null { if (this.pos >= this.buf.length) return null; this.stats.rows++; return this.buf[this.pos++]!; }
}

export class Values extends OpBase {
  private pos = 0;
  constructor(layout: Layout, private readonly exprs: CompiledExpr[][]) { super(layout); }
  protected onOpen(): void { this.pos = 0; this.rows[0] = EMPTY_ROW; }
  next(): Row | null {
    if (this.pos >= this.exprs.length) return null;
    const fs = this.exprs[this.pos++]!;
    const row = new Array<Value>(fs.length);
    for (let i = 0; i < fs.length; i++) row[i] = fs[i]!(this.rows, this.ctx);
    this.stats.rows++;
    return row;
  }
}

export class Materialize extends OpBase {
  private buf: Row[] = [];
  private pos = 0;
  constructor(layout: Layout, private readonly inner: Operator) { super(layout); }
  protected onOpen(): void {
    this.buf = [];
    this.pos = 0;
    this.inner.open(this.ctx);
    try { for (let r = this.inner.next(); r !== null; r = this.inner.next()) this.buf.push(r); } finally { this.inner.close(); }
  }
  next(): Row | null { if (this.pos >= this.buf.length) return null; this.stats.rows++; return this.buf[this.pos++]!; }
}

export { truthy };
