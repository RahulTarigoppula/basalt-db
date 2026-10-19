/**
 * HashAggregate / SortedAggregate (GROUP BY with COUNT DISTINCT, FILTER, GROUP_CONCAT, NULL groups, passthrough columns)
 * and the Window operator (partition -> sort -> frames ROWS/RANGE/GROUPS with EXCLUDE; drives the `WindowFunction` /
 * `AggregateFunction` objects of `functions.ts`).
 */
import { BasaltError } from "../../core/errors.js";
import { compareValues, type Row, type Value } from "../../core/types.js";
import type { Layout } from "../../planner/layout.js";
import type { FrameExclude, FrameUnit } from "../../sql/ast.js";
import type { BoundFrameBound } from "../../sql/bound.js";
import type { ExecContext, Operator } from "../context.js";
import type { CompiledExpr } from "../expr.js";
import { normalize, toInt64, type AggregateFunction, type WindowFrameContext, type WindowFunction } from "../functions.js";
import { appendValueKey, rowKey } from "../hash.js";
import { OpBase } from "./base.js";
import { compareKeys, type CompiledSortKey, type Predicate } from "./basic.js";

export interface CompiledAgg {
  fn: AggregateFunction<unknown>;
  args: CompiledExpr[];
  star: boolean;
  distinct: boolean;
  filter?: Predicate;
}

interface Group { keys: Value[]; states: unknown[]; distinct: (Set<string> | null)[]; pass: Value[] | null; buf: Value[][] }

function newGroup(keys: Value[], aggs: CompiledAgg[], passCount: number): Group {
  return {
    keys, states: aggs.map((a) => a.fn.init()), distinct: aggs.map((a) => (a.distinct ? new Set<string>() : null)),
    pass: passCount > 0 ? null : [], buf: aggs.map((a) => new Array<Value>(a.args.length).fill(null)),
  };
}

function stepGroup(g: Group, aggs: CompiledAgg[], rows: Row[], ctx: ExecContext): void {
  for (let i = 0; i < aggs.length; i++) {
    const a = aggs[i]!;
    if (a.filter && !a.filter(rows, ctx)) continue;
    const buf = g.buf[i]!;
    for (let j = 0; j < a.args.length; j++) buf[j] = a.args[j]!(rows, ctx);
    if (a.distinct) {
      const v = buf[0] ?? null;
      if (v === null) continue;
      const k = appendValueKey(normalize(v));
      const set = g.distinct[i]!;
      if (set.has(k)) continue;
      set.add(k);
    }
    a.fn.step(g.states[i], buf);
  }
}

function finishGroup(g: Group, aggs: CompiledAgg[], passCount: number): Row {
  const out: Value[] = g.keys.slice();
  for (let i = 0; i < aggs.length; i++) out.push(aggs[i]!.fn.final(g.states[i]));
  if (passCount > 0) { const p = g.pass ?? new Array<Value>(passCount).fill(null); for (let i = 0; i < passCount; i++) out.push(p[i] ?? null); }
  return out;
}

export class HashAggregate extends OpBase {
  private groups = new Map<string, Group>();
  private iter: Iterator<Group> | null = null;
  private single: Group | null = null;

  constructor(layout: Layout, private readonly input: Operator, private readonly groupBy: CompiledExpr[], private readonly aggs: CompiledAgg[], private readonly passthrough: number[]) { super(layout); }

  protected onOpen(): void {
    this.groups = new Map();
    this.single = null;
    const keyBuf = new Array<Value>(this.groupBy.length);
    this.input.open(this.ctx);
    try {
      for (let r = this.input.next(); r !== null; r = this.input.next()) {
        this.rows[0] = r;
        let g: Group;
        if (this.groupBy.length === 0) {
          if (!this.single) this.single = newGroup([], this.aggs, this.passthrough.length);
          g = this.single;
        } else {
          for (let i = 0; i < this.groupBy.length; i++) keyBuf[i] = this.groupBy[i]!(this.rows, this.ctx);
          const k = rowKey(keyBuf);
          let gg = this.groups.get(k);
          if (!gg) { gg = newGroup(keyBuf.slice(), this.aggs, this.passthrough.length); this.groups.set(k, gg); }
          g = gg;
        }
        if (this.passthrough.length && g.pass === null) g.pass = this.passthrough.map((slot) => r[slot] ?? null);
        stepGroup(g, this.aggs, this.rows, this.ctx);
      }
    } finally { this.input.close(); }
    if (this.groupBy.length === 0 && !this.single) this.single = newGroup([], this.aggs, this.passthrough.length);
    this.iter = this.groupBy.length === 0 ? [this.single!][Symbol.iterator]() : this.groups.values();
  }

