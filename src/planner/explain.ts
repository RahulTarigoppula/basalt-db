/**
 * EXPLAIN output: the JSON-serialisable `PlanNode` tree the web UI draws, and the indented text rendering
 * (PostgreSQL style). `EXPLAIN ANALYZE` adds `actualRows`, `loops` and `ms` per node (supplied by the executor).
 */
import type { ResultColumn } from "../core/types.js";
import { exprToSql } from "../sql/print.js";
import type { BoundExpr } from "../sql/bound.js";
import type { SortKey } from "./logical.js";
import { childrenOf, type PhysicalNode } from "./physical.js";

export interface PlanNode {
  op: string;
  estRows: number;
  estCost: number;
  props: Record<string, string | number | boolean | null>;
  children: PlanNode[];
  /** EXPLAIN ANALYZE only. */
  actualRows?: number;
  loops?: number;
  ms?: number;
}

export interface NodeStats { rows: number; loops: number; ms: number }

const OP_NAMES: Record<PhysicalNode["kind"], string> = {
  seqscan: "SeqScan", rowidlookup: "RowidLookup", indexscan: "IndexScan", subqueryscan: "SubqueryScan", ctescan: "CteScan", working: "WorkingTable",
  filter: "Filter", project: "Project", nestedloop: "NestedLoopJoin", hashjoin: "HashJoin", mergejoin: "MergeJoin", hashaggregate: "HashAggregate",
  sortedaggregate: "SortedAggregate", window: "Window", sort: "Sort", topk: "TopK", limit: "Limit", distinct: "Distinct", setop: "SetOp", values: "Values",
  materialize: "Materialize", recursivecte: "RecursiveCte", truncate: "Project", insert: "Insert", update: "Update", delete: "Delete", createtable: "CreateTable",
  createindex: "CreateIndex", createview: "CreateView", drop: "Drop", alter: "AlterTable", analyze: "Analyze", vacuum: "Vacuum", pragma: "Pragma", explain: "Explain",
};

function sortKeysText(keys: SortKey[], input?: PhysicalNode): string {
  const text = (e: BoundExpr): string => {
    if (e.kind === "resultColumn" && input) { const slot = input.layout.slots[input.layout.find(`o:${e.index}`)]; if (slot) return slot.name; }
    return exprToSql(e);
  };
  return keys.map((k) => `${text(k.expr)}${k.desc ? " DESC" : ""}${k.nullsFirst !== !k.desc ? (k.nullsFirst ? " NULLS FIRST" : " NULLS LAST") : ""}`).join(", ");
}

function list(exprs: BoundExpr[]): string { return exprs.map(exprToSql).join(", "); }

function round(n: number): number { return Math.round(n * 100) / 100; }

