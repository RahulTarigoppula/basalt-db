/**
 * Row layouts and expression re-layout.
 *
 * Every operator produces ONE flat `Row`; a `Layout` says what each position holds. Slots are addressed by keys:
 *   `c0:<relation>:<column>`  a base column of scope relation `relation` (relation index within its query scope)
 *   `r0:<relation>`           the rowid of a table relation
 *   `a:<i>`                   the i-th aggregate of the core (`BoundSelectCore.aggregates[i]`)
 *   `w:<i>`                   the i-th window call
 *   `e:<exprKey>`             an arbitrary expression computed below (GROUP BY terms, projected expressions)
 *   `o:<i>`                   the i-th output column of a projection / compound select
 *
 * Expressions are evaluated against `rows = [currentRow, ...outerRows]` (see `sql/bound.ts`): `rows[0]` is the flat
 * row of the operator evaluating the expression and `rows[d]` the flat row of the enclosing query scope `d` levels up.
 * `rewriteExpr(expr, stack)` maps every column/rowid/aggregate/window/resultColumn node onto `{rel: depth, column: slot}`
 * references so the generic expression compiler can run it; `stack[d]` is the layout of `rows[d]`.
 */
import { BasaltError } from "../core/errors.js";
import type { BoundColumnRef, BoundExpr, BoundSubquery, ExprType, RelationColumn } from "../sql/bound.js";
import { valueToSql } from "../sql/print.js";

export interface Slot {
  keys: string[];
  name: string;
  type: ExprType;
}

export class Layout {
  private readonly map = new Map<string, number>();
  readonly hasExprSlots: boolean;

  constructor(readonly slots: readonly Slot[]) {
    let e = false;
    slots.forEach((s, i) => { for (const k of s.keys) { if (!this.map.has(k)) this.map.set(k, i); if (k.startsWith("e:")) e = true; } });
    this.hasExprSlots = e;
  }

  get size(): number { return this.slots.length; }

  find(key: string): number { return this.map.get(key) ?? -1; }
  has(key: string): boolean { return this.map.has(key); }

  concat(other: Layout): Layout { return new Layout([...this.slots, ...other.slots]); }

  /** Layout of a base relation: its columns, optionally followed by the rowid. */
  static relation(rel: number, columns: readonly RelationColumn[], withRowid: boolean): Layout {
    const slots: Slot[] = columns.map((c, i) => ({ keys: [columnKey(rel, i)], name: c.name, type: c.type }));
    if (withRowid) slots.push({ keys: [rowidKey(rel)], name: "rowid", type: "INTEGER" });
    return new Layout(slots);
  }

  static empty(): Layout { return new Layout([]); }
}

export const columnKey = (rel: number, column: number): string => `c0:${rel}:${column}`;
export const rowidKey = (rel: number): string => `r0:${rel}`;
export const aggKey = (i: number): string => `a:${i}`;
export const winKey = (i: number): string => `w:${i}`;
export const outKey = (i: number): string => `o:${i}`;
export const exprSlotKey = (e: BoundExpr): string => `e:${exprKey(e)}`;

// ----- structural keys -----

const subqueryIds = new WeakMap<BoundSubquery, number>();
let nextSubqueryId = 1;
function subqueryId(s: BoundSubquery): number {
  let id = subqueryIds.get(s);
  if (id === undefined) { id = nextSubqueryId++; subqueryIds.set(s, id); }
  return id;
}

/**
 * Structural key of an expression (ignores source locations and names). `depthShift` is added to the depth of every
 * column reference so an expression seen from an inner scope can be matched against an outer layout.
 */
export function exprKey(e: BoundExpr, depthShift = 0): string {
  const k = (x: BoundExpr | undefined): string => (x ? exprKey(x, depthShift) : "");
  switch (e.kind) {
    case "literal": return `L${e.dataType}:${valueToSql(e.value)}`;
    case "column": return `C${e.depth + depthShift}:${e.relation}:${e.column}`;
    case "rowid": return `R${e.depth + depthShift}:${e.relation}`;
    case "param": return `P${e.index}`;
    case "unary": return `U${e.op}(${k(e.operand)})`;
    case "binary": return `B${e.op}(${k(e.left)},${k(e.right)})`;
    case "like": return `K${e.op}${e.not ? "!" : ""}(${k(e.left)},${k(e.right)},${k(e.escape)})`;
    case "between": return `W${e.not ? "!" : ""}(${k(e.expr)},${k(e.low)},${k(e.high)})`;
    case "in": return `I${e.not ? "!" : ""}(${k(e.expr)};${e.list ? e.list.map(k).join(",") : `#${subqueryId(e.subquery!)}`})`;
    case "isnull": return `N${e.not ? "!" : ""}(${k(e.expr)})`;
    case "case": return `S(${k(e.operand)};${e.whens.map((w) => `${k(w.when)}>${k(w.then)}`).join(",")};${k(e.else)})`;
    case "cast": return `T${e.target}(${k(e.expr)})`;
    case "function": return `F${e.name.toLowerCase()}(${e.args.map(k).join(",")})`;
    case "aggregate": return `A${e.index}`;
    case "window": return `V${e.index}`;
    case "exists": return `E${e.not ? "!" : ""}#${subqueryId(e.subquery)}`;
    case "subquery": return `Q#${subqueryId(e.subquery)}`;
    case "resultColumn": return `O${e.index}`;
  }
}

