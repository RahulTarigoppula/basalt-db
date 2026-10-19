/**
 * Physical planning: logical plan -> physical operator tree with cost estimates.
 *
 * Decisions made here:
 * - access paths: SeqScan (optionally bounded on rowid), RowidLookup for `INTEGER PRIMARY KEY = x`, IndexScan for an
 *    equality prefix of an index plus one range column, covering-index detection, order-providing scans (an index or the
 *    rowid order that satisfies a requested ORDER BY, scanned forwards or backwards), partial indexes are not used
 * - join algorithms: HashJoin for equi-conditions (smaller side builds for inner joins), MergeJoin when both inputs
 *    already deliver the key order, NestedLoop otherwise; join order through `join-order.ts`
 * - HashAggregate vs SortedAggregate (input already grouped), Sort elimination when the input order suffices,
 *    TopK for ORDER BY + LIMIT, Materialize for the inner side of nested loops is implicit in the operator
 *
 * The output is a `PhysicalNode` tree; `toPlanNode` (explain.ts) turns it into the JSON-serialisable `PlanNode`.
 */
import type { IndexInfo, TableInfo } from "../catalog/catalog.js";
import { BasaltError } from "../core/errors.js";
import { evaluateConstant, isConstantExpr } from "../exec/expr.js";
import type { CompoundOp } from "../sql/ast.js";
import type {
  BoundAggregate, BoundAlterTable, BoundAnalyze, BoundCreateIndex, BoundCreateTable, BoundCreateView, BoundCte, BoundDelete, BoundDrop,
  BoundExpr, BoundInsert, BoundPragma, BoundSelect, BoundUpdate, BoundWindow,
} from "../sql/bound.js";
import { buildDeleteScan, buildInsertSource, buildSelect, buildUpdateScan, conjoin, conjuncts, type SchemaLookup } from "./build.js";
import * as C from "./cost.js";
import { orderJoins, type JoinItem, type JoinPredicate } from "./join-order.js";
import { Layout, columnKey, directRefs, exprKey, outKey, referencedRelations, rowidKey } from "./layout.js";
import * as L from "./logical.js";
import { optimize } from "./rules.js";
import { Estimator, type RelTables, type StatsSource } from "./stats.js";

// ----- node types -----

/** Output order of a node: layout slot + direction (NULLs first for ascending, as the key encoding sorts them). */
export interface Ordering { slot: number; desc: boolean }

export interface PBase { layout: Layout; estRows: number; estCost: number; ordering: Ordering[] }
export interface Bound { expr: BoundExpr; inclusive: boolean }

export interface PSeqScan extends PBase { kind: "seqscan"; table: TableInfo; alias: string; rel: number; filter?: BoundExpr; lo?: Bound; hi?: Bound; direction: 1 | -1 }
export interface PRowidLookup extends PBase { kind: "rowidlookup"; table: TableInfo; alias: string; rel: number; rowid: BoundExpr; filter?: BoundExpr }
export interface PIndexScan extends PBase {
  kind: "indexscan"; table: TableInfo; alias: string; rel: number; index: IndexInfo;
  /** Equality values for the leading index columns. */
  eq: BoundExpr[]; lo?: Bound; hi?: Bound; covering: boolean; filter?: BoundExpr; direction: 1 | -1;
}
export interface PSubqueryScan extends PBase { kind: "subqueryscan"; rel: number; alias: string; plan: PhysicalNode }
export interface PCteScan extends PBase { kind: "ctescan"; rel: number; alias: string; cte: BoundCte; plan: PhysicalNode }
export interface PWorkingTable extends PBase { kind: "working"; rel: number; alias: string; cte: BoundCte }
export interface PFilter extends PBase { kind: "filter"; input: PhysicalNode; predicate: BoundExpr }
export interface PProject extends PBase { kind: "project"; input: PhysicalNode; exprs: BoundExpr[]; names: string[] }
export interface PNestedLoop extends PBase { kind: "nestedloop"; type: L.LogicalJoinType; left: PhysicalNode; right: PhysicalNode; condition?: BoundExpr }
/** `left` is probed (streamed), `right` is built into the hash table. Output row = [...left, ...right]. */
export interface PHashJoin extends PBase { kind: "hashjoin"; type: L.LogicalJoinType; left: PhysicalNode; right: PhysicalNode; leftKeys: BoundExpr[]; rightKeys: BoundExpr[]; residual?: BoundExpr }
export interface PMergeJoin extends PBase { kind: "mergejoin"; type: "INNER" | "LEFT"; left: PhysicalNode; right: PhysicalNode; leftKeys: BoundExpr[]; rightKeys: BoundExpr[]; residual?: BoundExpr }
export interface PHashAggregate extends PBase { kind: "hashaggregate"; input: PhysicalNode; groupBy: BoundExpr[]; aggs: BoundAggregate[]; passthrough: L.LAggregate["passthrough"] }
export interface PSortedAggregate extends PBase { kind: "sortedaggregate"; input: PhysicalNode; groupBy: BoundExpr[]; aggs: BoundAggregate[]; passthrough: L.LAggregate["passthrough"] }
export interface PWindow extends PBase { kind: "window"; input: PhysicalNode; windows: BoundWindow[] }
export interface PSort extends PBase { kind: "sort"; input: PhysicalNode; keys: L.SortKey[] }
export interface PTopK extends PBase { kind: "topk"; input: PhysicalNode; keys: L.SortKey[]; limit: BoundExpr; offset?: BoundExpr }
export interface PLimit extends PBase { kind: "limit"; input: PhysicalNode; limit?: BoundExpr; offset?: BoundExpr }
export interface PDistinct extends PBase { kind: "distinct"; input: PhysicalNode; keyCount: number }
export interface PSetOp extends PBase { kind: "setop"; op: CompoundOp; left: PhysicalNode; right: PhysicalNode }
export interface PValues extends PBase { kind: "values"; rows: BoundExpr[][] }
export interface PMaterialize extends PBase { kind: "materialize"; input: PhysicalNode }
export interface PRecursiveCte extends PBase { kind: "recursivecte"; cte: BoundCte; anchor: PhysicalNode; recursive: PhysicalNode; unionAll: boolean; orderBy: L.SortKey[]; limit?: BoundExpr; offset?: BoundExpr }
export interface PTruncate extends PBase { kind: "truncate"; input: PhysicalNode; keep: number }