  next(): Row | null {
    const n = this.iter!.next();
    if (n.done) return null;
    this.stats.rows++;
    return finishGroup(n.value, this.aggs, this.passthrough.length);
  }

  protected override onClose(): void { this.groups = new Map(); this.iter = null; }
}

/** Input arrives grouped (sorted by the GROUP BY keys): emit a group when the key changes. */
export class SortedAggregate extends OpBase {
  private current: Group | null = null;
  private currentKey = "";
  private pending: Row | null = null;
  private exhausted = false;

  constructor(layout: Layout, private readonly input: Operator, private readonly groupBy: CompiledExpr[], private readonly aggs: CompiledAgg[], private readonly passthrough: number[]) { super(layout); }

  protected onOpen(): void { this.current = null; this.pending = null; this.exhausted = false; this.input.open(this.ctx); }

  next(): Row | null {
    if (this.exhausted) return null;
    const keyBuf = new Array<Value>(this.groupBy.length);
    for (;;) {
      const r = this.pending ?? this.input.next();
      this.pending = null;
      if (r === null) {
        this.exhausted = true;
        if (this.current) { const g = this.current; this.current = null; this.stats.rows++; return finishGroup(g, this.aggs, this.passthrough.length); }
        if (this.groupBy.length === 0) { this.stats.rows++; return finishGroup(newGroup([], this.aggs, this.passthrough.length), this.aggs, this.passthrough.length); }
        return null;
      }
      this.rows[0] = r;
      for (let i = 0; i < this.groupBy.length; i++) keyBuf[i] = this.groupBy[i]!(this.rows, this.ctx);
      const k = rowKey(keyBuf);
      if (this.current && k !== this.currentKey) {
        const g = this.current;
        this.current = newGroup(keyBuf.slice(), this.aggs, this.passthrough.length);
        this.currentKey = k;
        this.feed(this.current, r);
        this.stats.rows++;
        return finishGroup(g, this.aggs, this.passthrough.length);
      }
      if (!this.current) { this.current = newGroup(keyBuf.slice(), this.aggs, this.passthrough.length); this.currentKey = k; }
      this.feed(this.current, r);
    }
  }

  private feed(g: Group, r: Row): void {
    this.rows[0] = r;
    if (this.passthrough.length && g.pass === null) g.pass = this.passthrough.map((slot) => r[slot] ?? null);
    stepGroup(g, this.aggs, this.rows, this.ctx);
  }

  protected override onClose(): void { this.input.close(); this.current = null; }
}

// ----- window -----

export interface CompiledFrameBound { kind: BoundFrameBound["kind"]; offset?: CompiledExpr }
export interface CompiledFrame { unit: FrameUnit; start: CompiledFrameBound; end: CompiledFrameBound; exclude: FrameExclude }

export interface CompiledWindow {
  /** Position in the output (after the input columns). */
  index: number;
  fn: WindowFunction | undefined;
  agg: AggregateFunction<unknown> | undefined;
  args: CompiledExpr[];
  distinct: boolean;
  filter?: Predicate;
  partitionBy: CompiledExpr[];
  orderBy: CompiledSortKey[];
  frame?: CompiledFrame;
  /** Windows sharing partition/order/frame are evaluated over one sort. */
  specKey: string;
}

interface SortedRow { row: Row; part: string; order: Value[]; idx: number }

export class Window extends OpBase {
  private out: Row[] = [];
  private pos = 0;

  constructor(layout: Layout, private readonly input: Operator, private readonly windows: CompiledWindow[]) { super(layout); }

  protected onOpen(): void {
    this.pos = 0;
    const input: Row[] = [];
    this.input.open(this.ctx);
    try { for (let r = this.input.next(); r !== null; r = this.input.next()) input.push(r); } finally { this.input.close(); }
    const n = input.length;
    const results: Value[][] = this.windows.map(() => new Array<Value>(n).fill(null));
    // group windows by spec
    const groups = new Map<string, CompiledWindow[]>();
    for (const w of this.windows) { const g = groups.get(w.specKey); if (g) g.push(w); else groups.set(w.specKey, [w]); }
    for (const ws of groups.values()) this.evalSpecGroup(input, ws, results);
    this.out = input.map((r, i) => { const o = r.slice(); for (let w = 0; w < this.windows.length; w++) o.push(results[w]![i]!); return o; });
  }