/** Column/rowid references at scope depth 0 of `expr` (not descending into subqueries). */
export function directRefs(expr: BoundExpr): (BoundColumnRef | Extract<BoundExpr, { kind: "rowid" }>)[] {
  const out: (BoundColumnRef | Extract<BoundExpr, { kind: "rowid" }>)[] = [];
  const walk = (e: BoundExpr | undefined): void => {
    if (!e) return;
    switch (e.kind) {
      case "column": case "rowid": out.push(e); return;
      case "unary": walk(e.operand); return;
      case "binary": walk(e.left); walk(e.right); return;
      case "like": walk(e.left); walk(e.right); walk(e.escape); return;
      case "between": walk(e.expr); walk(e.low); walk(e.high); return;
      case "in": walk(e.expr); e.list?.forEach(walk); return;
      case "isnull": walk(e.expr); return;
      case "case": walk(e.operand); for (const w of e.whens) { walk(w.when); walk(w.then); } walk(e.else); return;
      case "cast": walk(e.expr); return;
      case "function": e.args.forEach(walk); return;
      case "aggregate": e.args.forEach(walk); walk(e.filter); return;
      case "window":
        e.args.forEach(walk); walk(e.filter); e.spec.partitionBy.forEach(walk); for (const o of e.spec.orderBy) walk(o.expr);
        if (e.spec.frame) for (const b of [e.spec.frame.start, e.spec.frame.end]) if (b.kind === "preceding" || b.kind === "following") walk(b.offset);
        return;
      default: return;
    }
  };
  walk(expr);
  return out;
}

/** Relation indexes (depth 0) referenced by an expression, including references made from nested subqueries. */
export function referencedRelations(expr: BoundExpr): Set<number> {
  const out = new Set<number>();
  for (const r of allRefsAtDepth(expr, 0)) out.add(r.relation);
  return out;
}

/**
 * Every column/rowid reference that resolves to the scope `targetDepth` levels above the expression's own scope,
 * including references made from inside nested subqueries (whose depths are adjusted).
 */