export interface PInsert extends PBase { kind: "insert"; stmt: BoundInsert; table: TableInfo; source?: PhysicalNode }
export interface PUpdate extends PBase { kind: "update"; stmt: BoundUpdate; table: TableInfo; input: PhysicalNode }
export interface PDelete extends PBase { kind: "delete"; stmt: BoundDelete; table: TableInfo; input: PhysicalNode }
export interface PCreateTable extends PBase { kind: "createtable"; stmt: BoundCreateTable; source?: PhysicalNode }
export interface PCreateIndex extends PBase { kind: "createindex"; stmt: BoundCreateIndex }
export interface PCreateView extends PBase { kind: "createview"; stmt: BoundCreateView }
export interface PDrop extends PBase { kind: "drop"; stmt: BoundDrop }
export interface PAlter extends PBase { kind: "alter"; stmt: BoundAlterTable }
export interface PAnalyze extends PBase { kind: "analyze"; stmt: BoundAnalyze }
export interface PVacuum extends PBase { kind: "vacuum" }
export interface PPragma extends PBase { kind: "pragma"; stmt: BoundPragma }
export interface PExplain extends PBase { kind: "explain"; analyze: boolean; plan: PhysicalNode }

export type PhysicalNode =
  | PSeqScan | PRowidLookup | PIndexScan | PSubqueryScan | PCteScan | PWorkingTable | PFilter | PProject | PNestedLoop | PHashJoin | PMergeJoin
  | PHashAggregate | PSortedAggregate | PWindow | PSort | PTopK | PLimit | PDistinct | PSetOp | PValues | PMaterialize | PRecursiveCte | PTruncate
  | PInsert | PUpdate | PDelete | PCreateTable | PCreateIndex | PCreateView | PDrop | PAlter | PAnalyze | PVacuum | PPragma | PExplain;

export function childrenOf(n: PhysicalNode): PhysicalNode[] {
  switch (n.kind) {
    case "seqscan": case "rowidlookup": case "indexscan": case "working": case "values": case "createindex": case "createview": case "drop": case "alter": case "analyze": case "vacuum": case "pragma": return [];
    case "subqueryscan": case "ctescan": return [n.plan];
    case "nestedloop": case "hashjoin": case "mergejoin": case "setop": return [n.left, n.right];
    case "recursivecte": return [n.anchor, n.recursive];
    case "insert": case "createtable": return n.source ? [n.source] : [];
    case "explain": return [n.plan];
    default: return [n.input];
  }
}

// ----- context -----

export interface PlanContext {
  schema: SchemaLookup;
  stats: StatsSource;
  /** Physical plans of CTE bodies, shared by every reference (the executor materialises each once per execution). */
  cteCache?: Map<BoundCte, PhysicalNode>;
}

interface Ctx { schema: SchemaLookup; est: Estimator; cteCache: Map<BoundCte, PhysicalNode> }

/** A wish from the parent: an order to deliver and (when known) how many rows it will consume. */
interface Want { ordering?: WantedKey[]; limit?: number }
interface WantedKey { slotKey: string; desc: boolean; nullsFirst: boolean }

function mkCtx(ctx: PlanContext): Ctx { return { schema: ctx.schema, est: new Estimator(ctx.stats), cteCache: ctx.cteCache ?? new Map() }; }

/** Plans a (sub)select completely: build -> optimise -> physical. */
export function planSelect(select: BoundSelect, ctx: PlanContext): PhysicalNode {
  const c = mkCtx(ctx);
  return planSelectWith(select, c, {});
}

function planSelectWith(select: BoundSelect, c: Ctx, want: Want): PhysicalNode {
  const logical = optimize(buildSelect(select, { schema: c.schema }), c.schema);
  return toPhysical(logical, c, want);
}

// ----- helpers -----

function relTables(n: PhysicalNode, c: Ctx, out: RelTables = new Map()): RelTables {
  if (n.kind === "seqscan" || n.kind === "indexscan" || n.kind === "rowidlookup") out.set(n.rel, { table: n.table, rows: c.est.tableRows(n.table) });
  if (n.kind !== "subqueryscan" && n.kind !== "ctescan") for (const ch of childrenOf(n)) relTables(ch, c, out);
  return out;
}

function constantNumber(e: BoundExpr | undefined): number | undefined {
  if (!e || !isConstantExpr(e)) return undefined;
  try { const v = evaluateConstant(e); return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : undefined; } catch { return undefined; }
}

/** Resolves ORDER BY keys to layout slot keys (only plain references can be matched against an existing order). */
function wantedFrom(keys: L.SortKey[]): WantedKey[] | undefined {
  const out: WantedKey[] = [];
  for (const k of keys) {
    const e = k.expr;
    let slotKey: string;
    if (e.kind === "column" && e.depth === 0) slotKey = columnKey(e.relation, e.column);
    else if (e.kind === "rowid" && e.depth === 0) slotKey = rowidKey(e.relation);
    else if (e.kind === "resultColumn") slotKey = outKey(e.index);
    else return out.length ? out : undefined;
    out.push({ slotKey, desc: k.desc, nullsFirst: k.nullsFirst });
  }
  return out;
}

