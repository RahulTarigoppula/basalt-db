/**
 * Bound tree -> logical plan.
 *
 * A SELECT core becomes
 *   leaves (Scan / SubqueryScan / CteScan / WorkingTable) -> Join tree -> Filter(WHERE) -> [Aggregate] -> [Filter(HAVING)]
 *   -> [Window] -> Project(projections [+ ORDER BY helper columns]) -> [Distinct] -> [Sort] -> [Truncate] -> [Limit]
 *
 * `IN (subquery)` / `EXISTS` conjuncts of the WHERE clause become SEMI / ANTI joins when the subquery is uncorrelated or
 * "simply correlated" (a plain SELECT over tables whose WHERE only correlates with the immediately enclosing scope); the
 * correlated conjuncts are lifted into the join condition. Every other subquery stays an expression and is evaluated by
 * the executor (`EvalContext.evalSubquery`, materialised once when uncorrelated).
 */
import type { IndexInfo, TableInfo } from "../catalog/catalog.js";
import { BasaltError } from "../core/errors.js";
import type {
  BoundAggregate, BoundCte, BoundDelete, BoundExpr, BoundFrom, BoundInsert, BoundOrderBy, BoundSelect, BoundSelectBody, BoundSelectCore,
  BoundSubquery, BoundUpdate, BoundWindow, RelationColumn,
} from "../sql/bound.js";
import { allRefsAtDepth, columnKey, containsKind, exprKey, outKey, rowidKey } from "./layout.js";
import * as L from "./logical.js";

/** What the planner needs to know about the schema. Implemented by `SchemaSet` and `WritableCatalog`. */
export interface SchemaLookup {
  table(name: string): TableInfo | undefined;
  index(name: string): IndexInfo | undefined;
  listIndexInfos(table: string): IndexInfo[];
}

export interface BuildContext { schema: SchemaLookup }

const SUBQUERY_KINDS = new Set<BoundExpr["kind"]>(["exists", "subquery", "in"]);

/** Splits a conjunction into its top-level conjuncts. */
export function conjuncts(e: BoundExpr | undefined, out: BoundExpr[] = []): BoundExpr[] {
  if (!e) return out;
  if (e.kind === "binary" && e.op === "AND") { conjuncts(e.left, out); conjuncts(e.right, out); return out; }
  out.push(e);
  return out;
}

/** Rebuilds a conjunction (undefined for an empty list). */
export function conjoin(list: readonly BoundExpr[]): BoundExpr | undefined {
  let acc: BoundExpr | undefined;
  for (const c of list) acc = acc ? { kind: "binary", op: "AND", left: acc, right: c, dataType: "INTEGER", loc: c.loc } : c;
  return acc;
}

// ----- SELECT -----

export function buildSelect(select: BoundSelect, ctx: BuildContext): L.LNode {
  if (select.body.kind === "core") return buildCore(select.body, select, ctx);
  let node = buildBody(select.body, ctx);
  if (select.orderBy.length) node = L.sort(node, select.orderBy.map((o) => ({ expr: o.expr, desc: o.desc, nullsFirst: o.nullsFirst })));
  if (select.limit || select.offset) node = L.limit(node, select.limit, select.offset);
  return node;
}

function buildBody(body: BoundSelectBody, ctx: BuildContext): L.LNode {
  switch (body.kind) {
    case "core": return buildCore(body, undefined, ctx);
    case "values": return L.values(body.rows, body.columns);
    case "compound": {
      const left = buildBody(body.left, ctx), right = buildBody(body.right, ctx);
      return L.setOp(body.op, left, right, columnsOfBody(body));
    }
  }
}

function columnsOfBody(body: BoundSelectBody): RelationColumn[] {
  switch (body.kind) {
    case "core": return body.projections.map((p) => ({ name: p.name, type: p.expr.dataType, hidden: false }));
    case "values": return body.columns;
    case "compound": {
      const l = columnsOfBody(body.left), r = columnsOfBody(body.right);
      return l.map((c, i) => ({ name: c.name, type: c.type === r[i]?.type ? c.type : "ANY", hidden: false }));
    }
  }
}

/** Builds the leaf node of relation `index` of `core`, numbering it `rel` in the plan. */
function buildLeaf(core: BoundSelectCore, index: number, rel: number, ctx: BuildContext): L.LNode {
  const r = core.relations[index]!;
  switch (r.kind) {
    case "table": {
      const info = ctx.schema.table(r.table.name);
      if (!info) throw new BasaltError(`no such table: ${r.table.name}`);
      return L.scan(info, r.alias, rel, r.indexedBy);
    }
    case "subquery": return L.subqueryScan(rel, r.select, r.alias ?? `subquery${index}`, r.columns);
    case "view": return L.subqueryScan(rel, r.select, r.alias, r.columns);
    case "cte": return r.recursiveRef ? L.workingTable(rel, r.cte, r.alias) : L.cteScan(rel, r.cte, r.alias);
  }
}

