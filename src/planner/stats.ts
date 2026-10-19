/**
 * Cardinality estimation. Sources, in order of preference: `basalt_stats` (written by ANALYZE: row count, per-column
 * distinct count, null fraction, min/max and a 32-bucket equi-height histogram), then the live `BTree.count()` of the
 * table (cached per transaction by the catalog), then defaults (`DEFAULT_EQ_SELECTIVITY` = 0.1 for equality,
 * `DEFAULT_RANGE_SELECTIVITY` = 0.33 for ranges). Conjunctions use the independence assumption with exponential
 * back-off (the i-th most selective factor is raised to 1/2^i) so stacked predicates do not collapse to zero.
 */
import type { ColumnStats, TableInfo, TableStats } from "../catalog/catalog.js";
import { compareValues, type Value } from "../core/types.js";
import { evaluateConstant, isConstantExpr } from "../exec/expr.js";
import { normalize } from "../exec/functions.js";
import type { BoundExpr } from "../sql/bound.js";
import { conjuncts } from "./build.js";
import { directRefs } from "./layout.js";

export const DEFAULT_EQ_SELECTIVITY = 0.1;
export const DEFAULT_RANGE_SELECTIVITY = 0.33;
export const DEFAULT_NULL_FRAC = 0.05;
export const HISTOGRAM_BUCKETS = 32;

export interface StatsSource {
  tableStats(table: string): TableStats | undefined;
  rowCount(table: string): number;
}

/** Relation -> base table (for relations that are plain table scans). */
export type RelTables = Map<number, { table: TableInfo; rows: number }>;

export class Estimator {
  constructor(private readonly src: StatsSource) {}

  tableRows(info: TableInfo): number {
    const s = this.src.tableStats(info.schema.name);
    if (s && s.nRows > 0) return s.nRows;
    return Math.max(1, this.src.rowCount(info.schema.name));
  }

  columnStats(info: TableInfo, column: number): ColumnStats | undefined {
    return this.src.tableStats(info.schema.name)?.columns.get(column);
  }

  /** Distinct values of a column (falls back to a share of the row count). */
  nDistinct(info: TableInfo, column: number): number {
    const rows = this.tableRows(info);
    if (column === info.schema.rowidColumn || column === -1) return rows;
    const s = this.columnStats(info, column);
    if (s && s.nDistinct > 0) return Math.min(s.nDistinct, Math.max(1, rows));
    const col = info.schema.columns[column];
    if (col && (col.unique || col.primaryKey)) return rows;
    // without statistics assume a share of the rows, but never fewer than 200 distinct values on larger tables
    return Math.max(1, Math.min(rows, Math.max(Math.ceil(rows * DEFAULT_EQ_SELECTIVITY), Math.min(rows, 200))));
  }

  /** Selectivity of a predicate over the relations in `rels` (relation -> table). */
  selectivity(pred: BoundExpr | undefined, rels: RelTables): number {
    if (!pred) return 1;
    // merge lower and upper bounds on the same column into one interval before assuming independence
    const list = conjuncts(pred);
    const parts: number[] = [];
    const ranges = new Map<string, { col: { table: TableInfo; column: number }; lo?: Value; hi?: Value; members: BoundExpr[] }>();
    const rest: BoundExpr[] = [];
    for (const c of list) {
      const r = this.asRange(c, rels);
      if (!r) { rest.push(c); continue; }
      const key = `${r.col.table.schema.name}:${r.col.column}`;
      let e = ranges.get(key);
      if (!e) { e = { col: r.col, members: [] }; ranges.set(key, e); }
      e.members.push(c);
      if (r.lower) e.lo = r.value; else e.hi = r.value;
    }
    for (const e of ranges.values()) {
      const st = this.columnStats(e.col.table, e.col.column);
      if (e.lo !== undefined && e.hi !== undefined && st) {
        const a = fractionBelow(st, e.lo), b = fractionBelow(st, e.hi);
        if (a !== undefined && b !== undefined) { parts.push(clamp(Math.max(b - a, 0.5 / Math.max(1, this.tableRows(e.col.table))) * (1 - st.nullFrac))); continue; }
      }
      for (const m of e.members) parts.push(this.one(m, rels));
    }
    for (const c of rest) parts.push(this.one(c, rels));
    parts.sort((a, b) => a - b);
    let s = 1, exp = 1;
    for (const p of parts) { s *= Math.pow(p, exp); exp /= 2; }
    return clamp(s);
  }