/** True when `ordering` (over `layout`) satisfies the wanted keys as a prefix. */
function satisfies(ordering: Ordering[], layout: Layout, want: WantedKey[] | undefined): boolean {
  if (!want || want.length === 0) return true;
  if (ordering.length < want.length) return false;
  for (let i = 0; i < want.length; i++) {
    const o = ordering[i]!, w = want[i]!;
    const slot = layout.slots[o.slot];
    if (!slot || !slot.keys.includes(w.slotKey)) return false;
    if (o.desc !== w.desc) return false;
    // scans deliver NULLs first ascending / last descending (SQLite default); anything else needs a sort
    if (w.nullsFirst !== !w.desc) { if (!slot.keys.some((k) => k.startsWith("r0:"))) return false; }
  }
  return true;
}

/** Re-expresses an input ordering in terms of a parent layout (positions may move, keys stay). */
function remapOrdering(ordering: Ordering[], from: Layout, to: Layout): Ordering[] {
  const out: Ordering[] = [];
  for (const o of ordering) {
    const slot = from.slots[o.slot];
    if (!slot) break;
    let idx = -1;
    for (const k of slot.keys) { idx = to.find(k); if (idx >= 0) break; }
    if (idx < 0) break;
    out.push({ slot: idx, desc: o.desc });
  }
  return out;
}

function orderingFromKeys(keys: L.SortKey[], layout: Layout): Ordering[] {
  const want = wantedFrom(keys) ?? [];
  const out: Ordering[] = [];
  for (const w of want) { const i = layout.find(w.slotKey); if (i < 0) break; out.push({ slot: i, desc: w.desc }); }
  return out;
}

const EMPTY_LOC = { line: 0, col: 0, offset: 0, end: 0 };

// ----- conversion -----

function toPhysical(n: L.LNode, c: Ctx, want: Want): PhysicalNode {
  switch (n.kind) {
    case "scan": return planScan(n, undefined, c, want);
    case "filter": {
      if (n.input.kind === "scan") return planScan(n.input, n.predicate, c, want);
      const input = toPhysical(n.input, c, want);
      const sel = c.est.selectivity(n.predicate, relTables(input, c));
      return { kind: "filter", input, predicate: n.predicate, layout: n.layout, estRows: Math.max(1, input.estRows * sel), estCost: input.estCost + input.estRows * conjuncts(n.predicate).length * C.COST.CPU_EXPR, ordering: input.ordering };
    }
    case "subquery": {
      const plan = planSelectWith(n.select, c, {});
      return { kind: "subqueryscan", rel: n.rel, alias: n.alias, plan, layout: n.layout, estRows: plan.estRows, estCost: plan.estCost + plan.estRows * C.COST.CPU_TUPLE, ordering: remapOrdering(plan.ordering, plan.layout, n.layout) };
    }
    case "cteScan": {
      const plan = planCte(n.cte, c);
      return { kind: "ctescan", rel: n.rel, alias: n.alias, cte: n.cte, plan, layout: n.layout, estRows: plan.estRows, estCost: plan.estCost * 0.5 + plan.estRows * C.COST.CPU_TUPLE, ordering: [] };
    }
    case "working": return { kind: "working", rel: n.rel, alias: n.alias, cte: n.cte, layout: n.layout, estRows: 100, estCost: 1, ordering: [] };
    case "values": return { kind: "values", rows: n.rows, layout: n.layout, estRows: Math.max(1, n.rows.length), estCost: n.rows.length * C.COST.CPU_TUPLE, ordering: [] };
    case "join": return planJoinRegion(n, c, want);
    case "aggregate": return planAggregate(n, c);
    case "window": {
      const input = toPhysical(n.input, c, {});
      return { kind: "window", input, windows: n.windows, layout: n.layout, estRows: input.estRows, estCost: input.estCost + C.sortCost(input.estRows) * n.windows.length + input.estRows * C.COST.CPU_EXPR * n.windows.length, ordering: [] };
    }
    case "project": {
      const input = toPhysical(n.input, c, projectWant(n, want));
      return { kind: "project", input, exprs: n.exprs, names: n.names, layout: n.layout, estRows: input.estRows, estCost: input.estCost + input.estRows * n.exprs.length * C.COST.CPU_EXPR, ordering: remapOrdering(input.ordering, input.layout, n.layout) };
    }
    case "distinct": {
      const input = toPhysical(n.input, c, {});
      return { kind: "distinct", input, keyCount: n.keyCount, layout: n.layout, estRows: Math.max(1, Math.ceil(input.estRows * 0.5)), estCost: input.estCost + input.estRows * C.COST.HASH_PROBE, ordering: input.ordering };
    }
    case "sort": return planSort(n, c, want);
    case "limit": return planLimit(n, c, want);
    case "setop": {
      const left = toPhysical(n.left, c, {}), right = toPhysical(n.right, c, {});
      const estRows = n.op === "UNION ALL" ? left.estRows + right.estRows : n.op === "UNION" ? Math.max(1, (left.estRows + right.estRows) * 0.7) : n.op === "INTERSECT" ? Math.max(1, Math.min(left.estRows, right.estRows) * 0.5) : Math.max(1, left.estRows * 0.5);
      const cost = left.estCost + right.estCost + (n.op === "UNION ALL" ? 0 : (left.estRows + right.estRows) * C.COST.HASH_PROBE);
      return { kind: "setop", op: n.op, left, right, layout: n.layout, estRows, estCost: cost, ordering: [] };
    }
    case "truncate": {
      const input = toPhysical(n.input, c, want);
      return { kind: "truncate", input, keep: n.keep, layout: n.layout, estRows: input.estRows, estCost: input.estCost, ordering: remapOrdering(input.ordering, input.layout, n.layout) };
    }
  }
}

