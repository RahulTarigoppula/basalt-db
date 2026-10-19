/** Filter, Project, Truncate, Limit/Offset, Distinct, Sort (with spill to a scratch B+tree), TopK. */
import { ByteWriter, encodeRecord, decodeRecord, writeKeyValue } from "../../core/encoding.js";
import { BasaltError } from "../../core/errors.js";
import { compareValues, type Row, type Value } from "../../core/types.js";
import type { Layout } from "../../planner/layout.js";
import { MemoryBackend } from "../../storage/backend.js";
import { BTree, MAX_KEY_SIZE, type WriteContext } from "../../storage/btree.js";
import type { PageRef } from "../../storage/bufferpool.js";
import { Pager } from "../../storage/pager.js";
import { EMPTY_ROW, type ExecContext, type Operator } from "../context.js";
import type { CompiledExpr } from "../expr.js";
import { normalize, toInt64 } from "../functions.js";
import { rowKey } from "../hash.js";
import { OpBase } from "./base.js";

export type Predicate = (rows: Row[], ctx: ExecContext) => boolean;

export class Filter extends OpBase {
  constructor(layout: Layout, private readonly input: Operator, private readonly pred: Predicate) { super(layout); }
  protected onOpen(): void { this.input.open(this.ctx); }
  next(): Row | null {
    for (let r = this.input.next(); r !== null; r = this.input.next()) {
      this.rows[0] = r;
      if (this.pred(this.rows, this.ctx)) { this.stats.rows++; return r; }
    }
    return null;
  }
  protected override onClose(): void { this.input.close(); }
}

export class Project extends OpBase {
  constructor(layout: Layout, private readonly input: Operator, private readonly exprs: CompiledExpr[]) { super(layout); }
  protected onOpen(): void { this.input.open(this.ctx); }
  next(): Row | null {
    const r = this.input.next();
    if (r === null) return null;
    this.rows[0] = r;
    const n = this.exprs.length;
    const out = new Array<Value>(n);
    for (let i = 0; i < n; i++) out[i] = this.exprs[i]!(this.rows, this.ctx);
    this.stats.rows++;
    return out;
  }
  protected override onClose(): void { this.input.close(); }
}

export class Truncate extends OpBase {
  constructor(layout: Layout, private readonly input: Operator, private readonly keep: number) { super(layout); }
  protected onOpen(): void { this.input.open(this.ctx); }
  next(): Row | null {
    const r = this.input.next();
    if (r === null) return null;
    this.stats.rows++;
    return r.length === this.keep ? r : r.slice(0, this.keep);
  }
  protected override onClose(): void { this.input.close(); }
}

/** Evaluates a LIMIT/OFFSET expression (negative limit => unlimited, as in SQLite). */
function evalCount(f: CompiledExpr | undefined, rows: Row[], ctx: ExecContext, what: string): number | undefined {
  if (!f) return undefined;
  const v = f(rows, ctx);
  if (v === null) return undefined;
  const n = normalize(v);
  if (typeof n === "string" || n instanceof Uint8Array) throw new BasaltError(`datatype mismatch: ${what} must be an integer`);
  return Number(toInt64(n));
}

export class Limit extends OpBase {
  private remaining = Infinity;
  private skip = 0;
  constructor(layout: Layout, private readonly input: Operator, private readonly limit: CompiledExpr | undefined, private readonly offset: CompiledExpr | undefined) { super(layout); }
  protected onOpen(): void {
    this.rows[0] = EMPTY_ROW;
    const lim = evalCount(this.limit, this.rows, this.ctx, "LIMIT");
    const off = evalCount(this.offset, this.rows, this.ctx, "OFFSET");
    this.remaining = lim === undefined || lim < 0 ? Infinity : lim;
    this.skip = off === undefined || off < 0 ? 0 : off;
    if (this.remaining > 0) this.input.open(this.ctx); else this.remaining = -1;
  }
  next(): Row | null {
    if (this.remaining <= 0) return null;
    while (this.skip > 0) { const r = this.input.next(); if (r === null) { this.remaining = 0; return null; } this.skip--; }
    const r = this.input.next();
    if (r === null) { this.remaining = 0; return null; }
    this.remaining--;
    this.stats.rows++;
    return r;
  }
  protected override onClose(): void { if (this.remaining !== -1) this.input.close(); }
}

export class Distinct extends OpBase {
  private seen = new Set<string>();
  constructor(layout: Layout, private readonly input: Operator, private readonly keyCount: number) { super(layout); }
  protected onOpen(): void { this.seen = new Set(); this.input.open(this.ctx); }
  next(): Row | null {
    for (let r = this.input.next(); r !== null; r = this.input.next()) {
      const k = rowKey(r, this.keyCount);
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      this.stats.rows++;
      return r;
    }
    return null;
  }
  protected override onClose(): void { this.input.close(); this.seen = new Set(); }
}

// ----- sorting -----