/** Builds the join tree of a core; `relOffset` renumbers its relations (used when inlining a subquery as a join side). */
function buildFrom(core: BoundSelectCore, from: BoundFrom | undefined, ctx: BuildContext, relOffset: number, lift: (e: BoundExpr) => BoundExpr): L.LNode {
  if (!from) return L.values([[]], []);
  const rec = (f: BoundFrom): L.LNode => {
    if (f.kind === "relation") return buildLeaf(core, f.index, f.index + relOffset, ctx);
    const left = rec(f.left), right = rec(f.right);
    const cond = f.condition ? lift(f.condition) : undefined;
    switch (f.joinType) {
      case "INNER": case "CROSS": return L.join("INNER", left, right, cond);
      case "LEFT": return L.join("LEFT", left, right, cond);
      case "RIGHT": return L.join("LEFT", right, left, cond);
      case "FULL": return L.join("FULL", left, right, cond);
    }
  };
  return rec(from);
}

const identity = (e: BoundExpr): BoundExpr => e;

function buildCore(core: BoundSelectCore, select: BoundSelect | undefined, ctx: BuildContext): L.LNode {
  let node = buildFrom(core, core.from, ctx, 0, identity);
  let nextRel = core.relations.length;

  // WHERE: convert IN/EXISTS conjuncts to semi/anti joins, keep the rest as a filter
  const rest: BoundExpr[] = [];
  for (const c of conjuncts(core.where)) {
    const converted = trySemiJoin(c, node, ctx, () => nextRel++);
    if (converted) node = converted; else rest.push(c);
  }
  const where = conjoin(rest);
  if (where) node = L.filter(node, where);

  const hasAgg = core.aggregates.length > 0 || core.groupBy.length > 0;
  const orderBy = select ? select.orderBy : [];
  if (hasAgg) {
    const covered = new Set<string>();
    for (const g of core.groupBy) {
      if (g.kind === "column" && g.depth === 0) covered.add(columnKey(g.relation, g.column));
      if (g.kind === "rowid" && g.depth === 0) covered.add(rowidKey(g.relation));
    }
    const passthrough: L.LAggregate["passthrough"] = [];
    const seen = new Set<string>();
    const consider = (e: BoundExpr): void => {
      for (const r of allRefsAtDepth(e, 0)) {
        const key = r.kind === "rowid" ? rowidKey(r.relation) : columnKey(r.relation, r.column);
        if (covered.has(key) || seen.has(key)) continue;
        if (!node.layout.has(key)) continue; // belongs to a synthetic relation that is not visible (semi join side)
        seen.add(key);
        passthrough.push({ relation: r.relation, column: r.column, rowid: r.kind === "rowid" });
      }
    };
    // bare columns outside aggregate arguments: scan projections / having / order by / window specs with aggregates removed
    const stripAggs = (e: BoundExpr): BoundExpr => {
      if (e.kind === "aggregate") return { kind: "literal", value: null, dataType: "NULL", loc: e.loc };
      return mapChildren(e, stripAggs);
    };
    for (const p of core.projections) consider(stripAggs(p.expr));
    if (core.having) consider(stripAggs(core.having));
    for (const o of orderBy) consider(stripAggs(o.expr));
    for (const w of core.windows) { for (const a of w.args) consider(stripAggs(a)); for (const p of w.spec.partitionBy) consider(stripAggs(p)); for (const o of w.spec.orderBy) consider(stripAggs(o.expr)); if (w.filter) consider(stripAggs(w.filter)); }
    node = L.aggregate(node, core.groupBy, core.aggregates, passthrough);
    if (core.having) node = L.filter(node, core.having);
  }
  if (core.windows.length) node = L.window(node, core.windows);

  // projections (+ ORDER BY helper columns)
  const exprs = core.projections.map((p) => p.expr);
  const names = core.projections.map((p) => p.name);
  const projKeys = exprs.map((e) => (e.kind === "literal" || e.kind === "param" ? null : exprKey(e)));
  const sortKeys: L.SortKey[] = [];
  const n = exprs.length;
  for (const o of orderBy) {
    let idx = o.projectionIndex;
    if (idx === undefined) {
      const k = exprKey(o.expr);
      const j = projKeys.indexOf(k);
      if (j >= 0) idx = j;
    }
    if (idx === undefined) { idx = exprs.length; exprs.push(o.expr); names.push(`__order${idx}`); }
    sortKeys.push({ expr: { kind: "resultColumn", index: idx, dataType: exprs[idx]!.dataType, loc: o.expr.loc }, desc: o.desc, nullsFirst: o.nullsFirst });
  }
  node = L.project(node, exprs, names);
  if (core.distinct) node = L.distinct(node, n);
  if (sortKeys.length) node = L.sort(node, sortKeys);
  if (exprs.length > n) node = L.truncate(node, n);
  if (select && (select.limit || select.offset)) node = L.limit(node, select.limit, select.offset);
  return node;
}