export function allRefsAtDepth(expr: BoundExpr, targetDepth: number): { kind: "column" | "rowid"; relation: number; column: number }[] {
  const out: { kind: "column" | "rowid"; relation: number; column: number }[] = [];
  const visitSelect = (s: import("../sql/bound.js").BoundSelect, depth: number): void => {
    for (const c of s.ctes) visitSelect(c.select, depth);
    visitBody(s.body, depth);
    for (const o of s.orderBy) walk(o.expr, depth);
    if (s.limit) walk(s.limit, depth);
    if (s.offset) walk(s.offset, depth);
  };
  const visitBody = (b: import("../sql/bound.js").BoundSelectBody, depth: number): void => {
    switch (b.kind) {
      case "compound": visitBody(b.left, depth); visitBody(b.right, depth); return;
      case "values": for (const r of b.rows) for (const e of r) walk(e, depth); return;
      case "core": {
        for (const r of b.relations) if (r.kind === "subquery" || r.kind === "view") visitSelect(r.select, depth + 1);
        const visitFrom = (f: import("../sql/bound.js").BoundFrom | undefined): void => { if (f && f.kind === "join") { visitFrom(f.left); visitFrom(f.right); if (f.condition) walk(f.condition, depth); } };
        visitFrom(b.from);
        if (b.where) walk(b.where, depth);
        for (const g of b.groupBy) walk(g, depth);
        if (b.having) walk(b.having, depth);
        for (const p of b.projections) walk(p.expr, depth);
        return;
      }
    }
  };
  const walk = (e: BoundExpr | undefined, depth: number): void => {
    if (!e) return;
    switch (e.kind) {
      case "column": if (e.depth === depth) out.push({ kind: "column", relation: e.relation, column: e.column }); return;
      case "rowid": if (e.depth === depth) out.push({ kind: "rowid", relation: e.relation, column: -1 }); return;
      case "unary": walk(e.operand, depth); return;
      case "binary": walk(e.left, depth); walk(e.right, depth); return;
      case "like": walk(e.left, depth); walk(e.right, depth); walk(e.escape, depth); return;
      case "between": walk(e.expr, depth); walk(e.low, depth); walk(e.high, depth); return;
      case "in": walk(e.expr, depth); e.list?.forEach((x) => walk(x, depth)); if (e.subquery) visitSelect(e.subquery.select, depth + 1); return;
      case "isnull": walk(e.expr, depth); return;
      case "case": walk(e.operand, depth); for (const w of e.whens) { walk(w.when, depth); walk(w.then, depth); } walk(e.else, depth); return;
      case "cast": walk(e.expr, depth); return;
      case "function": e.args.forEach((a) => walk(a, depth)); return;
      case "aggregate": e.args.forEach((a) => walk(a, depth)); walk(e.filter, depth); return;
      case "window":
        e.args.forEach((a) => walk(a, depth)); walk(e.filter, depth); e.spec.partitionBy.forEach((p) => walk(p, depth));
        for (const o of e.spec.orderBy) walk(o.expr, depth);
        if (e.spec.frame) for (const b of [e.spec.frame.start, e.spec.frame.end]) if (b.kind === "preceding" || b.kind === "following") walk(b.offset, depth);
        return;
      case "exists": case "subquery": visitSelect(e.subquery.select, depth + 1); return;
      default: return;
    }
  };
  walk(expr, targetDepth);
  return out;
}

/** True when the expression (not descending into subqueries) contains an aggregate / window / subquery node. */
export function containsKind(expr: BoundExpr, kinds: Set<BoundExpr["kind"]>): boolean {
  let found = false;
  const walk = (e: BoundExpr | undefined): void => {
    if (!e || found) return;
    if (kinds.has(e.kind)) { found = true; return; }
    switch (e.kind) {
      case "unary": walk(e.operand); return;
      case "binary": walk(e.left); walk(e.right); return;
      case "like": walk(e.left); walk(e.right); walk(e.escape); return;
      case "between": walk(e.expr); walk(e.low); walk(e.high); return;
      case "in": walk(e.expr); e.list?.forEach(walk); return;
      case "isnull": walk(e.expr); return;
      case "case": walk(e.operand); for (const w of e.whens) { walk(w.when); walk(w.then); } walk(e.else); return;
      case "cast": walk(e.expr); return;
      case "function": e.args.forEach(walk); return;
      case "aggregate": e.args.forEach(walk); walk(e.filter); return;
      case "window": e.args.forEach(walk); walk(e.filter); e.spec.partitionBy.forEach(walk); for (const o of e.spec.orderBy) walk(o.expr); return;
      default: return;
    }
  };
  walk(expr);
  return found;
}

/** Minimum scope depth among the direct column references of an expression (Infinity when it has none). */
function minDepth(e: BoundExpr): number {
  let m = Infinity;
  for (const r of directRefs(e)) if (r.depth < m) m = r.depth;
  return m;
}

// ----- re-layout -----

/** A subquery found while rewriting an expression, with the layout stack in effect at its position. */
export interface SubqueryUse { subquery: BoundSubquery; stack: Layout[] }

function ref(depth: number, column: number, src: BoundExpr, slot: Slot): BoundColumnRef {
  return { kind: "column", depth, relation: -1, rel: depth, column, name: slot.name, table: undefined, dataType: src.dataType, loc: src.loc };
}

/**
 * Rewrites `expr` so every reference points at a slot of `stack[depth]` (as `{rel: depth, column: slot}`). Subqueries are
 * left in place and reported through `uses` (the executor plans them with the given stack). Throws when a reference
 * cannot be satisfied by the stack - that is a planner bug (or an unsupported lateral reference).
 */
