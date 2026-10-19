/**
 * Logical rewrite rules, applied to a fixpoint:
 *  - constant folding of filter predicates (`WHERE 1` disappears, `WHERE 0` becomes an empty relation)
 *  - merging adjacent filters
 *  - outer-join simplification: a null-rejecting predicate above a LEFT/FULL join turns it into an INNER/LEFT join
 *  - predicate pushdown through joins (respecting null-extension of outer joins) and of one-sided ON conjuncts
 *  - DISTINCT elimination when the keys include a unique column of a single base relation
 *  - projection pruning: every scan learns which columns the rest of the plan needs (covering-index detection)
 */
import { evaluateConstant, isConstantExpr } from "../exec/expr.js";
import { truthy } from "../exec/functions.js";
import type { BoundExpr } from "../sql/bound.js";
import { conjoin, conjuncts, mapChildren, type SchemaLookup } from "./build.js";
import { allRefsAtDepth, directRefs, referencedRelations } from "./layout.js";
import * as L from "./logical.js";

export function optimize(plan: L.LNode, schema: SchemaLookup): L.LNode {
  let node = plan;
  for (let i = 0; i < 8; i++) {
    const before = node;
    node = rewrite(node, schema);
    if (node === before) break;
  }
  pruneProjections(node);
  return node;
}

/** One bottom-up pass of every rule. Returns the same object when nothing changed. */
function rewrite(n: L.LNode, schema: SchemaLookup): L.LNode {
  const inputs = L.inputsOf(n);
  const newInputs = inputs.map((i) => rewrite(i, schema));
  let node = newInputs.some((x, i) => x !== inputs[i]) ? L.withInputs(n, newInputs) : n;
  switch (node.kind) {
    case "filter": node = rewriteFilter(node); break;
    case "join": node = rewriteJoin(node); break;
    case "distinct": node = rewriteDistinct(node, schema); break;
    default: break;
  }
  return node;
}

// ----- filters -----

function foldPredicate(e: BoundExpr): BoundExpr {
  if (e.kind === "binary" && e.op === "AND") {
    const l = foldPredicate(e.left), r = foldPredicate(e.right);
    const lt = constTruth(l), rt = constTruth(r);
    if (lt === false || rt === false) return literal(0n);
    if (lt === true) return r;
    if (rt === true) return l;
    return l === e.left && r === e.right ? e : { ...e, left: l, right: r };
  }
  if (e.kind === "binary" && e.op === "OR") {
    const l = foldPredicate(e.left), r = foldPredicate(e.right);
    const lt = constTruth(l), rt = constTruth(r);
    if (lt === true || rt === true) return literal(1n);
    if (lt === false) return r;
    if (rt === false) return l;
    return l === e.left && r === e.right ? e : { ...e, left: l, right: r };
  }
  if (e.kind !== "literal" && isConstantExpr(e)) {
    try { return { kind: "literal", value: evaluateConstant(e), dataType: "ANY", loc: e.loc }; } catch { return e; }
  }
  return e;
}

/** true / false (NULL counts as false) for a constant predicate, undefined when not constant. */
function constTruth(e: BoundExpr): boolean | undefined {
  if (e.kind !== "literal") return undefined;
  return truthy(e.value) === true;
}

function literal(v: bigint): BoundExpr { return { kind: "literal", value: v, dataType: "INTEGER", loc: { line: 0, col: 0, offset: 0, end: 0 } }; }

function emptyLike(n: L.LNode): L.LNode {
  return { kind: "values", rows: [], columns: n.layout.slots.map((s) => ({ name: s.name, type: s.type, hidden: false })), layout: n.layout, rels: n.rels };
}

function rewriteFilter(f: L.LFilter): L.LNode {
  const pred = foldPredicate(f.predicate);
  const t = constTruth(pred);
  if (t === true) return f.input;
  if (t === false) return emptyLike(f);
  if (f.input.kind === "filter") return L.filter(f.input.input, conjoin([...conjuncts(f.input.predicate), ...conjuncts(pred)])!);
  if (f.input.kind === "values" && f.input.rows.length === 0) return f.input;
  if (f.input.kind === "join") return pushIntoJoin(f.input, conjuncts(pred));
  return pred === f.predicate ? f : L.filter(f.input, pred);
}