/** Translates a wanted order on a projection's output into a wanted order on its input (plain column projections only). */
function projectWant(p: L.LProject, want: Want): Want {
  if (!want.ordering) return {};
  const keys: WantedKey[] = [];
  for (const w of want.ordering) {
    const i = p.layout.find(w.slotKey);
    if (i < 0) break;
    const e = p.exprs[i]!;
    if (e.kind === "column" && e.depth === 0) keys.push({ ...w, slotKey: columnKey(e.relation, e.column) });
    else if (e.kind === "rowid" && e.depth === 0) keys.push({ ...w, slotKey: rowidKey(e.relation) });
    else break;
  }
  return keys.length ? { ordering: keys, limit: want.limit } : {};
}

function planCte(cte: BoundCte, c: Ctx): PhysicalNode {
  let plan = c.cteCache.get(cte);
  if (plan) return plan;
  if (cte.recursive) {
    const anchorSel: BoundSelect = { kind: "select", ctes: cte.select.ctes, body: cte.recursive.anchor, orderBy: [], columns: cte.columns, loc: cte.select.loc };
    const recSel: BoundSelect = { kind: "select", ctes: [], body: cte.recursive.recursiveTerm, orderBy: [], columns: cte.columns, loc: cte.select.loc };
    const anchor = planSelectWith(anchorSel, c, {});
    const recursive = planSelectWith(recSel, c, {});
    // output columns are addressable both as relation 0 columns and as result columns (ORDER BY / LIMIT of the CTE)
    const layout = new Layout(cte.columns.map((c, i) => ({ keys: [outKey(i), columnKey(0, i)], name: c.name, type: c.type })));
    // ORDER BY / LIMIT of a recursive CTE steer the recursion (queue order, early stop) exactly like SQLite does
    const orderBy: L.SortKey[] = cte.select.orderBy.map((o) => ({ expr: o.expr, desc: o.desc, nullsFirst: o.nullsFirst }));
    plan = { kind: "recursivecte", cte, anchor, recursive, unionAll: cte.recursive.unionAll, orderBy, limit: cte.select.limit, offset: cte.select.offset, layout, estRows: Math.max(10, anchor.estRows * 10), estCost: anchor.estCost + recursive.estCost * 10, ordering: [] };
  } else plan = planSelectWith(cte.select, c, {});
  c.cteCache.set(cte, plan);
  return plan;
}

// ----- scans -----

type CmpOp = "=" | "<" | "<=" | ">" | ">=";

interface ColumnBound { column: number; op: CmpOp | "ISNULL"; value: BoundExpr; conjunct: BoundExpr }

/** Extracts `column op constant` conjuncts for relation `rel` (constant = no depth-0 references). */
function indexableBounds(pred: BoundExpr | undefined, rel: number, table: TableInfo): ColumnBound[] {
  const out: ColumnBound[] = [];
  const isConst = (e: BoundExpr): boolean => directRefs(e).every((r) => r.depth > 0) && !containsSubqueryCorrelatedToSelf(e);
  const colOf = (e: BoundExpr): number | undefined => {
    if (e.kind === "column" && e.depth === 0 && e.relation === rel) return e.column;
    if (e.kind === "rowid" && e.depth === 0 && e.relation === rel) return table.schema.rowidColumn >= 0 ? table.schema.rowidColumn : -1;
    return undefined;
  };
  const flip: Record<CmpOp, CmpOp> = { "=": "=", "<": ">", "<=": ">=", ">": "<", ">=": "<=" };
  for (const cj of conjuncts(pred)) {
    if (cj.kind === "binary" && (cj.op === "=" || cj.op === "==" || cj.op === "<" || cj.op === "<=" || cj.op === ">" || cj.op === ">=")) {
      const op: CmpOp = cj.op === "==" ? "=" : cj.op;
      let col = colOf(cj.left);
      if (col !== undefined && isConst(cj.right)) { out.push({ column: col, op, value: cj.right, conjunct: cj }); continue; }
      col = colOf(cj.right);
      if (col !== undefined && isConst(cj.left)) out.push({ column: col, op: flip[op], value: cj.left, conjunct: cj });
    } else if (cj.kind === "between" && !cj.not) {
      const col = colOf(cj.expr);
      if (col !== undefined && isConst(cj.low) && isConst(cj.high)) {
        out.push({ column: col, op: ">=", value: cj.low, conjunct: cj });
        out.push({ column: col, op: "<=", value: cj.high, conjunct: cj });
      }
    } else if (cj.kind === "isnull" && !cj.not) {
      const col = colOf(cj.expr);
      if (col !== undefined && col >= 0) out.push({ column: col, op: "ISNULL", value: { kind: "literal", value: null, dataType: "NULL", loc: cj.loc }, conjunct: cj });
    }
  }
  return out;
}

function containsSubqueryCorrelatedToSelf(e: BoundExpr): boolean {
  // a subquery referencing depth-0 relations would need the current row; treat as non-constant
  let found = false;
  const walk = (x: BoundExpr): void => {
    if (found) return;
    if (x.kind === "exists" || x.kind === "subquery" || (x.kind === "in" && x.subquery)) {
      const sub = x.kind === "in" ? x.subquery! : x.subquery;
      if (sub.outerRefs.some((r) => r.depth === 1)) found = true;
      return;
    }
    switch (x.kind) {
      case "unary": walk(x.operand); break;
      case "binary": walk(x.left); walk(x.right); break;
      case "like": walk(x.left); walk(x.right); if (x.escape) walk(x.escape); break;
      case "between": walk(x.expr); walk(x.low); walk(x.high); break;
      case "in": walk(x.expr); x.list?.forEach(walk); break;
      case "isnull": walk(x.expr); break;
      case "case": if (x.operand) walk(x.operand); for (const w of x.whens) { walk(w.when); walk(w.then); } if (x.else) walk(x.else); break;
      case "cast": walk(x.expr); break;
      case "function": x.args.forEach(walk); break;
      default: break;
    }
  };
  walk(e);
  return found;
}

