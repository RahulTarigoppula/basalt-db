/**
 * Join operators. Output row = [...leftRow, ...rightRow] (semi/anti: the left row only).
 *
 * - NestedLoopJoin: materialises the right side once, then loops; supports every join type (FULL via match marks).
 * - HashJoin: builds a hash table on the right side keyed by the normalised key values (booleans -> 0/1, integral REAL =
 *   INTEGER), probes with the left side; RIGHT/FULL emit unmatched build rows at the end via match marking.
 * - MergeJoin: both inputs sorted ascending on a single equi-key; INNER and LEFT.
 */
import { compareValues, type Row, type Value } from "../../core/types.js";
import type { Layout } from "../../planner/layout.js";
import type { LogicalJoinType } from "../../planner/logical.js";
import type { ExecContext, Operator } from "../context.js";
import type { CompiledExpr } from "../expr.js";
import { normalize } from "../functions.js";
import { joinKey } from "../hash.js";
import { OpBase } from "./base.js";
import type { Predicate } from "./basic.js";

function nulls(n: number): Row { return new Array<Value>(n).fill(null); }

export class NestedLoopJoin extends OpBase {
  private inner: Row[] = [];
  private matched: Uint8Array = new Uint8Array(0);
  private leftRow: Row | null = null;
  private leftMatched = false;
  private i = 0;
  private phase: "loop" | "unmatched" | "done" = "done";
  private readonly rightWidth: number;
  private readonly leftWidth: number;
  private readonly scratch: Row;

  constructor(layout: Layout, private readonly type: LogicalJoinType, private readonly left: Operator, private readonly right: Operator, private readonly cond: Predicate | undefined, leftWidth: number, rightWidth: number) {
    super(layout);
    this.leftWidth = leftWidth;
    this.rightWidth = rightWidth;
    this.scratch = new Array<Value>(leftWidth + rightWidth).fill(null);
  }

  protected onOpen(): void {
    this.inner = [];
    this.right.open(this.ctx);
    try { for (let r = this.right.next(); r !== null; r = this.right.next()) this.inner.push(r); } finally { this.right.close(); }
    this.matched = new Uint8Array(this.inner.length);
    this.left.open(this.ctx);
    this.leftRow = null;
    this.i = 0;
    this.phase = "loop";
  }

  /** Evaluates the condition on the pair without allocating; returns the combined row only when it passes. */
  private test(l: Row, r: Row): Row | null {
    if (!this.cond) return l.concat(r);
    const s = this.scratch;
    for (let i = 0; i < this.leftWidth; i++) s[i] = l[i] ?? null;
    for (let i = 0; i < this.rightWidth; i++) s[this.leftWidth + i] = r[i] ?? null;
    this.rows[0] = s;
    return this.cond(this.rows, this.ctx) ? s.slice() : null;
  }

  next(): Row | null {
    for (;;) {
      if (this.phase === "done") return null;
      if (this.phase === "unmatched") {
        while (this.i < this.inner.length) {
          const j = this.i++;
          if (!this.matched[j]) { this.stats.rows++; return nulls(this.leftWidth).concat(this.inner[j]!); }
        }
        this.phase = "done";
        return null;
      }
      if (this.leftRow === null) {
        const l = this.left.next();
        if (l === null) {
          this.left.close();
          if (this.type === "FULL") { this.phase = "unmatched"; this.i = 0; continue; }
          this.phase = "done";
          return null;
        }
        this.leftRow = l;
        this.leftMatched = false;
        this.i = 0;
      }
      const l = this.leftRow;
      while (this.i < this.inner.length) {
        const j = this.i++;
        const out = this.test(l, this.inner[j]!);
        if (out === null) continue;
        this.matched[j] = 1;
        this.leftMatched = true;
        if (this.type === "SEMI") { this.leftRow = null; this.stats.rows++; return l; }
        if (this.type === "ANTI") break; // matched: not emitted
        this.stats.rows++;
        return out;
      }
      // end of inner for this left row
      const wasMatched = this.leftMatched;
      this.leftRow = null;
      if (this.type === "ANTI" && !wasMatched) { this.stats.rows++; return l; }
      if ((this.type === "LEFT" || this.type === "FULL") && !wasMatched) { this.stats.rows++; return l.concat(nulls(this.rightWidth)); }
    }
  }