  /** `column < const` style conjunct (either operand order); `lower` is true for a lower bound. */
  private asRange(c: BoundExpr, rels: RelTables): { col: { table: TableInfo; column: number }; value: Value; lower: boolean } | undefined {
    if (c.kind !== "binary" || (c.op !== "<" && c.op !== "<=" && c.op !== ">" && c.op !== ">=")) return undefined;
    let col = this.column(c.left, rels), other = c.right, lower = c.op === ">" || c.op === ">=";
    if (!col) { col = this.column(c.right, rels); other = c.left; lower = !lower; }
    if (!col) return undefined;
    const v = this.constant(other);
    if (v === undefined || v === null) return undefined;
    return { col, value: v, lower };
  }

  private one(e: BoundExpr, rels: RelTables): number {
    switch (e.kind) {
      case "literal": return 1;
      case "binary": {
        switch (e.op) {
          case "AND": return this.selectivity(e, rels);
          case "OR": { const a = this.one(e.left, rels), b = this.one(e.right, rels); return clamp(a + b - a * b); }
          case "=": case "==": case "IS": case "IS NOT DISTINCT FROM": return this.equality(e.left, e.right, rels);
          case "!=": case "<>": case "IS NOT": case "IS DISTINCT FROM": return clamp(1 - this.equality(e.left, e.right, rels));
          case "<": case "<=": case ">": case ">=": return this.range(e.left, e.right, e.op, rels);
          default: return DEFAULT_RANGE_SELECTIVITY;
        }
      }
      case "unary": return e.op === "NOT" ? clamp(1 - this.one(e.operand, rels)) : DEFAULT_RANGE_SELECTIVITY;
      case "between": {
        const lo = this.range(e.expr, e.low, ">=", rels), hi = this.range(e.expr, e.high, "<=", rels);
        const s = clamp(Math.max(0.001, lo + hi - 1));
        return e.not ? clamp(1 - s) : s;
      }
      case "in": {
        if (e.list) {
          const col = this.column(e.expr, rels);
          const base = col ? 1 / this.nDistinct(col.table, col.column) : DEFAULT_EQ_SELECTIVITY;
          const s = clamp(base * e.list.length);
          return e.not ? clamp(1 - s) : s;
        }
        return e.not ? 0.9 : 0.5;
      }
      case "isnull": {
        const col = this.column(e.expr, rels);
        const nf = col ? (this.columnStats(col.table, col.column)?.nullFrac ?? (col.table.schema.columns[col.column]?.notNull ? 0 : DEFAULT_NULL_FRAC)) : DEFAULT_NULL_FRAC;
        return e.not ? clamp(1 - nf) : clamp(nf);
      }
      case "like": return e.not ? 0.9 : 0.1;
      case "exists": return e.not ? 0.5 : 0.5;
      default: return DEFAULT_RANGE_SELECTIVITY;
    }
  }

  private column(e: BoundExpr, rels: RelTables): { table: TableInfo; column: number } | undefined {
    if (e.kind === "column" && e.depth === 0) { const r = rels.get(e.relation); if (r) return { table: r.table, column: e.column }; }
    if (e.kind === "rowid" && e.depth === 0) { const r = rels.get(e.relation); if (r) return { table: r.table, column: -1 }; }
    return undefined;
  }

  private constant(e: BoundExpr): Value | undefined {
    if (!isConstantExpr(e)) return undefined;
    try { return normalize(evaluateConstant(e)); } catch { return undefined; }
  }