interface PathMatch { eq: BoundExpr[]; lo?: Bound; hi?: Bound; used: Set<BoundExpr>; rangeColumn?: number }

/** Matches bounds against an ordered column list: equality prefix, then one range column. */
function matchColumns(columns: readonly number[], bounds: ColumnBound[]): PathMatch {
  const used = new Set<BoundExpr>();
  const eq: BoundExpr[] = [];
  let lo: Bound | undefined, hi: Bound | undefined, rangeColumn: number | undefined;
  for (const col of columns) {
    const mine = bounds.filter((b) => b.column === col);
    const e = mine.find((b) => b.op === "=" || b.op === "ISNULL");
    if (e) { eq.push(e.value); used.add(e.conjunct); continue; }
    for (const b of mine) {
      if (b.op === ">" || b.op === ">=") { if (!lo) { lo = { expr: b.value, inclusive: b.op === ">=" }; used.add(b.conjunct); } }
      else if (b.op === "<" || b.op === "<=") { if (!hi) { hi = { expr: b.value, inclusive: b.op === "<=" }; used.add(b.conjunct); } }
    }
    if (lo || hi) rangeColumn = col;
    break;
  }
  return { eq, lo, hi, used, rangeColumn };
}

function planScan(scan: L.LScan, pred: BoundExpr | undefined, c: Ctx, want: Want): PhysicalNode {
  const table = scan.table, rel = scan.rel;
  const rows = c.est.tableRows(table);
  const rels: RelTables = new Map([[rel, { table, rows }]]);
  const all = conjuncts(pred);
  const bounds = indexableBounds(pred, rel, table);
  const ncols = table.schema.columns.length;
  const required = scan.requiredColumns;
  const candidates: PhysicalNode[] = [];
  const residual = (used: Set<BoundExpr>): BoundExpr | undefined => conjoin(all.filter((x) => !used.has(x)));
  const rowsAfter = (filter: BoundExpr | undefined, base: number): number => Math.max(1, base * c.est.selectivity(filter, rels));
  const wantKeys = want.ordering;
  const pkSlotKey = table.schema.rowidColumn >= 0 ? columnKey(rel, table.schema.rowidColumn) : rowidKey(rel);
  const rowidOrdering = (dir: 1 | -1): Ordering[] => {
    const o: Ordering[] = [{ slot: scan.layout.find(pkSlotKey), desc: dir < 0 }];
    if (table.schema.rowidColumn >= 0) o.push({ slot: scan.layout.find(rowidKey(rel)), desc: dir < 0 });
    return o;
  };
  const dirFor = (firstKey: string): 1 | -1 | 0 => {
    if (!wantKeys || wantKeys.length === 0) return 1;
    const w = wantKeys[0]!;
    if (w.slotKey !== firstKey) return 0;
    return w.desc ? -1 : 1;
  };

  // --- SeqScan (possibly bounded on the rowid) ---
  {
    const rowidCol = table.schema.rowidColumn >= 0 ? table.schema.rowidColumn : -1;
    const m = matchColumns([rowidCol], bounds.filter((b) => b.column === rowidCol && b.op !== "ISNULL"));
    const filter = residual(m.used);
    if (m.eq.length === 1) {
      const estRows = rowsAfter(filter, 1);
      candidates.push({ kind: "rowidlookup", table, alias: scan.alias, rel, rowid: m.eq[0]!, filter, layout: scan.layout, estRows, estCost: C.descentCost(rows, ncols) + C.COST.RANDOM_PAGE + all.length * C.COST.CPU_EXPR, ordering: rowidOrdering(1) });
    } else {
      const d = dirFor(pkSlotKey);
      const direction: 1 | -1 = d === -1 ? -1 : 1;
      const rangeSel = m.lo || m.hi ? c.est.selectivity(conjoin(all.filter((x) => m.used.has(x))), rels) : 1;
      const scanned = Math.max(1, rows * rangeSel);
      const estRows = rowsAfter(filter, scanned);
      candidates.push({ kind: "seqscan", table, alias: scan.alias, rel, filter, lo: m.lo, hi: m.hi, direction, layout: scan.layout, estRows, estCost: (m.lo || m.hi ? C.descentCost(rows, ncols) : 0) + C.seqScanCost(scanned, ncols, all.length), ordering: rowidOrdering(direction) });
    }
  }

  // --- index scans ---
  const indexes = c.schema.listIndexInfos(table.schema.name).filter((ix) => !ix.where);
  const forced = scan.indexedBy ? indexes.find((ix) => ix.schema.name.toLowerCase() === scan.indexedBy!.toLowerCase()) : undefined;
  for (const ix of forced ? [forced] : indexes) {
    const cols = ix.schema.columns;
    const m = matchColumns(cols, bounds);
    const coveringSet = new Set<number>(cols);
    const covering = required !== undefined && [...required].every((col) => coveringSet.has(col));
    const firstKey = columnKey(rel, cols[0]!);
    const d = dirFor(firstKey);
    const providesOrder = d !== 0 && wantKeys !== undefined && wantKeys.length > 0;
    if (m.eq.length === 0 && !m.lo && !m.hi && !providesOrder && !covering && !forced) continue;
    const direction: 1 | -1 = d === -1 ? -1 : 1;
    const filter = residual(m.used);
    // selectivity of the matched part
    let matched: number;
    if (m.eq.length === cols.length && ix.schema.unique) matched = 1;
    else {
      const usedPred = conjoin(all.filter((x) => m.used.has(x)));
      matched = Math.max(1, rows * c.est.selectivity(usedPred, rels));
    }
    const estRows = rowsAfter(filter, matched);
    const ordering: Ordering[] = cols.map((col) => ({ slot: scan.layout.find(columnKey(rel, col)), desc: direction < 0 }));
    ordering.push({ slot: scan.layout.find(rowidKey(rel)), desc: direction < 0 });
    candidates.push({ kind: "indexscan", table, alias: scan.alias, rel, index: ix, eq: m.eq, lo: m.lo, hi: m.hi, covering, filter, direction, layout: scan.layout, estRows, estCost: C.indexScanCost(rows, matched, cols.length, covering, all.length), ordering });
  }

  if (forced) {
    const f = candidates.find((x) => x.kind === "indexscan" && x.index === forced);
    if (f) return f;
  }
  // pick by cost, with a bonus for delivering the wanted order (the parent would otherwise pay for a sort / lose early termination)
  let best: PhysicalNode | undefined, bestScore = Infinity;
  for (const cand of candidates) {
    let score = cand.estCost;
    if (wantKeys && wantKeys.length) {
      if (satisfies(cand.ordering, cand.layout, wantKeys)) {
        if (want.limit !== undefined && cand.estRows > 0) score = cand.estCost * Math.min(1, (want.limit + 1) / cand.estRows) + C.COST.RANDOM_PAGE;
      } else score += C.sortCost(cand.estRows);
    }
    if (score < bestScore) { bestScore = score; best = cand; }
  }
  return best!;
}