  private evalSpecGroup(input: Row[], ws: CompiledWindow[], results: Value[][]): void {
    const spec = ws[0]!;
    const sorted: SortedRow[] = input.map((row, idx) => {
      this.rows[0] = row;
      let part = "";
      for (const p of spec.partitionBy) part += appendValueKey(normalize(p(this.rows, this.ctx)));
      const order = spec.orderBy.map((o) => normalize(o.expr(this.rows, this.ctx)));
      return { row, part, order, idx };
    });
    const keys = spec.orderBy;
    sorted.sort((a, b) => (a.part < b.part ? -1 : a.part > b.part ? 1 : compareKeys(a.order, b.order, keys) || a.idx - b.idx));
    // partitions
    let s = 0;
    while (s < sorted.length) {
      let e = s + 1;
      while (e < sorted.length && sorted[e]!.part === sorted[s]!.part) e++;
      this.evalPartition(sorted.slice(s, e), ws, results);
      s = e;
    }
  }

  private evalPartition(part: SortedRow[], ws: CompiledWindow[], results: Value[][]): void {
    const size = part.length;
    const spec = ws[0]!;
    const hasOrder = spec.orderBy.length > 0;
    // peer groups
    const peerStart = new Array<number>(size), peerEnd = new Array<number>(size), peerGroup = new Array<number>(size);
    let g = 0;
    for (let i = 0; i < size;) {
      let j = i + 1;
      if (hasOrder) while (j < size && compareKeys(part[i]!.order, part[j]!.order, spec.orderBy) === 0) j++;
      else j = size;
      for (let k = i; k < j; k++) { peerStart[k] = i; peerEnd[k] = j - 1; peerGroup[k] = g; }
      g++;
      i = j;
    }
    const groupStarts: number[] = [];
    for (let i = 0; i < size; i++) if (i === 0 || peerGroup[i] !== peerGroup[i - 1]) groupStarts.push(i);
    const groupEnds = groupStarts.map((st, gi) => (gi + 1 < groupStarts.length ? groupStarts[gi + 1]! - 1 : size - 1));

    for (const w of ws) {
      const windowIndex = this.windows.indexOf(w);
      const res = results[windowIndex]!;
      // evaluate arguments for every row
      const args: Value[][] = new Array(size);
      const filterOk: boolean[] | null = w.filter ? new Array<boolean>(size) : null;
      for (let i = 0; i < size; i++) {
        this.rows[0] = part[i]!.row;
        const a = new Array<Value>(w.args.length);
        for (let j = 0; j < w.args.length; j++) a[j] = w.args[j]!(this.rows, this.ctx);
        args[i] = a;
        if (filterOk) filterOk[i] = w.filter!(this.rows, this.ctx);
      }
      const frame = w.frame;
      const frameOf = (i: number): [number, number] => this.frameBounds(frame, i, size, part, peerStart, peerEnd, peerGroup, groupStarts, groupEnds, hasOrder, spec.orderBy);
      const excluded = (frame?.exclude ?? "NO OTHERS") !== "NO OTHERS";
      const isExcluded = (i: number, cur: number): boolean => {
        if (!frame) return false;
        switch (frame.exclude) {
          case "CURRENT ROW": return i === cur;
          case "GROUP": return peerGroup[i] === peerGroup[cur];
          case "TIES": return peerGroup[i] === peerGroup[cur] && i !== cur;
          default: return false;
        }
      };
      if (w.fn) {
        for (let i = 0; i < size; i++) {
          const [fs, fe] = frameOf(i);
          const ctx: WindowFrameContext = {
            args, size, index: i, frameStart: fs, frameEnd: fe, peerStart: peerStart[i]!, peerEnd: peerEnd[i]!, peerGroup: peerGroup[i]!,
            isExcluded: excluded ? (j: number): boolean => isExcluded(j, i) : undefined,
          };
          res[part[i]!.idx] = w.fn.compute(ctx);
        }
        continue;
      }
      const agg = w.agg!;
      const startUnbounded = !frame || frame.start.kind === "unboundedPreceding";
      if (startUnbounded && !excluded && !w.distinct) {
        // incremental: the frame end never moves backwards as i increases
        const state = agg.init();
        let stepped = 0;
        for (let i = 0; i < size; i++) {
          const fe = frameOf(i)[1];
          while (stepped <= fe) { if (!filterOk || filterOk[stepped]) agg.step(state, args[stepped]!); stepped++; }
          res[part[i]!.idx] = agg.final(state);
        }
        continue;
      }
      for (let i = 0; i < size; i++) {
        const [fs, fe] = frameOf(i);
        const state = agg.init();
        const seen = w.distinct ? new Set<string>() : null;
        for (let j = fs; j <= fe; j++) {
          if (excluded && isExcluded(j, i)) continue;
          if (filterOk && !filterOk[j]) continue;
          if (seen) { const v = args[j]![0] ?? null; if (v === null) continue; const k = appendValueKey(normalize(v)); if (seen.has(k)) continue; seen.add(k); }
          agg.step(state, args[j]!);
        }
        res[part[i]!.idx] = agg.final(state);
      }
    }
  }

