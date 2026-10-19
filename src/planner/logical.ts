/**
 * Logical plan nodes. Every node carries the `Layout` of the rows it produces (see `layout.ts`) and the set of query
 * relations (`rels`) whose columns are available in it, which predicate pushdown uses to decide where a conjunct can go.
 * Expressions inside logical nodes are *bound* expressions (scope-relative references); they are re-laid out only when
 * the executor compiles them.
 */
import type { TableInfo } from "../catalog/catalog.js";
import type { BoundAggregate, BoundCte, BoundExpr, BoundSelect, BoundWindow, RelationColumn } from "../sql/bound.js";
import type { CompoundOp } from "../sql/ast.js";
import { Layout, aggKey, columnKey, outKey, rowidKey, winKey, type Slot } from "./layout.js";

export type LogicalJoinType = "INNER" | "LEFT" | "FULL" | "CROSS" | "SEMI" | "ANTI";

export interface SortKey { expr: BoundExpr; desc: boolean; nullsFirst: boolean }

interface Base { layout: Layout; rels: Set<number> }

export interface LScan extends Base { kind: "scan"; table: TableInfo; alias: string; rel: number; indexedBy?: string | null; requiredColumns?: Set<number> }
/** Derived table / view / inline CTE body. */
export interface LSubquery extends Base { kind: "subquery"; rel: number; select: BoundSelect; alias: string; columns: RelationColumn[] }
/** Reference to a (materialised) CTE. */
export interface LCteScan extends Base { kind: "cteScan"; rel: number; cte: BoundCte; alias: string }
/** The self-reference inside a recursive CTE's recursive term. */
export interface LWorkingTable extends Base { kind: "working"; rel: number; cte: BoundCte; alias: string }
export interface LFilter extends Base { kind: "filter"; input: LNode; predicate: BoundExpr }
export interface LJoin extends Base { kind: "join"; type: LogicalJoinType; left: LNode; right: LNode; condition?: BoundExpr }
export interface LAggregate extends Base {
  kind: "aggregate"; input: LNode; groupBy: BoundExpr[]; aggs: BoundAggregate[];
  /** Bare columns of the input carried through (SQLite leniency): value of an arbitrary row of the group. */
  passthrough: { relation: number; column: number; rowid: boolean }[];
}
export interface LWindow extends Base { kind: "window"; input: LNode; windows: BoundWindow[] }
export interface LProject extends Base { kind: "project"; input: LNode; exprs: BoundExpr[]; names: string[] }
/** DISTINCT over the first `keyCount` columns (extra ORDER BY columns ride along). */
export interface LDistinct extends Base { kind: "distinct"; input: LNode; keyCount: number }
export interface LSort extends Base { kind: "sort"; input: LNode; keys: SortKey[] }
export interface LLimit extends Base { kind: "limit"; input: LNode; limit?: BoundExpr; offset?: BoundExpr }
export interface LSetOp extends Base { kind: "setop"; op: CompoundOp; left: LNode; right: LNode }
export interface LValues extends Base { kind: "values"; rows: BoundExpr[][]; columns: RelationColumn[] }
/** Produces the first `keep` columns of its input (strips ORDER BY helper columns). */
export interface LTruncate extends Base { kind: "truncate"; input: LNode; keep: number }

export type LNode = LScan | LSubquery | LCteScan | LWorkingTable | LFilter | LJoin | LAggregate | LWindow | LProject | LDistinct | LSort | LLimit | LSetOp | LValues | LTruncate;

export function inputsOf(n: LNode): LNode[] {
  switch (n.kind) {
    case "scan": case "subquery": case "cteScan": case "working": case "values": return [];
    case "join": case "setop": return [n.left, n.right];
    default: return [n.input];
  }
}

export function withInputs(n: LNode, inputs: LNode[]): LNode {
  switch (n.kind) {
    case "scan": case "subquery": case "cteScan": case "working": case "values": return n;
    case "join": return { ...n, left: inputs[0]!, right: inputs[1]! };
    case "setop": return { ...n, left: inputs[0]!, right: inputs[1]! };
    default: return { ...n, input: inputs[0]! };
  }
}

// ----- constructors -----

export function scan(table: TableInfo, alias: string, rel: number, indexedBy?: string | null): LScan {
  const columns: RelationColumn[] = table.schema.columns.map((c) => ({ name: c.name, type: c.type, hidden: false }));
  return { kind: "scan", table, alias, rel, indexedBy, layout: Layout.relation(rel, columns, true), rels: new Set([rel]) };
}

export function subqueryScan(rel: number, select: BoundSelect, alias: string, columns: RelationColumn[]): LSubquery {
  return { kind: "subquery", rel, select, alias, columns, layout: Layout.relation(rel, columns, false), rels: new Set([rel]) };
}