// ----- joins -----

function planJoinRegion(j: L.LJoin, c: Ctx, want: Want): PhysicalNode {
  if (j.type !== "INNER") {
    const left = toPhysical(j.left, c, want), right = toPhysical(j.right, c, {});
    return makeJoin(j.type, left, right, j.condition, c);
  }
  const items: JoinItem<PhysicalNode>[] = [];
  const preds: JoinPredicate[] = [];
  const constant: BoundExpr[] = [];
  const collect = (n: L.LNode): void => {
    if (n.kind === "join" && n.type === "INNER") {
      collect(n.left); collect(n.right);
      for (const cj of conjuncts(n.condition)) {
        const rels = referencedRelations(cj);
        if (rels.size === 0) constant.push(cj); else preds.push({ expr: cj, rels });
      }
      return;
    }
    items.push({ plan: toPhysical(n, c, items.length === 0 ? want : {}), rels: n.rels });
  };
  collect(j);
  let plan = orderJoins(items, preds, (l, r, cond) => makeJoin("INNER", l, r, cond, c));
  if (constant.length) plan = { kind: "filter", input: plan, predicate: conjoin(constant)!, layout: plan.layout, estRows: plan.estRows, estCost: plan.estCost + plan.estRows * C.COST.CPU_EXPR, ordering: plan.ordering };
  return plan;
}

/** Splits a join condition into equi-key pairs (left expr, right expr) and the residual. */
function equiKeys(cond: BoundExpr | undefined, left: PhysicalNode, right: PhysicalNode): { leftKeys: BoundExpr[]; rightKeys: BoundExpr[]; residual: BoundExpr | undefined } {
  const leftKeys: BoundExpr[] = [], rightKeys: BoundExpr[] = [], rest: BoundExpr[] = [];
  const lrels = relsOfLayout(left.layout), rrels = relsOfLayout(right.layout);
  for (const cj of conjuncts(cond)) {
    if (cj.kind === "binary" && (cj.op === "=" || cj.op === "==")) {
      const a = referencedRelations(cj.left), b = referencedRelations(cj.right);
      if (a.size > 0 && b.size > 0 && subset(a, lrels) && subset(b, rrels) && noSubquery(cj)) { leftKeys.push(cj.left); rightKeys.push(cj.right); continue; }
      if (a.size > 0 && b.size > 0 && subset(b, lrels) && subset(a, rrels) && noSubquery(cj)) { leftKeys.push(cj.right); rightKeys.push(cj.left); continue; }
    }
    rest.push(cj);
  }
  return { leftKeys, rightKeys, residual: conjoin(rest) };
}

function noSubquery(e: BoundExpr): boolean {
  return exprKey(e).indexOf("#") < 0;
}

function relsOfLayout(l: Layout): Set<number> {
  const out = new Set<number>();
  for (const s of l.slots) for (const k of s.keys) {
    if (k.startsWith("c0:")) out.add(Number(k.split(":")[1]));
    else if (k.startsWith("r0:")) out.add(Number(k.slice(3)));
  }
  return out;
}

function subset(a: Set<number>, b: Set<number>): boolean { for (const x of a) if (!b.has(x)) return false; return true; }

function joinRows(type: L.LogicalJoinType, left: PhysicalNode, right: PhysicalNode, cond: BoundExpr | undefined, c: Ctx): number {
  const rels = relTables(left, c);
  relTables(right, c, rels);
  const sel = c.est.selectivity(cond, rels);
  const inner = Math.max(1, left.estRows * right.estRows * sel);
  switch (type) {
    case "INNER": case "CROSS": return inner;
    case "LEFT": return Math.max(inner, left.estRows);
    case "FULL": return Math.max(inner, left.estRows + right.estRows);
    case "SEMI": return Math.max(1, Math.min(left.estRows, inner));
    case "ANTI": return Math.max(1, left.estRows - Math.min(left.estRows, inner));
  }
}