export function rewriteExpr(expr: BoundExpr, stack: readonly Layout[], uses?: SubqueryUse[]): BoundExpr {
  const r = (e: BoundExpr): BoundExpr => {
    // whole-expression slot match (GROUP BY terms, projected expressions)
    if (e.kind !== "column" && e.kind !== "rowid" && e.kind !== "literal" && e.kind !== "param") {
      const d = minDepth(e);
      const dd = d === Infinity ? 0 : d;
      const L = stack[dd];
      if (L && L.hasExprSlots && (d !== Infinity || e.kind === "aggregate" || e.kind === "window")) {
        const i = L.find(`e:${exprKey(e, -dd)}`);
        if (i >= 0) return ref(dd, i, e, L.slots[i]!);
      }
    }
    switch (e.kind) {
      case "column": {
        const L = stack[e.depth];
        const i = L ? L.find(columnKey(e.relation, e.column)) : -1;
        if (i < 0) throw new BasaltError(`internal: column ${e.table !== undefined ? e.table + "." : ""}${e.name} (depth ${e.depth}, relation ${e.relation}) is not available at this point of the plan`);
        return ref(e.depth, i, e, L!.slots[i]!);
      }
      case "rowid": {
        const L = stack[e.depth];
        const i = L ? L.find(rowidKey(e.relation)) : -1;
        if (i < 0) throw new BasaltError(`internal: rowid of relation ${e.relation} (depth ${e.depth}) is not available at this point of the plan`);
        return ref(e.depth, i, e, L!.slots[i]!);
      }
      case "aggregate": {
        const L = stack[0];
        const i = L ? L.find(aggKey(e.index)) : -1;
        if (i < 0) throw new BasaltError(`internal: aggregate ${e.name}() is not available at this point of the plan`);
        return ref(0, i, e, L!.slots[i]!);
      }
      case "window": {
        const L = stack[0];
        const i = L ? L.find(winKey(e.index)) : -1;
        if (i < 0) throw new BasaltError(`internal: window function ${e.name}() is not available at this point of the plan`);
        return ref(0, i, e, L!.slots[i]!);
      }
      case "resultColumn": {
        const L = stack[0];
        const i = L ? L.find(outKey(e.index)) : -1;
        if (i < 0) throw new BasaltError(`internal: result column ${e.index + 1} is not available at this point of the plan`);
        return ref(0, i, e, L!.slots[i]!);
      }
      case "literal": case "param": return e;
      case "unary": return { ...e, operand: r(e.operand) };
      case "binary": return { ...e, left: r(e.left), right: r(e.right) };
      case "like": return { ...e, left: r(e.left), right: r(e.right), escape: e.escape ? r(e.escape) : undefined };
      case "between": return { ...e, expr: r(e.expr), low: r(e.low), high: r(e.high) };
      case "in": {
        if (e.subquery) uses?.push({ subquery: e.subquery, stack: [...stack] });
        return { ...e, expr: r(e.expr), list: e.list?.map(r) };
      }
      case "isnull": return { ...e, expr: r(e.expr) };
      case "case": return { ...e, operand: e.operand ? r(e.operand) : undefined, whens: e.whens.map((w) => ({ when: r(w.when), then: r(w.then) })), else: e.else ? r(e.else) : undefined };
      case "cast": return { ...e, expr: r(e.expr) };
      case "function": return { ...e, args: e.args.map(r) };
      case "exists": case "subquery": uses?.push({ subquery: e.subquery, stack: [...stack] }); return e;
    }
  };
  return r(expr);
}

/** Shifts the scope depth of every column reference in an expression (used when an expression moves across a scope boundary). */
export function shiftDepth(expr: BoundExpr, by: number): BoundExpr {
  const m = (e: BoundExpr | undefined): BoundExpr | undefined => (e ? shiftDepth(e, by) : undefined);
  const r = (e: BoundExpr): BoundExpr => shiftDepth(e, by);
  switch (expr.kind) {
    case "column": return { ...expr, depth: expr.depth + by, rel: expr.rel + by };
    case "rowid": return { ...expr, depth: expr.depth + by, rel: expr.rel + by };
    case "unary": return { ...expr, operand: r(expr.operand) };
    case "binary": return { ...expr, left: r(expr.left), right: r(expr.right) };
    case "like": return { ...expr, left: r(expr.left), right: r(expr.right), escape: m(expr.escape) };
    case "between": return { ...expr, expr: r(expr.expr), low: r(expr.low), high: r(expr.high) };
    case "in": return { ...expr, expr: r(expr.expr), list: expr.list?.map(r) };
    case "isnull": return { ...expr, expr: r(expr.expr) };
    case "case": return { ...expr, operand: m(expr.operand), whens: expr.whens.map((w) => ({ when: r(w.when), then: r(w.then) })), else: m(expr.else) };
    case "cast": return { ...expr, expr: r(expr.expr) };
    case "function": return { ...expr, args: expr.args.map(r) };
    case "aggregate": return { ...expr, args: expr.args.map(r), filter: m(expr.filter) };
    default: return expr;
  }
}