/** Pushes the conjuncts of a filter sitting above a join into the join / its sides. */
function pushIntoJoin(j: L.LJoin, preds: BoundExpr[]): L.LNode {
  let type = j.type;
  // outer-join simplification
  if (type === "LEFT" && preds.some((p) => isNullRejecting(p, j.right.rels))) type = "INNER";
  if (type === "FULL") {
    const rejL = preds.some((p) => isNullRejecting(p, j.left.rels)), rejR = preds.some((p) => isNullRejecting(p, j.right.rels));
    if (rejL && rejR) type = "INNER";
    else if (rejR) type = "LEFT";
    else if (rejL) { return pushIntoJoin(L.join("LEFT", j.right, j.left, j.condition), preds); }
  }
  const toLeft: BoundExpr[] = [], toRight: BoundExpr[] = [], toCond: BoundExpr[] = [], stay: BoundExpr[] = [];
  for (const p of preds) {
    const rels = referencedRelations(p);
    const inLeft = subset(rels, j.left.rels), inRight = subset(rels, j.right.rels);
    if (rels.size === 0) { (type === "INNER" ? toCond : stay).push(p); continue; }
    if (inLeft && (type === "INNER" || type === "LEFT" || type === "SEMI" || type === "ANTI")) toLeft.push(p);
    else if (inRight && type === "INNER") toRight.push(p);
    else if (type === "INNER") toCond.push(p);
    else stay.push(p);
  }
  if (toLeft.length === 0 && toRight.length === 0 && toCond.length === 0 && type === j.type) return L.filter(j, conjoin(preds)!);
  const left = toLeft.length ? L.filter(j.left, conjoin(toLeft)!) : j.left;
  const right = toRight.length ? L.filter(j.right, conjoin(toRight)!) : j.right;
  const cond = conjoin([...conjuncts(j.condition), ...toCond]);
  let node: L.LNode = L.join(type, left, right, cond);
  if (stay.length) node = L.filter(node, conjoin(stay)!);
  return node;
}