function makeJoin(type: L.LogicalJoinType, left: PhysicalNode, right: PhysicalNode, cond: BoundExpr | undefined, c: Ctx): PhysicalNode {
  const layout = type === "SEMI" || type === "ANTI" ? left.layout : left.layout.concat(right.layout);
  const estRows = joinRows(type, left, right, cond, c);
  const { leftKeys, rightKeys, residual } = equiKeys(cond, left, right);
  const candidates: PhysicalNode[] = [];
  if (leftKeys.length > 0) {
    // merge join when both sides already deliver the key order
    if ((type === "INNER" || type === "LEFT") && leftKeys.length === 1 && orderedBy(left, leftKeys[0]!) && orderedBy(right, rightKeys[0]!)) {
      candidates.push({ kind: "mergejoin", type, left, right, leftKeys, rightKeys, residual, layout, estRows, estCost: left.estCost + right.estCost + C.mergeJoinCost(left.estRows, right.estRows, estRows), ordering: left.ordering });
    }
    // hash join: probe = left (streamed), build = right
    candidates.push({ kind: "hashjoin", type, left, right, leftKeys, rightKeys, residual, layout, estRows, estCost: left.estCost + right.estCost + C.hashJoinCost(right.estRows, left.estRows, estRows), ordering: left.ordering });
  }
  if (candidates.length === 0 || type === "FULL") {
    candidates.push({ kind: "nestedloop", type, left, right, condition: cond, layout, estRows, estCost: left.estCost + right.estCost + C.nestedLoopCost(left.estRows, right.estRows, estRows), ordering: left.ordering });
  }
  let best = candidates[0]!;
  for (const cand of candidates) if (cand.estCost < best.estCost) best = cand;
  return best;
}

function orderedBy(n: PhysicalNode, key: BoundExpr): boolean {
  if (n.ordering.length === 0) return false;
  const first = n.ordering[0]!;
  if (first.desc) return false;
  const slot = n.layout.slots[first.slot];
  if (!slot) return false;
  if (key.kind === "column" && key.depth === 0) return slot.keys.includes(columnKey(key.relation, key.column));
  if (key.kind === "rowid" && key.depth === 0) return slot.keys.includes(rowidKey(key.relation));
  return false;
}

// ----- aggregate / sort / limit -----

function planAggregate(a: L.LAggregate, c: Ctx): PhysicalNode {
  const groupKeys: L.SortKey[] = a.groupBy.map((g) => ({ expr: g, desc: false, nullsFirst: true }));
  const wanted = a.groupBy.length ? wantedFrom(groupKeys) : undefined;
  const input = toPhysical(a.input, c, wanted && wanted.length === a.groupBy.length ? { ordering: wanted } : {});
  const rels = relTables(input, c);
  let groups = 1;
  if (a.groupBy.length) {
    groups = 1;
    for (const g of a.groupBy) {
      let nd = Math.max(1, Math.ceil(input.estRows * 0.1));
      if (g.kind === "column" && g.depth === 0) { const r = rels.get(g.relation); if (r) nd = c.est.nDistinct(r.table, g.column); }
      groups *= nd;
    }
    groups = Math.max(1, Math.min(groups, input.estRows));
  }
  if (a.groupBy.length && wanted && wanted.length === a.groupBy.length && satisfies(input.ordering, input.layout, wanted)) {
    return { kind: "sortedaggregate", input, groupBy: a.groupBy, aggs: a.aggs, passthrough: a.passthrough, layout: a.layout, estRows: groups, estCost: input.estCost + input.estRows * (a.aggs.length + 1) * C.COST.CPU_EXPR, ordering: remapOrdering(input.ordering, input.layout, a.layout) };
  }
  return { kind: "hashaggregate", input, groupBy: a.groupBy, aggs: a.aggs, passthrough: a.passthrough, layout: a.layout, estRows: groups, estCost: input.estCost + C.hashAggregateCost(input.estRows, groups, a.aggs.length), ordering: [] };
}

function makeSort(input: PhysicalNode, keys: L.SortKey[]): PhysicalNode {
  return { kind: "sort", input, keys, layout: input.layout, estRows: input.estRows, estCost: input.estCost + C.sortCost(input.estRows), ordering: orderingFromKeys(keys, input.layout) };
}

function planSort(s: L.LSort, c: Ctx, want: Want): PhysicalNode {
  const wanted = wantedFrom(s.keys);
  const complete = wanted !== undefined && wanted.length === s.keys.length;
  // alternative A: ask the input for the order
  const ordered = complete ? toPhysical(s.input, c, { ordering: wanted, limit: want.limit }) : undefined;
  if (ordered && satisfies(ordered.ordering, ordered.layout, wanted)) {
    const plain = toPhysical(s.input, c, {});
    const sortCost = plain.estCost + (want.limit !== undefined ? C.topKCost(plain.estRows, want.limit) : C.sortCost(plain.estRows));
    const orderedCost = want.limit !== undefined ? ordered.estCost * Math.min(1, (want.limit + 1) / Math.max(1, ordered.estRows)) : ordered.estCost;
    if (orderedCost <= sortCost) return ordered;
    return makeSort(plain, s.keys);
  }
  const input = ordered ?? toPhysical(s.input, c, {});
  return makeSort(input, s.keys);
}