  protected override onClose(): void { this.inner = []; if (this.phase === "loop") this.left.close(); this.phase = "done"; }
}

interface Bucket { rows: Row[]; matched: Uint8Array | null }

export class HashJoin extends OpBase {
  private table = new Map<string, Bucket>();
  private buildRows: Row[] = [];
  private probe: Row | null = null;
  private bucket: Bucket | null = null;
  private bi = 0;
  private probeMatched = false;
  private phase: "probe" | "unmatched" | "done" = "done";
  private unmatchedIter: Iterator<Bucket> | null = null;
  private unmatchedBucket: Bucket | null = null;
  private ui = 0;
  private readonly keyBuf: Value[];

  constructor(layout: Layout, private readonly type: LogicalJoinType, private readonly left: Operator, private readonly right: Operator,
    private readonly leftKeys: CompiledExpr[], private readonly rightKeys: CompiledExpr[], private readonly residual: Predicate | undefined,
    private readonly leftWidth: number, private readonly rightWidth: number) {
    super(layout);
    this.keyBuf = new Array<Value>(leftKeys.length);
  }

  private keyOf(fs: CompiledExpr[], row: Row): string | null {
    this.rows[0] = row;
    for (let i = 0; i < fs.length; i++) this.keyBuf[i] = normalize(fs[i]!(this.rows, this.ctx));
    return joinKey(this.keyBuf);
  }

  protected onOpen(): void {
    this.table = new Map();
    this.buildRows = [];
    const mark = this.type === "FULL";
    // build on the right side; key expressions of each side are compiled against that side's own layout
    this.right.open(this.ctx);
    try {
      for (let r = this.right.next(); r !== null; r = this.right.next()) {
        const k = this.keyOf(this.rightKeys, r);
        if (k === null) { if (mark) this.buildRows.push(r); continue; }
        let b = this.table.get(k);
        if (!b) { b = { rows: [], matched: null }; this.table.set(k, b); }
        b.rows.push(r);
      }
    } finally { this.right.close(); }
    if (mark) for (const b of this.table.values()) b.matched = new Uint8Array(b.rows.length);
    this.left.open(this.ctx);
    this.probe = null;
    this.bucket = null;
    this.phase = "probe";
  }

  next(): Row | null {
    for (;;) {
      if (this.phase === "done") return null;
      if (this.phase === "unmatched") return this.nextUnmatched();
      if (this.probe === null) {
        const l = this.left.next();
        if (l === null) {
          this.left.close();
          if (this.type === "FULL") { this.phase = "unmatched"; this.unmatchedIter = this.table.values(); this.unmatchedBucket = null; this.ui = 0; continue; }
          this.phase = "done";
          return null;
        }
        this.probe = l;
        this.probeMatched = false;
        this.bi = 0;
        const k = this.keyOf(this.leftKeys, l);
        this.bucket = k === null ? null : (this.table.get(k) ?? null);
      }
      const l = this.probe;
      const b = this.bucket;
      if (b) {
        while (this.bi < b.rows.length) {
          const j = this.bi++;
          const r = b.rows[j]!;
          const out = l.concat(r);
          if (this.residual) { this.rows[0] = out; if (!this.residual(this.rows, this.ctx)) continue; }
          if (b.matched) b.matched[j] = 1;
          this.probeMatched = true;
          if (this.type === "SEMI") { this.probe = null; this.stats.rows++; return l; }
          if (this.type === "ANTI") break;
          this.stats.rows++;
          return out;
        }
      }
      const matched = this.probeMatched;
      this.probe = null;
      if (this.type === "ANTI" && !matched) { this.stats.rows++; return l; }
      if ((this.type === "LEFT" || this.type === "FULL") && !matched) { this.stats.rows++; return l.concat(nulls(this.rightWidth)); }
    }
  }