/** Applies `f` to every direct child expression (does not descend into subqueries). */
export function mapChildren(e: BoundExpr, f: (x: BoundExpr) => BoundExpr): BoundExpr {
  const m = (x: BoundExpr | undefined): BoundExpr | undefined => (x ? f(x) : undefined);
  switch (e.kind) {
    case "unary": return { ...e, operand: f(e.operand) };
    case "binary": return { ...e, left: f(e.left), right: f(e.right) };
    case "like": return { ...e, left: f(e.left), right: f(e.right), escape: m(e.escape) };
    case "between": return { ...e, expr: f(e.expr), low: f(e.low), high: f(e.high) };
    case "in": return { ...e, expr: f(e.expr), list: e.list?.map(f) };
    case "isnull": return { ...e, expr: f(e.expr) };
    case "case": return { ...e, operand: m(e.operand), whens: e.whens.map((w) => ({ when: f(w.when), then: f(w.then) })), else: m(e.else) };
    case "cast": return { ...e, expr: f(e.expr) };
    case "function": return { ...e, args: e.args.map(f) };
    case "aggregate": return { ...e, args: e.args.map(f), filter: m(e.filter) };
    case "window": return {
      ...e, args: e.args.map(f), filter: m(e.filter),
      spec: {
        partitionBy: e.spec.partitionBy.map(f), orderBy: e.spec.orderBy.map((o) => ({ ...o, expr: f(o.expr) })),
        frame: e.spec.frame ? { ...e.spec.frame, start: mapBound(e.spec.frame.start, f), end: mapBound(e.spec.frame.end, f) } : undefined,
      },
    };
    default: return e;
  }
}

function mapBound(b: import("../sql/bound.js").BoundFrameBound, f: (x: BoundExpr) => BoundExpr): import("../sql/bound.js").BoundFrameBound {
  return b.kind === "preceding" || b.kind === "following" ? { kind: b.kind, offset: f(b.offset) } : b;
}

// ----- IN / EXISTS -> semi / anti join -----

/**
 * Moves an expression from a subquery scope into its enclosing scope: depth-0 relations are renumbered by `offset`
 * (they become synthetic relations of the outer scope) and deeper references lose one level.
 */
function liftExpr(e: BoundExpr, offset: number): BoundExpr {
  switch (e.kind) {
    case "column": return e.depth === 0 ? { ...e, relation: e.relation + offset, rel: e.relation + offset } : { ...e, depth: e.depth - 1, rel: e.rel - 1 };
    case "rowid": return e.depth === 0 ? { ...e, relation: e.relation + offset, rel: e.relation + offset } : { ...e, depth: e.depth - 1, rel: e.rel - 1 };
    default: return mapChildren(e, (x) => liftExpr(x, offset));
  }
}

function hasRefsDeeperThan(e: BoundExpr, depth: number): boolean {
  let found = false;
  const walk = (x: BoundExpr): BoundExpr => { if ((x.kind === "column" || x.kind === "rowid") && x.depth > depth) found = true; return mapChildren(x, walk); };
  walk(e);
  return found;
}