  private equality(a: BoundExpr, b: BoundExpr, rels: RelTables): number {
    const ca = this.column(a, rels), cb = this.column(b, rels);
    if (ca && cb) return 1 / Math.max(this.nDistinct(ca.table, ca.column), this.nDistinct(cb.table, cb.column));
    const col = ca ?? cb;
    if (!col) return DEFAULT_EQ_SELECTIVITY;
    const other = ca ? b : a;
    const v = this.constant(other);
    const st = this.columnStats(col.table, col.column);
    if (v !== undefined && v !== null && st?.histogram && st.histogram.length > 2) {
      const h = st.histogram, n = h.length - 1;
      // a value outside [min, max] matches nothing
      if (compareValues(v, normalize(h[0]!)) < 0 || compareValues(v, normalize(h[n]!)) > 0) return 0.001 / Math.max(1, this.tableRows(col.table));
      // equi-height buckets: a value filling whole buckets is frequent; inside one bucket assume uniform spread over its width
      let sel = 0;
      for (let i = 0; i < n; i++) {
        const lo = normalize(h[i]!), hi = normalize(h[i + 1]!);
        if (compareValues(v, lo) < 0 || compareValues(v, hi) > 0) continue;
        if (compareValues(lo, hi) === 0) { sel += 1 / n; continue; }
        const width = (typeof lo === "bigint" || typeof lo === "number") && (typeof hi === "bigint" || typeof hi === "number") ? Math.max(2, Number(hi) - Number(lo) + 1) : 4;
        sel += 1 / (n * width);
      }
      return clamp(Math.max(sel, 1 / Math.max(1, this.tableRows(col.table))) * (1 - st.nullFrac));
    }
    return 1 / this.nDistinct(col.table, col.column);
  }

  private range(a: BoundExpr, b: BoundExpr, op: string, rels: RelTables): number {
    let col = this.column(a, rels), other = b, o = op;
    if (!col) {
      col = this.column(b, rels); other = a;
      o = op === "<" ? ">" : op === ">" ? "<" : op === "<=" ? ">=" : "<=";
    }
    if (!col) return DEFAULT_RANGE_SELECTIVITY;
    const v = this.constant(other);
    if (v === undefined || v === null) return DEFAULT_RANGE_SELECTIVITY;
    const st = this.columnStats(col.table, col.column);
    if (!st) return DEFAULT_RANGE_SELECTIVITY;
    const below = fractionBelow(st, v);
    if (below === undefined) return DEFAULT_RANGE_SELECTIVITY;
    const nonNull = 1 - st.nullFrac;
    return clamp((o === "<" || o === "<=" ? below : 1 - below) * nonNull);
  }
}

/** Fraction of non-null values strictly below `v` according to the histogram (or min/max interpolation). */
export function fractionBelow(st: ColumnStats, v: Value): number | undefined {
  const h = st.histogram;
  if (h && h.length >= 2) {
    const n = h.length - 1;
    if (compareValues(v, normalize(h[0]!)) <= 0) return 0;
    if (compareValues(v, normalize(h[n]!)) > 0) return 1;
    for (let i = 0; i < n; i++) {
      const lo = normalize(h[i]!), hi = normalize(h[i + 1]!);
      if (compareValues(v, hi) <= 0) {
        const f = interpolate(lo, hi, v);
        return clamp((i + f) / n);
      }
    }
    return 1;
  }
  if (st.min !== null && st.max !== null) {
    const lo = normalize(st.min), hi = normalize(st.max);
    if (compareValues(v, lo) <= 0) return 0;
    if (compareValues(v, hi) > 0) return 1;
    return clamp(interpolate(lo, hi, v));
  }
  return undefined;
}

function interpolate(lo: Value, hi: Value, v: Value): number {
  const num = (x: Value): number | undefined => (typeof x === "bigint" ? Number(x) : typeof x === "number" ? x : undefined);
  const a = num(lo), b = num(hi), c = num(v);
  if (a === undefined || b === undefined || c === undefined || b <= a) return 0.5;
  return Math.min(1, Math.max(0, (c - a) / (b - a)));
}

function clamp(x: number): number {
  if (!Number.isFinite(x)) return DEFAULT_RANGE_SELECTIVITY;
  return Math.min(1, Math.max(0, x));
}

/** True when the expression references only relations outside `rels` (i.e. is constant for a scan of them). */
export function isConstantForScan(e: BoundExpr, rel: number): boolean {
  return directRefs(e).every((r) => r.depth > 0 || r.relation !== rel) && !hasDepth0Refs(e);
}

function hasDepth0Refs(e: BoundExpr): boolean {
  return directRefs(e).some((r) => r.depth === 0);
}