export function cteScan(rel: number, cte: BoundCte, alias: string): LCteScan {
  return { kind: "cteScan", rel, cte, alias, layout: Layout.relation(rel, cte.columns, false), rels: new Set([rel]) };
}

export function workingTable(rel: number, cte: BoundCte, alias: string): LWorkingTable {
  return { kind: "working", rel, cte, alias, layout: Layout.relation(rel, cte.columns, false), rels: new Set([rel]) };
}

export function filter(input: LNode, predicate: BoundExpr): LFilter {
  return { kind: "filter", input, predicate, layout: input.layout, rels: input.rels };
}

export function join(type: LogicalJoinType, left: LNode, right: LNode, condition?: BoundExpr): LJoin {
  const rels = new Set<number>([...left.rels, ...right.rels]);
  const layout = type === "SEMI" || type === "ANTI" ? left.layout : left.layout.concat(right.layout);
  return { kind: "join", type, left, right, condition, layout, rels: type === "SEMI" || type === "ANTI" ? left.rels : rels };
}

export function aggregate(input: LNode, groupBy: BoundExpr[], aggs: BoundAggregate[], passthrough: LAggregate["passthrough"]): LAggregate {
  const slots: Slot[] = [];
  groupBy.forEach((g) => {
    const keys = [`e:${exprKeyOf(g)}`];
    if (g.kind === "column" && g.depth === 0) keys.push(columnKey(g.relation, g.column));
    if (g.kind === "rowid" && g.depth === 0) keys.push(rowidKey(g.relation));
    slots.push({ keys, name: g.kind === "column" ? g.name : "expr", type: g.dataType });
  });
  aggs.forEach((a, i) => slots.push({ keys: [aggKey(i)], name: a.name, type: a.dataType }));
  for (const p of passthrough) {
    const i = input.layout.find(p.rowid ? rowidKey(p.relation) : columnKey(p.relation, p.column));
    const src = input.layout.slots[i];
    slots.push({ keys: [p.rowid ? rowidKey(p.relation) : columnKey(p.relation, p.column)], name: src?.name ?? "col", type: src?.type ?? "ANY" });
  }
  return { kind: "aggregate", input, groupBy, aggs, passthrough, layout: new Layout(slots), rels: input.rels };
}

export function window(input: LNode, windows: BoundWindow[]): LWindow {
  const slots: Slot[] = [...input.layout.slots];
  windows.forEach((w, i) => slots.push({ keys: [winKey(i)], name: w.name, type: w.dataType }));
  return { kind: "window", input, windows, layout: new Layout(slots), rels: input.rels };
}

export function project(input: LNode, exprs: BoundExpr[], names: string[]): LProject {
  const slots: Slot[] = exprs.map((e, i) => {
    const keys = [outKey(i)];
    if (e.kind === "column" && e.depth === 0) keys.push(columnKey(e.relation, e.column));
    else if (e.kind === "rowid" && e.depth === 0) keys.push(rowidKey(e.relation));
    else if (e.kind !== "literal" && e.kind !== "param") keys.push(`e:${exprKeyOf(e)}`);
    return { keys, name: names[i] ?? `column${i + 1}`, type: e.dataType };
  });
  return { kind: "project", input, exprs, names, layout: new Layout(slots), rels: input.rels };
}

export function distinct(input: LNode, keyCount = input.layout.size): LDistinct {
  return { kind: "distinct", input, keyCount, layout: input.layout, rels: input.rels };
}

export function sort(input: LNode, keys: SortKey[]): LSort {
  return { kind: "sort", input, keys, layout: input.layout, rels: input.rels };
}

export function limit(input: LNode, lim: BoundExpr | undefined, offset: BoundExpr | undefined): LLimit {
  return { kind: "limit", input, limit: lim, offset, layout: input.layout, rels: input.rels };
}

export function setOp(op: CompoundOp, left: LNode, right: LNode, columns: RelationColumn[]): LSetOp {
  const slots: Slot[] = columns.map((c, i) => ({ keys: [outKey(i)], name: c.name, type: c.type }));
  return { kind: "setop", op, left, right, layout: new Layout(slots), rels: new Set() };
}

export function values(rows: BoundExpr[][], columns: RelationColumn[]): LValues {
  const slots: Slot[] = columns.map((c, i) => ({ keys: [outKey(i)], name: c.name, type: c.type }));
  return { kind: "values", rows, columns, layout: new Layout(slots), rels: new Set() };
}

export function truncate(input: LNode, keep: number): LTruncate {
  const slots = input.layout.slots.slice(0, keep).map((s, i) => ({ ...s, keys: [outKey(i), ...s.keys.filter((k) => !k.startsWith("o:"))] }));
  return { kind: "truncate", input, keep, layout: new Layout(slots), rels: input.rels };
}

// local import to avoid a cycle at module-evaluation time
import { exprKey as exprKeyOf } from "./layout.js";