/** Tries to turn a WHERE conjunct `[NOT] EXISTS (...)` / `x IN (...)` into a semi/anti join over `left`. */
function trySemiJoin(c: BoundExpr, left: L.LNode, ctx: BuildContext, allocRel: () => number): L.LNode | undefined {
  let sub: BoundSubquery, needle: BoundExpr | undefined, anti: boolean;
  if (c.kind === "exists") { sub = c.subquery; anti = c.not; }
  else if (c.kind === "in" && c.subquery && !c.not) { sub = c.subquery; needle = c.expr; anti = false; }
  else return undefined;
  if (needle && containsKind(needle, SUBQUERY_KINDS)) return undefined;
  const sel = sub.select;
  // uncorrelated: the subquery becomes a derived relation
  if (!sub.correlated) {
    if (sel.limit || sel.offset) return undefined;
    const rel = allocRel();
    const right = L.subqueryScan(rel, sel, `subquery${rel}`, sel.columns);
    const cond = needle ? eq(needle, { kind: "column", depth: 0, relation: rel, rel, column: 0, name: sel.columns[0]?.name ?? "c", table: undefined, dataType: sel.columns[0]?.type ?? "ANY", loc: c.loc }) : undefined;
    return L.join(anti ? "ANTI" : "SEMI", left, right, cond);
  }
  // simply correlated: plain core over tables / CTEs, correlated only with the immediately enclosing scope
  if (sel.ctes.length || sel.body.kind !== "core" || sel.limit || sel.offset) return undefined;
  const core = sel.body;
  if (core.aggregates.length || core.windows.length || core.groupBy.length || core.having || !core.from) return undefined;
  if (core.relations.some((r) => r.kind === "subquery" || r.kind === "view" || (r.kind === "cte" && r.recursiveRef))) return undefined;
  const all = [...conjuncts(core.where)];
  const fromConds: BoundExpr[] = [];
  const collect = (f: BoundFrom): void => { if (f.kind === "join") { collect(f.left); collect(f.right); if (f.condition) fromConds.push(f.condition); if (f.joinType !== "INNER" && f.joinType !== "CROSS") fromConds.push(c); } };
  collect(core.from);
  if (fromConds.includes(c)) return undefined; // outer joins inside the subquery: keep it simple
  for (const x of [...all, ...fromConds, ...(needle ? [core.projections[0]!.expr] : [])]) {
    if (containsKind(x, SUBQUERY_KINDS) || hasRefsDeeperThan(x, 1)) return undefined;
  }
  const offset = allocRel();
  for (let i = 1; i < core.relations.length; i++) allocRel();
  const lift = (e: BoundExpr): BoundExpr => liftExpr(e, offset);
  let right = buildFrom(core, core.from, ctx, offset, lift);
  const innerOnly: BoundExpr[] = [], joinConds: BoundExpr[] = [];
  for (const x of all) {
    const refs = allRefsAtDepth(x, 1);
    (refs.length === 0 ? innerOnly : joinConds).push(lift(x));
  }
  const innerWhere = conjoin(innerOnly);
  if (innerWhere) right = L.filter(right, innerWhere);
  if (needle) joinConds.unshift(eq(needle, lift(core.projections[0]!.expr)));
  return L.join(anti ? "ANTI" : "SEMI", left, right, conjoin(joinConds));
}

function eq(a: BoundExpr, b: BoundExpr): BoundExpr {
  return { kind: "binary", op: "=", left: a, right: b, dataType: "INTEGER", loc: a.loc };
}

// ----- DML -----

/** Scan + WHERE for a DELETE; the layout has the target's columns and rowid. */
export function buildDeleteScan(stmt: BoundDelete, ctx: BuildContext): L.LNode {
  const info = ctx.schema.table(stmt.table.name);
  if (!info) throw new BasaltError(`no such table: ${stmt.table.name}`);
  let node: L.LNode = L.scan(info, stmt.alias, 0);
  if (stmt.where) node = L.filter(node, stmt.where);
  return node;
}

/** Target x FROM relations + WHERE for an UPDATE. */
export function buildUpdateScan(stmt: BoundUpdate, ctx: BuildContext): L.LNode {
  const info = ctx.schema.table(stmt.table.name);
  if (!info) throw new BasaltError(`no such table: ${stmt.table.name}`);
  let node: L.LNode = L.scan(info, stmt.alias, 0);
  if (stmt.from) {
    const fake: BoundSelectCore = { kind: "core", relations: stmt.relations, from: stmt.from, groupBy: [], aggregates: [], windows: [], distinct: false, projections: [], outerRefs: [] };
    node = L.join("INNER", node, buildFrom(fake, stmt.from, ctx, 0, identity));
  }
  if (stmt.where) node = L.filter(node, stmt.where);
  return node;
}

/** Source rows of an INSERT (undefined for DEFAULT VALUES). */
export function buildInsertSource(stmt: BoundInsert, ctx: BuildContext): L.LNode | undefined {
  switch (stmt.source.kind) {
    case "defaults": return undefined;
    case "values": {
      const width = stmt.columns.length;
      const columns: RelationColumn[] = [];
      for (let i = 0; i < width; i++) columns.push({ name: `column${i + 1}`, type: "ANY", hidden: false });
      return L.values(stmt.source.rows, columns);
    }
    case "select": return buildSelect(stmt.source.select, ctx);
  }
}

/** Sort keys for a plan whose layout exposes `o:i` output columns. */
export function outputSortKeys(orderBy: readonly BoundOrderBy[]): L.SortKey[] {
  return orderBy.map((o) => ({ expr: o.expr, desc: o.desc, nullsFirst: o.nullsFirst }));
}

export type { BoundAggregate, BoundCte, BoundWindow };
export { outKey };