function subset(a: Set<number>, b: Set<number>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * A predicate is null-rejecting for `rels` when it cannot be true if every column of those relations is NULL.
 * Conservative: comparisons / LIKE / BETWEEN / IN-list / IS NOT NULL whose operands are built only from columns,
 * literals, parameters and arithmetic, with at least one operand column from `rels`.
 */
export function isNullRejecting(p: BoundExpr, rels: Set<number>): boolean {
  const strict = (e: BoundExpr): boolean => {
    switch (e.kind) {
      case "column": case "rowid": case "literal": case "param": return true;
      case "unary": return e.op !== "NOT" && strict(e.operand);
      case "binary": return e.op !== "AND" && e.op !== "OR" && !e.op.startsWith("IS") && strict(e.left) && strict(e.right);
      case "cast": return strict(e.expr);
      default: return false;
    }
  };
  const touches = (e: BoundExpr): boolean => directRefs(e).some((r) => r.depth === 0 && rels.has(r.relation));
  switch (p.kind) {
    case "binary":
      if (p.op === "AND") return isNullRejecting(p.left, rels) || isNullRejecting(p.right, rels);
      if (p.op === "OR") return isNullRejecting(p.left, rels) && isNullRejecting(p.right, rels);
      if (p.op === "IS" || p.op === "IS NOT" || p.op === "IS DISTINCT FROM" || p.op === "IS NOT DISTINCT FROM") return false;
      return strict(p.left) && strict(p.right) && touches(p);
    case "like": return strict(p.left) && strict(p.right) && touches(p);
    case "between": return strict(p.expr) && strict(p.low) && strict(p.high) && touches(p);
    case "in": return !!p.list && strict(p.expr) && touches(p.expr);
    case "isnull": return p.not && strict(p.expr) && touches(p.expr);
    case "column": return rels.has(p.relation) && p.depth === 0;
    default: return false;
  }
}

// ----- joins -----

/** Pushes one-sided ON conjuncts of INNER joins into the sides; for LEFT joins only right-side conjuncts move. */
function rewriteJoin(j: L.LJoin): L.LNode {
  if (!j.condition) return j;
  if (j.type !== "INNER" && j.type !== "LEFT" && j.type !== "SEMI" && j.type !== "ANTI") return j;
  const keep: BoundExpr[] = [], toLeft: BoundExpr[] = [], toRight: BoundExpr[] = [];
  for (const c of conjuncts(j.condition)) {
    const folded = foldPredicate(c);
    const t = constTruth(folded);
    if (t === true) continue;
    if (t === false) { if (j.type === "INNER" || j.type === "SEMI") return emptyLike(j); keep.push(folded); continue; }
    const rels = referencedRelations(folded);
    if (rels.size > 0 && subset(rels, j.right.rels) && (j.type === "INNER" || j.type === "LEFT" || j.type === "SEMI" || j.type === "ANTI")) toRight.push(folded);
    else if (rels.size > 0 && subset(rels, j.left.rels) && j.type === "INNER") toLeft.push(folded);
    else keep.push(folded);
  }
  if (toLeft.length === 0 && toRight.length === 0 && keep.length === conjuncts(j.condition).length) return j;
  const left = toLeft.length ? L.filter(j.left, conjoin(toLeft)!) : j.left;
  const right = toRight.length ? L.filter(j.right, conjoin(toRight)!) : j.right;
  return L.join(j.type, left, right, conjoin(keep));
}

// ----- DISTINCT -----

function rewriteDistinct(d: L.LDistinct, schema: SchemaLookup): L.LNode {
  const p = d.input;
  if (p.kind !== "project") return d;
  // find the single base relation below (no aggregates / windows / joins)
  let n: L.LNode = p.input;
  while (n.kind === "filter") n = n.input;
  if (n.kind !== "scan") return d;
  const uniqueCols = new Set<number>();
  if (n.table.schema.rowidColumn >= 0) uniqueCols.add(n.table.schema.rowidColumn);
  for (const ix of schema.listIndexInfos(n.table.schema.name)) if (ix.schema.unique && ix.schema.columns.length === 1 && !ix.where) uniqueCols.add(ix.schema.columns[0]!);
  for (let i = 0; i < d.keyCount; i++) {
    const e = p.exprs[i]!;
    if (e.kind === "rowid" && e.depth === 0 && e.relation === n.rel) return p;
    if (e.kind === "column" && e.depth === 0 && e.relation === n.rel && uniqueCols.has(e.column)) return p;
  }
  return d;
}

// ----- projection pruning -----

/** Records on every scan which of its columns the plan references (undefined = all). */
function pruneProjections(root: L.LNode): void {
  const used = new Map<number, Set<number> | "all">();
  const note = (rel: number, column: number): void => {
    const cur = used.get(rel);
    if (cur === "all") return;
    if (column < 0) { used.set(rel, "all"); return; }
    if (!cur) used.set(rel, new Set([column])); else cur.add(column);
  };
  const noteExpr = (e: BoundExpr): void => { for (const r of allRefsAtDepth(e, 0)) note(r.relation, r.kind === "rowid" ? -2 : r.column); };
  const visit = (n: L.LNode): void => {
    switch (n.kind) {
      case "filter": noteExpr(n.predicate); break;
      case "join": if (n.condition) noteExpr(n.condition); break;
      case "aggregate": n.groupBy.forEach(noteExpr); for (const a of n.aggs) { a.args.forEach(noteExpr); if (a.filter) noteExpr(a.filter); } for (const p of n.passthrough) note(p.relation, p.rowid ? -2 : p.column); break;
      case "window": for (const w of n.windows) noteExpr(w); break;
      case "project": n.exprs.forEach(noteExpr); break;
      case "sort": for (const k of n.keys) noteExpr(k.expr); break;
      case "limit": if (n.limit) noteExpr(n.limit); if (n.offset) noteExpr(n.offset); break;
      case "values": for (const r of n.rows) r.forEach(noteExpr); break;
      case "subquery": for (const r of allRefsAtDepth({ kind: "exists", not: false, subquery: { select: n.select, outerRefs: [], correlated: false }, dataType: "INTEGER", loc: { line: 0, col: 0, offset: 0, end: 0 } }, 0)) note(r.relation, r.kind === "rowid" ? -2 : r.column); break;
      default: break;
    }
    for (const i of L.inputsOf(n)) visit(i);
  };
  visit(root);
  // a scan with no projection above (e.g. the input of DML) needs everything
  const scans: L.LScan[] = [];
  const collect = (n: L.LNode): void => { if (n.kind === "scan") scans.push(n); for (const i of L.inputsOf(n)) collect(i); };
  collect(root);
  const topIsProjection = root.kind !== "scan" && root.kind !== "filter" && root.kind !== "join";
  for (const s of scans) {
    const u = used.get(s.rel);
    if (!topIsProjection || u === "all") { s.requiredColumns = undefined; continue; }
    const set = new Set<number>(u ?? []);
    // -2 marks the rowid; drop it from the column set but remember it is needed via the scan's rowid slot
    set.delete(-2);
    s.requiredColumns = set;
  }
}

export { mapChildren };