function planLimit(l: L.LLimit, c: Ctx, want: Want): PhysicalNode {
  const lim = constantNumber(l.limit);
  const off = constantNumber(l.offset) ?? 0;
  const budget = lim !== undefined ? Math.max(0, lim) + Math.max(0, off) : undefined;
  if (l.input.kind === "sort" && l.limit) {
    const s = l.input;
    const wanted = wantedFrom(s.keys);
    const complete = wanted !== undefined && wanted.length === s.keys.length;
    const ordered = complete ? toPhysical(s.input, c, { ordering: wanted, limit: budget ?? 100 }) : undefined;
    const plain = toPhysical(s.input, c, {});
    const k = budget ?? 100;
    const topkCost = plain.estCost + C.topKCost(plain.estRows, k);
    if (ordered && satisfies(ordered.ordering, ordered.layout, wanted)) {
      const orderedCost = ordered.estCost * Math.min(1, (k + 1) / Math.max(1, ordered.estRows)) + k * C.COST.CPU_TUPLE;
      if (orderedCost <= topkCost) return { kind: "limit", input: ordered, limit: l.limit, offset: l.offset, layout: l.layout, estRows: Math.min(ordered.estRows, lim ?? ordered.estRows), estCost: orderedCost, ordering: ordered.ordering };
    }
    return { kind: "topk", input: plain, keys: s.keys, limit: l.limit, offset: l.offset, layout: l.layout, estRows: Math.min(plain.estRows, lim ?? plain.estRows), estCost: topkCost, ordering: orderingFromKeys(s.keys, plain.layout) };
  }
  const input = toPhysical(l.input, c, { ...want, limit: budget });
  const estRows = lim !== undefined ? Math.min(input.estRows, Math.max(1, lim)) : input.estRows;
  const estCost = budget !== undefined ? input.estCost * Math.min(1, (budget + 1) / Math.max(1, input.estRows)) : input.estCost;
  return { kind: "limit", input, limit: l.limit, offset: l.offset, layout: l.layout, estRows, estCost, ordering: input.ordering };
}

// ----- statements -----

const noLayout = Layout.empty();
const base = (): PBase => ({ layout: noLayout, estRows: 0, estCost: 0, ordering: [] });

export function planInsert(stmt: BoundInsert, ctx: PlanContext): PInsert {
  const c = mkCtx(ctx);
  const table = c.schema.table(stmt.table.name);
  if (!table) throw new BasaltError(`no such table: ${stmt.table.name}`);
  const src = buildInsertSource(stmt, { schema: c.schema });
  let source: PhysicalNode | undefined;
  if (src) {
    source = toPhysical(optimize(src, c.schema), c, {});
    // INSERT INTO t SELECT ... FROM t: materialise the source first (the scan must not see the new rows)
    if (stmt.source.kind === "select" && referencesTable(source, table)) source = { kind: "materialize", input: source, layout: source.layout, estRows: source.estRows, estCost: source.estCost + source.estRows * C.COST.MATERIALIZE, ordering: source.ordering };
  }
  const layout = stmt.returning ? returningLayout(stmt.returning) : noLayout;
  return { kind: "insert", stmt, table, source, layout, estRows: source?.estRows ?? 1, estCost: (source?.estCost ?? 0) + (source?.estRows ?? 1) * C.COST.RANDOM_PAGE, ordering: [] };
}

function referencesTable(n: PhysicalNode, table: TableInfo): boolean {
  if ((n.kind === "seqscan" || n.kind === "indexscan" || n.kind === "rowidlookup") && n.table.schema.name.toLowerCase() === table.schema.name.toLowerCase()) return true;
  return childrenOf(n).some((ch) => referencesTable(ch, table));
}

function returningLayout(ret: { expr: BoundExpr; name: string }[]): Layout {
  return new Layout(ret.map((r, i) => ({ keys: [outKey(i)], name: r.name, type: r.expr.dataType })));
}

export function planUpdate(stmt: BoundUpdate, ctx: PlanContext): PUpdate {
  const c = mkCtx(ctx);
  const table = c.schema.table(stmt.table.name);
  if (!table) throw new BasaltError(`no such table: ${stmt.table.name}`);
  const input = toPhysical(optimize(buildUpdateScan(stmt, { schema: c.schema }), c.schema), c, {});
  return { kind: "update", stmt, table, input, layout: stmt.returning ? returningLayout(stmt.returning) : noLayout, estRows: input.estRows, estCost: input.estCost + input.estRows * C.COST.RANDOM_PAGE, ordering: [] };
}

export function planDelete(stmt: BoundDelete, ctx: PlanContext): PDelete {
  const c = mkCtx(ctx);
  const table = c.schema.table(stmt.table.name);
  if (!table) throw new BasaltError(`no such table: ${stmt.table.name}`);
  const input = toPhysical(optimize(buildDeleteScan(stmt, { schema: c.schema }), c.schema), c, {});
  return { kind: "delete", stmt, table, input, layout: stmt.returning ? returningLayout(stmt.returning) : noLayout, estRows: input.estRows, estCost: input.estCost + input.estRows * C.COST.RANDOM_PAGE, ordering: [] };
}

export function planCreateTable(stmt: BoundCreateTable, ctx: PlanContext): PCreateTable {
  const source = stmt.asSelect ? planSelect(stmt.asSelect, ctx) : undefined;
  return { kind: "createtable", stmt, source, ...base() };
}

export function simpleNode(kind: "createindex", stmt: BoundCreateIndex): PCreateIndex;
export function simpleNode(kind: "createview", stmt: BoundCreateView): PCreateView;
export function simpleNode(kind: "drop", stmt: BoundDrop): PDrop;
export function simpleNode(kind: "alter", stmt: BoundAlterTable): PAlter;
export function simpleNode(kind: "analyze", stmt: BoundAnalyze): PAnalyze;
export function simpleNode(kind: "pragma", stmt: BoundPragma): PPragma;
export function simpleNode(kind: string, stmt: unknown): PhysicalNode {
  return { kind, stmt, ...base() } as unknown as PhysicalNode;
}

export function vacuumNode(): PVacuum { return { kind: "vacuum", ...base() }; }

export function explainNode(plan: PhysicalNode, analyze: boolean): PExplain {
  return { kind: "explain", analyze, plan, layout: new Layout([{ keys: [outKey(0)], name: "QUERY PLAN", type: "TEXT" }]), estRows: 0, estCost: 0, ordering: [] };
}

export { EMPTY_LOC };