/** Converts a physical plan to the public JSON tree; `stats` supplies EXPLAIN ANALYZE counters per node. */
export function toPlanNode(n: PhysicalNode, stats?: (node: PhysicalNode) => NodeStats | undefined): PlanNode {
  const props: PlanNode["props"] = {};
  switch (n.kind) {
    case "seqscan":
      props["table"] = n.table.schema.name;
      if (n.alias !== n.table.schema.name) props["alias"] = n.alias;
      if (n.direction < 0) props["direction"] = "backward";
      if (n.lo) props["rowidFrom"] = `${n.lo.inclusive ? ">=" : ">"} ${exprToSql(n.lo.expr)}`;
      if (n.hi) props["rowidTo"] = `${n.hi.inclusive ? "<=" : "<"} ${exprToSql(n.hi.expr)}`;
      if (n.filter) props["filter"] = exprToSql(n.filter);
      break;
    case "rowidlookup":
      props["table"] = n.table.schema.name;
      if (n.alias !== n.table.schema.name) props["alias"] = n.alias;
      props["rowid"] = exprToSql(n.rowid);
      if (n.filter) props["filter"] = exprToSql(n.filter);
      break;
    case "indexscan":
      props["table"] = n.table.schema.name;
      if (n.alias !== n.table.schema.name) props["alias"] = n.alias;
      props["index"] = n.index.schema.name;
      props["indexColumns"] = n.index.schema.columns.map((c) => n.table.schema.columns[c]!.name).join(", ");
      if (n.eq.length) props["eq"] = list(n.eq);
      if (n.lo) props["from"] = `${n.lo.inclusive ? ">=" : ">"} ${exprToSql(n.lo.expr)}`;
      if (n.hi) props["to"] = `${n.hi.inclusive ? "<=" : "<"} ${exprToSql(n.hi.expr)}`;
      props["covering"] = n.covering;
      if (n.direction < 0) props["direction"] = "backward";
      if (n.filter) props["filter"] = exprToSql(n.filter);
      break;
    case "subqueryscan": props["alias"] = n.alias; break;
    case "ctescan": props["cte"] = n.cte.name; if (n.alias !== n.cte.name) props["alias"] = n.alias; break;
    case "working": props["cte"] = n.cte.name; break;
    case "filter": props["filter"] = exprToSql(n.predicate); break;
    case "project": props["columns"] = n.exprs.map((e, i) => (n.names[i] && n.names[i] !== exprToSql(e) ? `${exprToSql(e)} AS ${n.names[i]}` : exprToSql(e))).join(", "); break;
    case "nestedloop": props["joinType"] = n.type; if (n.condition) props["condition"] = exprToSql(n.condition); break;
    case "hashjoin":
      props["joinType"] = n.type;
      props["keys"] = n.leftKeys.map((l, i) => `${exprToSql(l)} = ${exprToSql(n.rightKeys[i]!)}`).join(" AND ");
      if (n.residual) props["residual"] = exprToSql(n.residual);
      break;
    case "mergejoin":
      props["joinType"] = n.type;
      props["keys"] = n.leftKeys.map((l, i) => `${exprToSql(l)} = ${exprToSql(n.rightKeys[i]!)}`).join(" AND ");
      if (n.residual) props["residual"] = exprToSql(n.residual);
      break;
    case "hashaggregate": case "sortedaggregate":
      if (n.groupBy.length) props["groupBy"] = list(n.groupBy);
      props["aggregates"] = n.aggs.map(exprToSql).join(", ");
      break;
    case "window": props["windows"] = n.windows.map(exprToSql).join(", "); break;
    case "sort": props["keys"] = sortKeysText(n.keys, n.input); break;
    case "topk": props["keys"] = sortKeysText(n.keys, n.input); props["limit"] = exprToSql(n.limit); if (n.offset) props["offset"] = exprToSql(n.offset); break;
    case "limit": if (n.limit) props["limit"] = exprToSql(n.limit); if (n.offset) props["offset"] = exprToSql(n.offset); break;
    case "distinct": props["keyColumns"] = n.keyCount; break;
    case "setop": props["op"] = n.op; break;
    case "values": props["rows"] = n.rows.length; break;
    case "recursivecte": props["cte"] = n.cte.name; props["union"] = n.unionAll ? "ALL" : "DISTINCT"; break;
    case "truncate": props["columns"] = n.keep; break;
    case "insert": props["table"] = n.table.schema.name; if (n.stmt.or) props["onConflict"] = n.stmt.or; if (n.stmt.upsert) props["upsert"] = n.stmt.upsert.set ? "DO UPDATE" : "DO NOTHING"; break;
    case "update": props["table"] = n.table.schema.name; props["set"] = n.stmt.assignments.map((a) => `${n.table.schema.columns[a.column]!.name} = ${exprToSql(a.expr)}`).join(", "); break;
    case "delete": props["table"] = n.table.schema.name; break;
    case "createtable": props["table"] = n.stmt.table.name; break;
    case "createindex": props["index"] = n.stmt.index.name; props["table"] = n.stmt.index.table; break;
    case "createview": props["view"] = n.stmt.name; break;
    case "drop": props["object"] = n.stmt.object; props["name"] = n.stmt.name; break;
    case "alter": props["table"] = n.stmt.table.name; props["action"] = n.stmt.action; break;
    case "analyze": if (n.stmt.target) props["target"] = n.stmt.target; break;
    case "pragma": props["pragma"] = n.stmt.name; break;
    case "vacuum": case "explain": case "materialize": break;
  }
  const node: PlanNode = { op: OP_NAMES[n.kind], estRows: round(n.estRows), estCost: round(n.estCost), props, children: childrenOf(n).map((ch) => toPlanNode(ch, stats)) };
  const s = stats?.(n);
  if (s) { node.actualRows = s.rows; node.loops = s.loops; node.ms = round(s.ms); }
  return node;
}

/** Indented text rendering, one line per node. */
export function formatPlan(node: PlanNode): string[] {
  const lines: string[] = [];
  const rec = (n: PlanNode, depth: number): void => {
    const indent = depth === 0 ? "" : `${"  ".repeat(depth - 1)}-> `;
    let head = `${n.op}`;
    const detail: string[] = [];
    for (const [k, v] of Object.entries(n.props)) {
      if (k === "filter" || k === "condition" || k === "residual") continue;
      if (typeof v === "boolean") { if (v) detail.push(k); continue; }
      detail.push(`${k}=${v}`);
    }
    if (detail.length) head += ` (${detail.join(", ")})`;
    head += `  [rows=${n.estRows} cost=${n.estCost}`;
    if (n.actualRows !== undefined) head += ` actual=${n.actualRows} loops=${n.loops} ms=${n.ms}`;
    head += "]";
    lines.push(indent + head);
    for (const k of ["filter", "condition", "residual"] as const) {
      const v = n.props[k];
      if (v !== undefined) lines.push(`${"  ".repeat(depth)}   ${k === "filter" ? "Filter" : k === "condition" ? "Join Cond" : "Residual"}: ${v}`);
    }
    for (const ch of n.children) rec(ch, depth + 1);
  };
  rec(node, 0);
  return lines;
}

export const EXPLAIN_COLUMNS: ResultColumn[] = [{ name: "QUERY PLAN", type: "TEXT" }];