  private frameBounds(frame: CompiledFrame | undefined, i: number, size: number, part: SortedRow[], peerStart: number[], peerEnd: number[], peerGroup: number[],
    groupStarts: number[], groupEnds: number[], hasOrder: boolean, orderBy: CompiledSortKey[]): [number, number] {
    if (!frame) return hasOrder ? [0, peerEnd[i]!] : [0, size - 1];
    const offsetOf = (b: CompiledFrameBound): number => {
      if (!b.offset) return 0;
      this.rows[0] = part[i]!.row;
      const v = b.offset(this.rows, this.ctx);
      if (v === null) throw new BasaltError("frame offset must not be NULL");
      const n = normalize(v);
      if (typeof n === "number") { if (n < 0) throw new BasaltError("frame starting offset must be a non-negative number"); return n; }
      const k = Number(toInt64(n));
      if (k < 0) throw new BasaltError("frame starting offset must be a non-negative integer");
      return k;
    };
    const bound = (b: CompiledFrameBound, isStart: boolean): number => {
      switch (b.kind) {
        case "unboundedPreceding": return 0;
        case "unboundedFollowing": return size - 1;
        case "currentRow": return frame.unit === "ROWS" ? i : isStart ? peerStart[i]! : peerEnd[i]!;
        case "preceding": case "following": {
          const off = offsetOf(b);
          const sign = b.kind === "preceding" ? -1 : 1;
          if (frame.unit === "ROWS") return i + sign * off;
          if (frame.unit === "GROUPS") {
            const gi = peerGroup[i]! + sign * off;
            if (gi < 0) return isStart ? 0 : -1;
            if (gi >= groupStarts.length) return isStart ? size : size - 1;
            return isStart ? groupStarts[gi]! : groupEnds[gi]!;
          }
          // RANGE with offset: rows whose order value lies within [v - off, v + off] in the ORDER BY direction
          const key = orderBy[0]!;
          const v = part[i]!.order[0] ?? null;
          if (v === null) return isStart ? peerStart[i]! : peerEnd[i]!;
          const num = typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : null;
          if (num === null) throw new BasaltError("RANGE offsets require a numeric ORDER BY value");
          // in sort order direction, "preceding" means smaller sort position
          const dir = key.desc ? -1 : 1;
          const target = num + sign * dir * off; // value at the frame edge
          if (b.kind === "preceding") {
            // first row j whose value is >= target (ASC) / <= target (DESC); NULLs (sorted first) never qualify
            let j = peerStart[i]!;
            while (j > 0) {
              const u = part[j - 1]!.order[0] ?? null;
              if (u === null) break;
              const un = typeof u === "bigint" ? Number(u) : (u as number);
              if ((dir > 0 && un >= target) || (dir < 0 && un <= target)) j--; else break;
            }
            return j;
          }
          let j = peerEnd[i]!;
          while (j + 1 < size) {
            const u = part[j + 1]!.order[0] ?? null;
            if (u === null) break;
            const un = typeof u === "bigint" ? Number(u) : (u as number);
            if ((dir > 0 && un <= target) || (dir < 0 && un >= target)) j++; else break;
          }
          return j;
        }
      }
    };
    let s = bound(frame.start, true), e = bound(frame.end, false);
    if (s < 0) s = 0;
    if (e > size - 1) e = size - 1;
    if (s > size - 1 || e < 0 || s > e) return [0, -1];
    return [s, e];
  }

  next(): Row | null { if (this.pos >= this.out.length) return null; this.stats.rows++; return this.out[this.pos++]!; }
  protected override onClose(): void { this.out = []; }
}

export { compareValues };