export interface CompiledSortKey { expr: CompiledExpr; desc: boolean; nullsFirst: boolean }

/** Compares two already-evaluated key arrays. */
export function compareKeys(a: Value[], b: Value[], keys: readonly CompiledSortKey[]): number {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const x = a[i]!, y = b[i]!;
    if (x === null || y === null) {
      if (x === null && y === null) continue;
      const nullFirst = x === null;
      return (nullFirst === k.nullsFirst) ? -1 : 1;
    }
    const c = compareValues(x, y);
    if (c !== 0) return k.desc ? -c : c;
  }
  return 0;
}

/** Compares one key position: inline fast paths for same-typed INTEGER / REAL / TEXT pairs, `compareValues` otherwise. */
function compareOne(x: Value, y: Value, desc: boolean, nullsFirst: boolean): number {
  if (x === null || y === null) {
    if (x === y) return 0;
    return ((x === null) === nullsFirst) ? -1 : 1;
  }
  let c: number;
  const tx = typeof x;
  if (tx === typeof y) {
    if (tx === "bigint" || tx === "string") c = (x as bigint) < (y as bigint) ? -1 : (x as bigint) > (y as bigint) ? 1 : 0;
    else if (tx === "number" && x === x && y === y) c = (x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0;
    else c = compareValues(x, y);
  } else c = compareValues(x, y);
  return desc ? -c : c;
}

/**
 * Builds the comparator for an ORDER BY once: the per-key direction and NULL placement are captured as constants and
 * the one-key case (the common one) has no loop. Semantics are exactly those of `compareKeys`.
 */
export function makeKeyComparator(keys: readonly CompiledSortKey[]): (a: Value[], b: Value[]) => number {
  if (keys.length === 1) {
    const { desc, nullsFirst } = keys[0]!;
    return (a, b) => compareOne(a[0]!, b[0]!, desc, nullsFirst);
  }
  if (keys.length === 2) {
    const k0 = keys[0]!, k1 = keys[1]!;
    return (a, b) => compareOne(a[0]!, b[0]!, k0.desc, k0.nullsFirst) || compareOne(a[1]!, b[1]!, k1.desc, k1.nullsFirst);
  }
  const n = keys.length;
  const descs = keys.map((k) => k.desc), nulls = keys.map((k) => k.nullsFirst);
  return (a, b) => {
    for (let i = 0; i < n; i++) {
      const c = compareOne(a[i]!, b[i]!, descs[i]!, nulls[i]!);
      if (c !== 0) return c;
    }
    return 0;
  };
}

/** Default spill threshold (rows). */
export const SORT_SPILL_THRESHOLD = 100_000;

class ScratchContext implements WriteContext {
  readonly txnId = 1;
  constructor(private readonly pager: Pager) {}
  owns(): boolean { return true; }
  allocate(): PageRef { return this.pager.allocate(); }
  free(pageId: number): void { this.pager.free(pageId, 0); }
}

/**
 * In-memory sort; above `spillThreshold` rows the keys are encoded into an order-preserving byte string (per key:
 * a NULL-placement flag byte then the value encoding, bytes complemented for DESC) and the rows are inserted into a
 * temporary B+tree in a scratch `MemoryBackend`, then read back in key order.
 */
export class Sort extends OpBase {
  private buf: { keys: Value[]; row: Row }[] = [];
  private pos = 0;
  private spilled: BTree | undefined;
  private cursor: ReturnType<BTree["cursor"]> | undefined;

  constructor(layout: Layout, private readonly input: Operator, private readonly keys: CompiledSortKey[], private readonly spillThreshold = SORT_SPILL_THRESHOLD) { super(layout); }

  private evalKeys(r: Row): Value[] {
    this.rows[0] = r;
    const ks = new Array<Value>(this.keys.length);
    for (let i = 0; i < this.keys.length; i++) ks[i] = normalize(this.keys[i]!.expr(this.rows, this.ctx));
    return ks;
  }

  protected onOpen(): void {
    this.buf = [];
    this.pos = 0;
    this.spilled = undefined;
    this.cursor = undefined;
    this.input.open(this.ctx);
    try {
      let spill: { tree: BTree; seq: number; writer: ByteWriter } | undefined;
      for (let r = this.input.next(); r !== null; r = this.input.next()) {
        const ks = this.evalKeys(r);
        if (spill) { this.spillRow(spill, ks, r); continue; }
        this.buf.push({ keys: ks, row: r });
        if (this.buf.length >= this.spillThreshold) {
          const pager = new Pager(new MemoryBackend(), 512);
          const tree = BTree.create(pager, new ScratchContext(pager));
          spill = { tree, seq: 0, writer: new ByteWriter(256) };
          for (const e of this.buf) this.spillRow(spill, e.keys, e.row);
          this.buf = [];
        }
      }
      if (spill) {
        this.spilled = spill.tree;
        this.cursor = spill.tree.cursor();
        this.cursor.seekFirst();
      } else {
        const cmp = makeKeyComparator(this.keys);
        this.buf.sort((a, b) => cmp(a.keys, b.keys));
      }
    } finally { this.input.close(); }
  }

  private spillRow(spill: { tree: BTree; seq: number; writer: ByteWriter }, ks: Value[], row: Row): void {
    const w = spill.writer;
    w.reset();
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[i]!;
      const v = ks[i]!;
      if (v === null) { w.u8(k.nullsFirst ? 0 : 2); continue; }
      w.u8(1);
      const start = w.pos;
      writeKeyValue(w, v);
      if (k.desc) for (let p = start; p < w.pos; p++) w.buf[p] = 255 - w.buf[p]!;
    }
    w.u32(spill.seq++);
    let key = w.toBytes();
    if (key.length > MAX_KEY_SIZE) {
      // keep the order-relevant prefix; the sequence number keeps keys unique (ties may then be ordered by arrival)
      const cut = key.slice(0, MAX_KEY_SIZE - 4);
      const k2 = new Uint8Array(MAX_KEY_SIZE);
      k2.set(cut);
      k2[MAX_KEY_SIZE - 4] = (spill.seq >>> 24) & 0xff; k2[MAX_KEY_SIZE - 3] = (spill.seq >>> 16) & 0xff; k2[MAX_KEY_SIZE - 2] = (spill.seq >>> 8) & 0xff; k2[MAX_KEY_SIZE - 1] = spill.seq & 0xff;
      key = k2;
    }
    spill.tree.insert(key, encodeRecord(row));
  }

  next(): Row | null {
    if (this.spilled && this.cursor) {
      if (!this.cursor.valid()) return null;
      const row = decodeRecord(this.cursor.value());
      this.cursor.next();
      this.stats.rows++;
      return row;
    }
    if (this.pos >= this.buf.length) return null;
    this.stats.rows++;
    return this.buf[this.pos++]!.row;
  }

  protected override onClose(): void { this.buf = []; this.spilled = undefined; this.cursor = undefined; }
}