  private nextUnmatched(): Row | null {
    // rows with NULL keys never matched
    if (this.buildRows.length) { const r = this.buildRows.pop()!; this.stats.rows++; return nulls(this.leftWidth).concat(r); }
    for (;;) {
      if (this.unmatchedBucket === null) {
        const n = this.unmatchedIter!.next();
        if (n.done) { this.phase = "done"; return null; }
        this.unmatchedBucket = n.value;
        this.ui = 0;
      }
      const b = this.unmatchedBucket;
      while (this.ui < b.rows.length) {
        const j = this.ui++;
        if (!b.matched || !b.matched[j]) { this.stats.rows++; return nulls(this.leftWidth).concat(b.rows[j]!); }
      }
      this.unmatchedBucket = null;
    }
  }

  protected override onClose(): void { this.table = new Map(); this.buildRows = []; if (this.phase === "probe") this.left.close(); this.phase = "done"; }
}

/** Both inputs sorted ascending by their single key (NULLs first). */
export class MergeJoin extends OpBase {
  private l: Row | null = null;
  private r: Row | null = null;
  private rGroup: Row[] = [];
  private rGroupKey: Value = null;
  private gi = 0;
  private lKey: Value = null;
  private lMatched = false;
  private done = true;

  constructor(layout: Layout, private readonly type: "INNER" | "LEFT", private readonly left: Operator, private readonly right: Operator,
    private readonly leftKey: CompiledExpr, private readonly rightKey: CompiledExpr, private readonly residual: Predicate | undefined,
    private readonly leftWidth: number, private readonly rightWidth: number) { super(layout); }

  private key(f: CompiledExpr, row: Row, _right: boolean): Value {
    this.rows[0] = row;
    return normalize(f(this.rows, this.ctx));
  }

  protected onOpen(): void {
    this.left.open(this.ctx);
    this.right.open(this.ctx);
    this.l = null; this.r = this.right.next();
    this.rGroup = []; this.gi = 0; this.done = false;
  }

  /** Loads the next group of right rows sharing one key. */
  private loadGroup(): void {
    this.rGroup = [];
    if (this.r === null) return;
    const k = this.key(this.rightKey, this.r, true);
    this.rGroupKey = k;
    while (this.r !== null) {
      const rk = this.key(this.rightKey, this.r, true);
      if (compareValues(rk, k) !== 0) break;
      this.rGroup.push(this.r);
      this.r = this.right.next();
    }
  }

  next(): Row | null {
    if (this.done) return null;
    for (;;) {
      if (this.l === null) {
        this.l = this.left.next();
        if (this.l === null) { this.done = true; return null; }
        this.lKey = this.key(this.leftKey, this.l, false);
        this.lMatched = false;
        this.gi = 0;
        if (this.lKey === null) { // NULL never joins
          const l = this.l; this.l = null;
          if (this.type === "LEFT") { this.stats.rows++; return l.concat(nulls(this.rightWidth)); }
          continue;
        }
        // advance right groups until key >= left key
        while (this.rGroup.length === 0 || compareValues(this.rGroupKey, this.lKey) < 0) {
          if (this.r === null && this.rGroup.length === 0) break;
          if (this.rGroup.length && compareValues(this.rGroupKey, this.lKey) >= 0) break;
          if (this.r === null) { this.rGroup = []; break; }
          this.loadGroup();
          if (this.rGroupKey === null) { this.rGroup = []; if (this.r === null) break; continue; }
        }
      }
      const l = this.l;
      if (this.rGroup.length && compareValues(this.rGroupKey, this.lKey) === 0) {
        while (this.gi < this.rGroup.length) {
          const out = l.concat(this.rGroup[this.gi++]!);
          if (this.residual) { this.rows[0] = out; if (!this.residual(this.rows, this.ctx)) continue; }
          this.lMatched = true;
          this.stats.rows++;
          return out;
        }
      }
      const matched = this.lMatched;
      this.l = null;
      if (this.type === "LEFT" && !matched) { this.stats.rows++; return l.concat(nulls(this.rightWidth)); }
    }
  }

  protected override onClose(): void { this.left.close(); this.right.close(); this.done = true; }
}

export type { ExecContext };