/** ORDER BY + LIMIT via a bounded binary heap holding the best `limit + offset` rows. */
export class TopK extends OpBase {
  private out: Row[] = [];
  private pos = 0;
  constructor(layout: Layout, private readonly input: Operator, private readonly keys: CompiledSortKey[], private readonly limit: CompiledExpr, private readonly offset: CompiledExpr | undefined) { super(layout); }

  protected onOpen(): void {
    this.out = [];
    this.pos = 0;
    this.rows[0] = EMPTY_ROW;
    const lim = evalCount(this.limit, this.rows, this.ctx, "LIMIT");
    const off = evalCount(this.offset, this.rows, this.ctx, "OFFSET") ?? 0;
    const skip = Math.max(0, off);
    const k = lim === undefined || lim < 0 ? Infinity : lim + skip;
    if (k === 0) return;
    const keys = this.keys;
    const cmpKeys = makeKeyComparator(keys);
    const cmp = (a: { keys: Value[]; row: Row }, b: { keys: Value[]; row: Row }): number => cmpKeys(a.keys, b.keys);
    // max-heap on the sort order: the root is the worst row kept
    const heap: { keys: Value[]; row: Row; seq: number }[] = [];
    const less = (i: number, j: number): boolean => { const c = cmp(heap[i]!, heap[j]!); return c > 0 || (c === 0 && heap[i]!.seq < heap[j]!.seq); }; // "greater" is at the top
    const up = (i: number): void => { while (i > 0) { const p = (i - 1) >> 1; if (less(i, p)) { [heap[i], heap[p]] = [heap[p]!, heap[i]!]; i = p; } else break; } };
    const down = (i: number): void => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && less(l, m)) m = l; if (r < heap.length && less(r, m)) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m]!, heap[i]!]; i = m; } };
    let seq = 0;
    this.input.open(this.ctx);
    try {
      for (let r = this.input.next(); r !== null; r = this.input.next()) {
        this.rows[0] = r;
        const ks = new Array<Value>(keys.length);
        for (let i = 0; i < keys.length; i++) ks[i] = normalize(keys[i]!.expr(this.rows, this.ctx));
        const e = { keys: ks, row: r, seq: seq++ };
        if (heap.length < k) { heap.push(e); up(heap.length - 1); }
        else {
          const top = heap[0]!;
          const c = cmp(e, top);
          if (c < 0 || (c === 0 && e.seq < top.seq)) { heap[0] = e; down(0); }
        }
      }
    } finally { this.input.close(); }
    heap.sort((a, b) => { const c = cmp(a, b); return c !== 0 ? c : a.seq - b.seq; });
    this.out = heap.slice(skip).map((e) => e.row);
  }

  next(): Row | null { if (this.pos >= this.out.length) return null; this.stats.rows++; return this.out[this.pos++]!; }
  protected override onClose(): void { this.out = []; }
}
