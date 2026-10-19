/**
 * Semantic analysis: resolves names against a `SchemaProvider`, infers types, validates aggregates/windows/CTEs and
 * produces the bound tree described in `bound.ts`. All errors are `BindError`.
 *
 * Aggregate leniency: like SQLite, bare (non-aggregated, non-grouped) columns are allowed in the SELECT list of an
 * aggregate query; the executor picks the value from an arbitrary row of the group.
 */
import { BindError } from "../core/errors.js";
import type { ColumnDef, IndexSchema, TableSchema, Value } from "../core/types.js";
import type * as A from "./ast.js";
import { parseExpression, parseOne } from "./parser.js";
import type { SchemaProvider } from "./schema-provider.js";
import {
  affinityOf, columnDataType, type BoundAggregate, type BoundAlterTable, type BoundColumnRef, type BoundCte, type BoundExpr,
  type BoundFrameBound, type BoundFrom, type BoundInsert, type BoundOrderBy, type BoundProjection, type BoundRelation,
  type BoundRowid, type BoundSelect, type BoundSelectBody, type BoundSelectCore, type BoundStatement, type BoundSubquery,
  type BoundUpsert, type BoundWindow, type BoundWindowSpec, type CastTarget, type ExprType, type FunctionProvider,
  type ParameterInfo, type RelationColumn,
} from "./bound.js";

/** Options for `bind`. */
export interface BindOptions {
  /** Original SQL text; used to derive result column names from expression source (`SELECT a+1` -> "a+1"). */
  sql?: string;
}

/** Bind a parsed statement against the schema. */
export function bind(stmt: A.Statement, schema: SchemaProvider, functions: FunctionProvider, options: BindOptions = {}): BoundStatement {
  const params = new ParamCollector();
  params.prescan(stmt);
  const binder = new Binder(schema, functions, options.sql, params);
  return binder.bindStatement(stmt);
}

/** Convenience: bind a standalone expression (no relations in scope, e.g. a DEFAULT clause). */
export function bindExpression(expr: A.Expr, schema: SchemaProvider, functions: FunctionProvider): BoundExpr {
  const params = new ParamCollector();
  params.prescan(expr);
  const binder = new Binder(schema, functions, undefined, params);
  return binder.bindStandaloneExpr(expr);
}

// ───────────────────────────────── internals ─────────────────────────────────

/**
 * Assigns parameter slots with SQLite's rules, in order of appearance in the SQL text: `?` takes the next slot after
 * the highest used so far, `?NNN` takes slot NNN, named parameters reuse their first slot.
 */
class ParamCollector {
  max = 0;
  names = new Map<string, number>();
  slotNames: (string | undefined)[] = [];
  private readonly assigned = new Map<A.ParamExpr, number>();

  /** Pre-assign every parameter in `root` (any AST node) by source offset so clause binding order does not matter. */
  prescan(root: unknown): void {
    const params: A.ParamExpr[] = [];
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (node instanceof Uint8Array) return;
      if (Array.isArray(node)) { for (const x of node) visit(x); return; }
      const rec = node as Record<string, unknown>;
      if (rec["type"] === "param" && typeof rec["loc"] === "object") params.push(node as A.ParamExpr);
      for (const key of Object.keys(rec)) if (key !== "loc") visit(rec[key]);
    };
    visit(root);
    params.sort((a, b) => a.loc.offset - b.loc.offset);
    for (const p of params) this.assigned.set(p, this.assign(p));
  }

  resolve(e: A.ParamExpr): number {
    const pre = this.assigned.get(e);
    if (pre !== undefined) return pre;
    const idx = this.assign(e);
    this.assigned.set(e, idx);
    return idx;
  }

  private assign(e: A.ParamExpr): number {
    let idx: number;
    if (e.index !== undefined) { idx = e.index; if (idx < 1) throw err(`parameter index must be >= 1`, e.loc); if (idx > this.max) this.max = idx; }
    else if (e.name !== undefined) {
      const known = this.names.get(e.name);
      if (known !== undefined) idx = known;
      else { idx = ++this.max; this.names.set(e.name, idx); this.slotNames[idx - 1] = e.name; }
    } else idx = ++this.max;
    return idx - 1;
  }
  info(): ParameterInfo {
    const names: (string | undefined)[] = [];
    for (let i = 0; i < this.max; i++) names.push(this.slotNames[i]);
    return { count: this.max, names };
  }
}

interface CteEntry { cte: BoundCte; /** true while binding the recursive term of this CTE */ bindingRecursive: boolean }

class Scope {
  relations: BoundRelation[] = [];
  /** Correlated references resolved through this scope to an outer one (as seen from this scope). */
  outerRefs: BoundColumnRef[] = [];
  constructor(readonly parent: Scope | undefined, readonly ctes: Map<string, CteEntry>) {}
}

type Clause = "select" | "where" | "groupBy" | "having" | "orderBy" | "on" | "values" | "default" | "check" | "set" | "limit" | "returning" | "window" | "index";

interface CoreState {
  aggregates: BoundAggregate[];
  windows: BoundWindow[];
  namedWindows: Map<string, A.WindowSpec>;
  projections?: BoundProjection[];
  projectionAliases?: Map<string, number>;
}

interface ExprCtx {
  scope: Scope;
  clause: Clause;
  core?: CoreState;
  allowAggregates: boolean;
  allowWindows: boolean;
  allowColumns: boolean;
  allowSubqueries: boolean;
  inAggregate: boolean;
  inWindow: boolean;
  /** When set, unqualified names are tried against result aliases FIRST (ORDER BY) or LAST (GROUP BY/HAVING). */
  aliasMode?: "first" | "last";
}

function err(msg: string, loc: A.SourceLocation): BindError {
  return new BindError(`${msg} at ${loc.line}:${loc.col}`);
}

function eq(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

function literalType(v: Value): ExprType {
  if (v === null) return "NULL";
  switch (typeof v) {
    case "bigint": return "INTEGER";
    case "number": return "REAL";
    case "string": return "TEXT";
    case "boolean": return "BOOLEAN";
    default: return "BLOB";
  }
}

function numericResult(a: ExprType, b: ExprType): ExprType {
  if (a === "NULL" || b === "NULL") return "NULL";
  if (a === "REAL" || b === "REAL") return "REAL";
  if ((a === "INTEGER" || a === "BOOLEAN") && (b === "INTEGER" || b === "BOOLEAN")) return "INTEGER";
  return "ANY";
}

function commonType(types: ExprType[]): ExprType {
  let t: ExprType | undefined;
  for (const x of types) {
    if (x === "NULL") continue;
    if (t === undefined) t = x;
    else if (t !== x) return numericResult(t, x) === "REAL" ? "REAL" : "ANY";
  }
  return t ?? "NULL";
}

function castTargetOf(typeName: string, loc: A.SourceLocation): CastTarget {
  const a = affinityOf(typeName);
  if (typeName.trim() === "") throw err("expected type name in CAST", loc);
  return a;
}

/** True when the select statement's FROM clauses (at any depth) reference table `name`. */
function referencesTable(sel: A.SelectStmt, name: string): boolean {
  const body = (b: A.SelectBody): boolean => {
    switch (b.type) {
      case "compound": return body(b.left) || body(b.right);
      case "values": return b.rows.some((r) => r.some(expr));
      case "select": return (b.from ? from(b.from) : false) || (b.where ? expr(b.where) : false) || b.columns.some((c) => c.type === "expr" && expr(c.expr))
        || (b.groupBy?.some(expr) ?? false) || (b.having ? expr(b.having) : false);
    }
  };
  const from = (f: A.TableRef): boolean => {
    switch (f.type) {
      case "table": return eq(f.name, name);
      case "subquery": return referencesTable(f.select, name);
      case "join": return from(f.left) || from(f.right) || (f.on ? expr(f.on) : false);
    }
  };
  const expr = (e: A.Expr): boolean => {
    switch (e.type) {
      case "exists": return referencesTable(e.subquery, name);
      case "subquery": return referencesTable(e.subquery, name);
      case "in": return (e.subquery ? referencesTable(e.subquery, name) : false) || (e.table ? eq(e.table, name) : false) || expr(e.expr) || (e.list?.some(expr) ?? false);
      case "unary": return expr(e.operand);
      case "binary": return expr(e.left) || expr(e.right);
      case "like": return expr(e.left) || expr(e.right);
      case "between": return expr(e.expr) || expr(e.low) || expr(e.high);
      case "isnull": return expr(e.expr);
      case "case": return (e.operand ? expr(e.operand) : false) || e.whens.some((w) => expr(w.when) || expr(w.then)) || (e.else ? expr(e.else) : false);
      case "cast": case "collate": return expr(e.expr);
      case "function": return e.args.some(expr);
      default: return false;
    }
  };
  if (sel.with?.ctes.some((c) => eq(c.name, name))) return false; // shadowed by an inner CTE
  return body(sel.body);
}

class Binder {
  private readonly viewStack: string[] = [];

  constructor(
    private readonly schema: SchemaProvider,
    private readonly functions: FunctionProvider,
    private readonly sql: string | undefined,
    private readonly params: ParamCollector,
  ) {}

  private text(loc: A.SourceLocation, fallback: string): string {
    return this.sql ? this.sql.slice(loc.offset, loc.end) : fallback;
  }

  // ───────────────────────────── statements ─────────────────────────────

  bindStatement(stmt: A.Statement): BoundStatement {
    const rootCtes = new Map<string, CteEntry>();
    switch (stmt.type) {
      case "select": {
        const select = this.bindSelect(stmt, undefined, rootCtes);
        return { kind: "select", select, parameters: this.params.info(), loc: stmt.loc };
      }
      case "insert": return this.bindInsert(stmt, rootCtes);
      case "update": return this.bindUpdate(stmt, rootCtes);
      case "delete": return this.bindDelete(stmt, rootCtes);
      case "createTable": return this.bindCreateTable(stmt);
      case "createIndex": return this.bindCreateIndex(stmt);
      case "createView": return this.bindCreateView(stmt);
      case "drop": {
        let exists: boolean;
        if (stmt.object === "TABLE") exists = this.schema.getTable(stmt.name) !== undefined;
        else if (stmt.object === "VIEW") exists = this.schema.getView(stmt.name) !== undefined;
        else exists = this.indexExists(stmt.name);
        if (!exists && !stmt.ifExists) throw err(`no such ${stmt.object.toLowerCase()}: ${stmt.name}`, stmt.loc);
        return { kind: "drop", object: stmt.object, name: stmt.name, ifExists: stmt.ifExists, exists, parameters: this.params.info(), loc: stmt.loc };
      }
      case "alterTable": return this.bindAlter(stmt);
      case "begin": return { kind: "begin", mode: stmt.mode, parameters: this.params.info(), loc: stmt.loc };
      case "commit": return { kind: "commit", parameters: this.params.info(), loc: stmt.loc };
      case "rollback": return { kind: "rollback", savepoint: stmt.savepoint, parameters: this.params.info(), loc: stmt.loc };
      case "savepoint": return { kind: "savepoint", name: stmt.name, parameters: this.params.info(), loc: stmt.loc };
      case "release": return { kind: "release", name: stmt.name, parameters: this.params.info(), loc: stmt.loc };
      case "explain": {
        const inner = this.bindStatement(stmt.statement);
        return { kind: "explain", analyze: stmt.analyze, queryPlan: stmt.queryPlan, statement: inner, parameters: this.params.info(), loc: stmt.loc };
      }
      case "analyze":
        if (stmt.target !== undefined && !this.schema.tableExists(stmt.target) && !this.indexExists(stmt.target)) throw err(`no such table: ${stmt.target}`, stmt.loc);
        return { kind: "analyze", target: stmt.target, parameters: this.params.info(), loc: stmt.loc };
      case "vacuum": return { kind: "vacuum", parameters: this.params.info(), loc: stmt.loc };
      case "pragma": {
        let value: Value | undefined;
        if (stmt.value) {
          const b = this.bindStandaloneExpr(stmt.value);
          if (b.kind !== "literal") throw err("PRAGMA value must be a literal", stmt.value.loc);
          value = b.value;
        }
        return { kind: "pragma", name: stmt.name, value, assign: stmt.assign, parameters: this.params.info(), loc: stmt.loc };
      }
    }
  }

  private indexExists(name: string): boolean {
    return this.schema.getIndex(name) !== undefined;
  }

  bindStandaloneExpr(expr: A.Expr): BoundExpr {
    const scope = new Scope(undefined, new Map());
    return this.bindExpr(expr, this.ctx(scope, "values"));
  }

  private ctx(scope: Scope, clause: Clause, core?: CoreState): ExprCtx {
    return {
      scope, clause, core,
      allowAggregates: clause === "select" || clause === "having" || clause === "orderBy",
      allowWindows: clause === "select" || clause === "orderBy",
      allowColumns: clause !== "limit",
      allowSubqueries: clause !== "check" && clause !== "default" && clause !== "index",
      inAggregate: false, inWindow: false,
    };
  }

  // ───────────────────────────── SELECT ─────────────────────────────

  private bindCtes(w: A.WithClause | undefined, parentCtes: Map<string, CteEntry>, _scopeParent: Scope | undefined): { ctes: BoundCte[]; map: Map<string, CteEntry> } {
    const scopeParent = undefined; // CTE bodies cannot be correlated with the enclosing query
    const map = new Map(parentCtes);
    const ctes: BoundCte[] = [];
    if (!w) return { ctes, map };
    for (const c of w.ctes) {
      const key = c.name.toLowerCase();
      if (w.ctes.filter((x) => eq(x.name, c.name)).length > 1) throw err(`duplicate WITH table name: ${c.name}`, c.loc);
      const bound = this.bindCte(c, map, scopeParent);
      map.set(key, { cte: bound, bindingRecursive: false });
      ctes.push(bound);
    }
    return { ctes, map };
  }

  private bindCte(c: A.CommonTableExpr, visible: Map<string, CteEntry>, scopeParent: Scope | undefined): BoundCte {
    const selfRef = referencesTable(c.select, c.name);
    if (!selfRef) {
      const select = this.bindSelect(c.select, scopeParent, visible);
      const columns = this.applyColumnList(select.columns, c.columns, c.name, c.loc);
      return { name: c.name, columns, select, materialized: c.materialized };
    }
    // Recursive CTE: body must be `anchor UNION [ALL] recursive-term` (possibly several anchors).
    if (c.select.body.type !== "compound" || (c.select.body.op !== "UNION" && c.select.body.op !== "UNION ALL")) {
      throw err(`recursive CTE ${c.name} must be of the form "anchor UNION [ALL] recursive-term"`, c.loc);
    }
    const top = c.select.body;
    const anchorStmt: A.SelectStmt = { type: "select", with: c.select.with, body: top.left, loc: top.left.loc };
    const recursiveStmt: A.SelectStmt = { type: "select", body: top.right, loc: top.right.loc };
    if (referencesTable(anchorStmt, c.name)) throw err(`the anchor of recursive CTE ${c.name} may not reference ${c.name}`, top.left.loc);
    if (top.right.type !== "select") throw err(`the recursive term of CTE ${c.name} must be a SELECT`, top.right.loc);
    // bind the anchor on its own to learn the column shape
    const anchor = this.bindSelect(anchorStmt, scopeParent, visible);
    const columns = this.applyColumnList(anchor.columns, c.columns, c.name, c.loc);
    const placeholder: BoundCte = { name: c.name, columns, select: anchor, materialized: c.materialized };
    const inner = new Map(visible);
    inner.set(c.name.toLowerCase(), { cte: placeholder, bindingRecursive: true });
    const recursive = this.bindSelect(recursiveStmt, scopeParent, inner);
    if (recursive.body.kind !== "core") throw err(`the recursive term of CTE ${c.name} must be a simple SELECT`, top.right.loc);
    const selfRefs = recursive.body.relations.filter((r) => r.kind === "cte" && r.recursiveRef);
    if (selfRefs.length !== 1) throw err(`the recursive term of CTE ${c.name} must reference ${c.name} exactly once`, top.right.loc);
    if (recursive.body.aggregates.length > 0 || recursive.body.windows.length > 0) throw err(`the recursive term of CTE ${c.name} may not use aggregate or window functions`, top.right.loc);
    if (recursive.body.distinct) throw err(`the recursive term of CTE ${c.name} may not use DISTINCT`, top.right.loc);
    if (recursive.columns.length !== columns.length) throw err(`SELECTs to the left and right of ${top.op} do not have the same number of result columns`, top.loc);
    const body: BoundSelectBody = { kind: "compound", op: top.op, left: anchor.body, right: recursive.body };
    const whole: BoundSelect = {
      kind: "select", ctes: anchor.ctes, body, orderBy: [], columns, loc: c.select.loc,
    };
    // ORDER BY / LIMIT on the recursive CTE apply to the whole result.
    if (c.select.orderBy || c.select.limit) {
      const tailCtx = this.ctx(new Scope(scopeParent, visible), "orderBy");
      whole.orderBy = (c.select.orderBy ?? []).map((o) => this.bindCompoundOrderTerm(o, columns, tailCtx));
      if (c.select.limit) whole.limit = this.bindExpr(c.select.limit, this.ctx(new Scope(scopeParent, visible), "limit"));
      if (c.select.offset) whole.offset = this.bindExpr(c.select.offset, this.ctx(new Scope(scopeParent, visible), "limit"));
    }
    placeholder.select = whole;
    placeholder.recursive = { anchor: anchor.body, recursiveTerm: recursive.body, unionAll: top.op === "UNION ALL" };
    return placeholder;
  }

  private applyColumnList(cols: RelationColumn[], names: string[] | undefined, what: string, loc: A.SourceLocation): RelationColumn[] {
    if (!names) return cols.map((c) => ({ ...c, hidden: false }));
    if (names.length !== cols.length) throw err(`${what} has ${names.length} column names but ${cols.length} values`, loc);
    return names.map((n, i) => ({ name: n, type: cols[i]!.type, hidden: false }));
  }

  /** Bind a full select. `parent` is the enclosing scope (for correlation), `visibleCtes` the CTEs in scope. */
  bindSelect(stmt: A.SelectStmt, parent: Scope | undefined, visibleCtes: Map<string, CteEntry>): BoundSelect {
    const { ctes, map } = this.bindCtes(stmt.with, visibleCtes, parent);
    if (stmt.body.type === "select") {
      const scope = new Scope(parent, map);
      const core = this.bindCore(stmt.body, scope, stmt);
      const columns = core.projections.map((p) => ({ name: p.name, type: p.expr.dataType, hidden: false }));
      const result: BoundSelect = { kind: "select", ctes, body: core.body, orderBy: core.orderBy, columns, loc: stmt.loc };
      if (stmt.limit) result.limit = this.bindExpr(stmt.limit, this.ctx(scope, "limit"));
      if (stmt.offset) result.offset = this.bindExpr(stmt.offset, this.ctx(scope, "limit"));
      return result;
    }
    const body = this.bindBody(stmt.body, parent, map);
    const columns = bodyColumns(body);
    const scope = new Scope(parent, map);
    const orderBy = (stmt.orderBy ?? []).map((o) => this.bindCompoundOrderTerm(o, columns, this.ctx(scope, "orderBy")));
    const result: BoundSelect = { kind: "select", ctes, body, orderBy, columns, loc: stmt.loc };
    if (stmt.limit) result.limit = this.bindExpr(stmt.limit, this.ctx(scope, "limit"));
    if (stmt.offset) result.offset = this.bindExpr(stmt.offset, this.ctx(scope, "limit"));
    return result;
  }

  private bindCompoundOrderTerm(o: A.OrderingTerm, columns: RelationColumn[], ctx: ExprCtx): BoundOrderBy {
    let index: number | undefined;
    if (o.expr.type === "literal" && typeof o.expr.value === "bigint") {
      index = Number(o.expr.value) - 1;
      if (index < 0 || index >= columns.length) throw err(`ORDER BY term out of range - should be between 1 and ${columns.length}`, o.loc);
    } else if (o.expr.type === "column" && !o.expr.table) {
      const name = o.expr.name;
      index = columns.findIndex((c) => eq(c.name, name));
      if (index < 0) throw err(`ORDER BY term does not match any column in the result set: ${name}`, o.loc);
    } else {
      // SQLite permits expressions over result columns here; bind in a pseudo scope of result columns.
      const b = this.bindExpr(o.expr, { ...ctx, allowColumns: false });
      return { expr: b, desc: o.desc, nullsFirst: o.nulls ? o.nulls === "FIRST" : !o.desc, collation: o.collation };
    }
    const col = columns[index]!;
    return {
      expr: { kind: "resultColumn", index, dataType: col.type, loc: o.loc },
      desc: o.desc, nullsFirst: o.nulls ? o.nulls === "FIRST" : !o.desc, collation: o.collation, projectionIndex: index,
    };
  }

  private bindBody(body: A.SelectBody, parent: Scope | undefined, ctes: Map<string, CteEntry>): BoundSelectBody {
    switch (body.type) {
      case "select": {
        const scope = new Scope(parent, ctes);
        return this.bindCore(body, scope, undefined).body;
      }
      case "values": {
        const scope = new Scope(parent, ctes);
        const ctx = this.ctx(scope, "values");
        const width = body.rows[0]!.length;
        const rows = body.rows.map((r) => {
          if (r.length !== width) throw err("all VALUES must have the same number of terms", body.loc);
          return r.map((e) => this.bindExpr(e, ctx));
        });
        const columns: RelationColumn[] = [];
        for (let i = 0; i < width; i++) columns.push({ name: `column${i + 1}`, type: commonType(rows.map((r) => r[i]!.dataType)), hidden: false });
        return { kind: "values", rows, columns };
      }
      case "compound": {
        const left = this.bindBody(body.left, parent, ctes);
        const right = this.bindBody(body.right, parent, ctes);
        const lc = bodyColumns(left), rc = bodyColumns(right);
        if (lc.length !== rc.length) throw err(`SELECTs to the left and right of ${body.op} do not have the same number of result columns`, body.loc);
        return { kind: "compound", op: body.op, left, right };
      }
    }
  }

  /** Bind one SELECT core; when `stmt` is given, its ORDER BY is bound in the core's scope too. */
  private bindCore(core: A.SelectCore, scope: Scope, stmt: A.SelectStmt | undefined): { body: BoundSelectCore; projections: BoundProjection[]; orderBy: BoundOrderBy[] } {
    const state: CoreState = { aggregates: [], windows: [], namedWindows: new Map() };
    for (const w of core.windows ?? []) {
      if (state.namedWindows.has(w.name.toLowerCase())) throw err(`duplicate window name: ${w.name}`, w.spec.loc);
      state.namedWindows.set(w.name.toLowerCase(), w.spec);
    }
    // FROM (two passes: reserve relation slots, then bind derived tables and join conditions)
    let from: BoundFrom | undefined;
    if (core.from) {
      this.collectRelations(core.from, scope);
      from = this.bindFrom(core.from, scope).node;
    }
    const where = core.where ? this.bindExpr(core.where, this.ctx(scope, "where", state)) : undefined;
    // SELECT list
    const projections: BoundProjection[] = [];
    for (const rc of core.columns) {
      if (rc.type === "star") {
        if (scope.relations.length === 0) throw err("no tables specified", rc.loc);
        for (let r = 0; r < scope.relations.length; r++) this.expandStar(scope, r, projections, rc.loc);
      } else if (rc.type === "tableStar") {
        const r = scope.relations.findIndex((rel) => rel.alias !== undefined && eq(rel.alias, rc.table));
        if (r < 0) throw err(`no such table: ${rc.table}`, rc.loc);
        this.expandStar(scope, r, projections, rc.loc);
      } else {
        const expr = this.bindExpr(rc.expr, this.ctx(scope, "select", state));
        let name: string;
        if (rc.alias !== undefined) name = rc.alias;
        else if (rc.expr.type === "column") name = rc.expr.name;
        else name = this.text(rc.expr.loc, `column${projections.length + 1}`);
        projections.push({ expr, name });
      }
    }
    state.projections = projections;
    state.projectionAliases = new Map();
    core.columns.forEach((rc, i) => { if (rc.type === "expr" && rc.alias !== undefined) state.projectionAliases!.set(rc.alias.toLowerCase(), i); });
    // GROUP BY
    const groupBy: BoundExpr[] = [];
    for (const g of core.groupBy ?? []) {
      if (g.type === "literal" && typeof g.value === "bigint") {
        const idx = Number(g.value) - 1;
        if (idx < 0 || idx >= projections.length) throw err(`GROUP BY term out of range - should be between 1 and ${projections.length}`, g.loc);
        const p = projections[idx]!.expr;
        if (p.kind === "aggregate" || p.kind === "window") throw err("aggregate functions are not allowed in the GROUP BY clause", g.loc);
        groupBy.push(p);
      } else groupBy.push(this.bindExpr(g, { ...this.ctx(scope, "groupBy", state), aliasMode: "last" }));
    }
    // HAVING
    const having = core.having ? this.bindExpr(core.having, { ...this.ctx(scope, "having", state), aliasMode: "last" }) : undefined;
    if (having && groupBy.length === 0 && state.aggregates.length === 0) throw err("HAVING clause on a non-aggregate query", core.having!.loc);
    // ORDER BY (simple select: bound in this scope; aliases and ordinals allowed)
    const orderBy: BoundOrderBy[] = [];
    for (const o of stmt?.orderBy ?? []) {
      let projectionIndex: number | undefined;
      let expr: BoundExpr;
      if (o.expr.type === "literal" && typeof o.expr.value === "bigint") {
        projectionIndex = Number(o.expr.value) - 1;
        if (projectionIndex < 0 || projectionIndex >= projections.length) throw err(`ORDER BY term out of range - should be between 1 and ${projections.length}`, o.loc);
        expr = projections[projectionIndex]!.expr;
      } else {
        if (o.expr.type === "column" && !o.expr.table) {
          const k = state.projectionAliases.get(o.expr.name.toLowerCase());
          if (k !== undefined) projectionIndex = k;
        }
        expr = this.bindExpr(o.expr, { ...this.ctx(scope, "orderBy", state), aliasMode: "first" });
      }
      orderBy.push({ expr, desc: o.desc, nullsFirst: o.nulls ? o.nulls === "FIRST" : !o.desc, collation: o.collation, projectionIndex });
    }
    const body: BoundSelectCore = {
      kind: "core", relations: scope.relations, from, where, groupBy, having,
      aggregates: state.aggregates, windows: state.windows, distinct: core.distinct, projections, outerRefs: scope.outerRefs,
    };
    return { body, projections, orderBy };
  }

  private expandStar(scope: Scope, r: number, out: BoundProjection[], loc: A.SourceLocation): void {
    const rel = scope.relations[r]!;
    rel.columns.forEach((c, i) => {
      if (c.hidden) return;
      out.push({ expr: { kind: "column", depth: 0, relation: r, rel: r, column: i, name: c.name, table: rel.alias, dataType: c.type, loc }, name: c.name });
    });
  }

  // ───────────────────────────── FROM ─────────────────────────────

  /** Pass 1: create a relation slot for every leaf so the scope's relation count is final before binding expressions. */
  private collectRelations(ref: A.TableRef, scope: Scope): void {
    switch (ref.type) {
      case "join": this.collectRelations(ref.left, scope); this.collectRelations(ref.right, scope); return;
      case "subquery": {
        // placeholder; filled in bindFrom
        scope.relations.push({ kind: "subquery", alias: ref.alias, select: undefined as unknown as BoundSelect, columns: [] });
        return;
      }
      case "table": {
        const rel = this.resolveTableRef(ref, scope);
        const alias = rel.alias;
        if (alias !== undefined && scope.relations.some((x) => x.alias !== undefined && eq(x.alias, alias))) throw err(`ambiguous table name or alias: ${alias}`, ref.loc);
        scope.relations.push(rel);
        return;
      }
    }
  }

  private resolveTableRef(ref: Extract<A.TableRef, { type: "table" }>, scope: Scope): BoundRelation {
    const alias = ref.alias ?? ref.name;
    const cteEntry = ref.schema ? undefined : scope.ctes.get(ref.name.toLowerCase());
    if (cteEntry) {
      return { kind: "cte", alias, name: cteEntry.cte.name, cte: cteEntry.cte, recursiveRef: cteEntry.bindingRecursive, columns: cteEntry.cte.columns.map((c) => ({ ...c, hidden: false })) };
    }
    const table = this.schema.getTable(ref.name);
    if (table) {
      const columns: RelationColumn[] = table.columns.map((c) => ({ name: c.name, type: c.type, hidden: false }));
      if (ref.indexedBy) {
        if (!this.schema.listIndexes(table.name).some((i) => eq(i.name, ref.indexedBy!))) throw err(`no such index: ${ref.indexedBy}`, ref.loc);
      }
      return { kind: "table", alias, table, columns, indexedBy: ref.indexedBy };
    }
    const view = this.schema.getView(ref.name);
    if (view) {
      if (this.viewStack.some((v) => eq(v, view.name))) throw err(`view ${view.name} is circularly defined`, ref.loc);
      const parsed = parseOne(view.sql);
      if (parsed.type !== "select") throw err(`view ${view.name} is not defined by a SELECT`, ref.loc);
      this.viewStack.push(view.name);
      const sub = new Binder(this.schema, this.functions, view.sql, this.params);
      sub.viewStack.push(...this.viewStack);
      const select = sub.bindSelect(parsed, undefined, new Map());
      this.viewStack.pop();
      const columns = this.applyColumnList(select.columns, view.columns, view.name, ref.loc);
      return { kind: "view", alias, name: view.name, select, columns };
    }
    throw err(`no such table: ${ref.name}`, ref.loc);
  }

  /** Pass 2: bind derived tables and join conditions; returns the join tree and the relation indexes it covers. */
  private bindFrom(ref: A.TableRef, scope: Scope, cursor = { next: 0 }): { node: BoundFrom; rels: number[] } {
    switch (ref.type) {
      case "table": {
        const index = cursor.next++;
        return { node: { kind: "relation", index }, rels: [index] };
      }
      case "subquery": {
        const index = cursor.next++;
        const select = this.bindSelect(ref.select, scope, scope.ctes);
        const rel = scope.relations[index]!;
        if (rel.kind !== "subquery") throw new BindError("internal: relation slot mismatch");
        rel.select = select;
        rel.columns = select.columns.map((c) => ({ ...c, hidden: false }));
        if (rel.alias !== undefined && scope.relations.some((x, i) => i !== index && x.alias !== undefined && eq(x.alias, rel.alias!))) {
          throw err(`ambiguous table name or alias: ${rel.alias}`, ref.loc);
        }
        return { node: { kind: "relation", index }, rels: [index] };
      }
      case "join": {
        const left = this.bindFrom(ref.left, scope, cursor);
        const right = this.bindFrom(ref.right, scope, cursor);
        const rels = [...left.rels, ...right.rels];
        let condition: BoundExpr | undefined;
        const using: Extract<BoundFrom, { kind: "join" }>["using"] = [];
        let usingNames = ref.using;
        if (ref.natural) {
          usingNames = [];
          const leftNames = new Set<string>();
          for (const r of left.rels) for (const c of scope.relations[r]!.columns) if (!c.hidden) leftNames.add(c.name.toLowerCase());
          for (const r of right.rels) for (const c of scope.relations[r]!.columns) if (!c.hidden && leftNames.has(c.name.toLowerCase())) usingNames.push(c.name);
        }
        if (usingNames) {
          for (const name of usingNames) {
            const l = this.findColumnIn(scope, left.rels, name, ref.loc);
            const r = this.findColumnIn(scope, right.rels, name, ref.loc);
            // hide the duplicate column: the right side's copy (left's for RIGHT JOIN)
            const hideRight = ref.joinType !== "RIGHT";
            const hidden = hideRight ? r : l;
            scope.relations[hidden.relation]!.columns[hidden.column]!.hidden = true;
            using.push({ name, left: l, right: r });
            const equality: BoundExpr = { kind: "binary", op: "=", left: l, right: r, dataType: "INTEGER", loc: ref.loc };
            condition = condition ? { kind: "binary", op: "AND", left: condition, right: equality, dataType: "INTEGER", loc: ref.loc } : equality;
          }
        } else if (ref.on) {
          condition = this.bindExpr(ref.on, this.ctx(scope, "on"));
        }
        return { node: { kind: "join", joinType: ref.joinType, left: left.node, right: right.node, condition, using }, rels };
      }
    }
  }

  private findColumnIn(scope: Scope, rels: number[], name: string, loc: A.SourceLocation): BoundColumnRef {
    let found: BoundColumnRef | undefined;
    for (const r of rels) {
      const rel = scope.relations[r]!;
      rel.columns.forEach((c, i) => {
        if (c.hidden || !eq(c.name, name)) return;
        if (found) throw err(`ambiguous column name in USING: ${name}`, loc);
        found = { kind: "column", depth: 0, relation: r, rel: r, column: i, name: c.name, table: rel.alias, dataType: c.type, loc };
      });
    }
    if (!found) throw err(`cannot join using column ${name} - column not present in both tables`, loc);
    return found;
  }

  // ───────────────────────────── expressions ─────────────────────────────

  bindExpr(e: A.Expr, ctx: ExprCtx): BoundExpr {
    switch (e.type) {
      case "literal": return { kind: "literal", value: e.value, dataType: literalType(e.value), loc: e.loc };
      case "param": return { kind: "param", index: this.params.resolve(e), name: e.name, dataType: "ANY", loc: e.loc };
      case "column": return this.bindColumn(e, ctx);
      case "unary": {
        const operand = this.bindExpr(e.operand, ctx);
        let dataType: ExprType;
        if (e.op === "NOT") dataType = "INTEGER";
        else if (e.op === "~") dataType = operand.dataType === "NULL" ? "NULL" : "INTEGER";
        else if (e.op === "+") dataType = operand.dataType;
        else dataType = numericResult(operand.dataType, "INTEGER") === "ANY" ? "ANY" : (operand.dataType === "REAL" ? "REAL" : operand.dataType === "NULL" ? "NULL" : "INTEGER");
        return { kind: "unary", op: e.op, operand, dataType, loc: e.loc };
      }
      case "binary": {
        const left = this.bindExpr(e.left, ctx);
        const right = this.bindExpr(e.right, ctx);
        let dataType: ExprType;
        switch (e.op) {
          case "||": dataType = (left.dataType === "NULL" || right.dataType === "NULL") ? "NULL" : "TEXT"; break;
          case "+": case "-": case "*": dataType = numericResult(left.dataType, right.dataType); break;
          case "/": dataType = numericResult(left.dataType, right.dataType); break;
          case "%": case "<<": case ">>": case "&": case "|": dataType = (left.dataType === "NULL" || right.dataType === "NULL") ? "NULL" : (left.dataType === "REAL" || right.dataType === "REAL") && e.op === "%" ? "REAL" : "INTEGER"; break;
          default: dataType = "INTEGER"; // comparisons, IS, AND, OR
        }
        return { kind: "binary", op: e.op, left, right, dataType, loc: e.loc };
      }
      case "like": {
        if (e.op === "REGEXP" || e.op === "MATCH") throw err(`unable to use function ${e.op} in the requested context (no such function: ${e.op})`, e.loc);
        const left = this.bindExpr(e.left, ctx), right = this.bindExpr(e.right, ctx);
        const escape = e.escape ? this.bindExpr(e.escape, ctx) : undefined;
        return { kind: "like", op: e.op, not: e.not, left, right, escape, dataType: "INTEGER", loc: e.loc };
      }
      case "between": return { kind: "between", not: e.not, expr: this.bindExpr(e.expr, ctx), low: this.bindExpr(e.low, ctx), high: this.bindExpr(e.high, ctx), dataType: "INTEGER", loc: e.loc };
      case "in": {
        const expr = this.bindExpr(e.expr, ctx);
        if (e.list) return { kind: "in", not: e.not, expr, list: e.list.map((x) => this.bindExpr(x, ctx)), dataType: "INTEGER", loc: e.loc };
        let sub: A.SelectStmt;
        if (e.subquery) sub = e.subquery;
        else {
          // `x IN tablename` ≡ `x IN (SELECT * FROM tablename)`
          sub = { type: "select", body: { type: "select", distinct: false, columns: [{ type: "star", loc: e.loc }], from: { type: "table", name: e.table!, loc: e.loc }, loc: e.loc }, loc: e.loc };
        }
        const subquery = this.bindSubquery(sub, ctx);
        if (subquery.select.columns.length !== 1) throw err("sub-select returns " + subquery.select.columns.length + " columns - expected 1", e.loc);
        return { kind: "in", not: e.not, expr, subquery, dataType: "INTEGER", loc: e.loc };
      }
      case "isnull": return { kind: "isnull", not: e.not, expr: this.bindExpr(e.expr, ctx), dataType: "INTEGER", loc: e.loc };
      case "case": {
        const operand = e.operand ? this.bindExpr(e.operand, ctx) : undefined;
        const whens = e.whens.map((w) => ({ when: this.bindExpr(w.when, ctx), then: this.bindExpr(w.then, ctx) }));
        const elseExpr = e.else ? this.bindExpr(e.else, ctx) : undefined;
        const types = whens.map((w) => w.then.dataType);
        if (elseExpr) types.push(elseExpr.dataType);
        return { kind: "case", operand, whens, else: elseExpr, dataType: commonType(types), loc: e.loc };
      }
      case "cast": {
        const target = castTargetOf(e.typeName, e.loc);
        const expr = this.bindExpr(e.expr, ctx);
        const dataType: ExprType = target === "NUMERIC" ? (expr.dataType === "REAL" ? "REAL" : expr.dataType === "INTEGER" ? "INTEGER" : "ANY") : target;
        return { kind: "cast", expr, target, dataType, loc: e.loc };
      }
      case "collate": return this.bindExpr(e.expr, ctx); // collations are accepted and ignored (BINARY only)
      case "exists": {
        if (!ctx.allowSubqueries) throw err("subqueries are not allowed in this context", e.loc);
        return { kind: "exists", not: e.not, subquery: this.bindSubquery(e.subquery, ctx), dataType: "INTEGER", loc: e.loc };
      }
      case "subquery": {
        if (!ctx.allowSubqueries) throw err("subqueries are not allowed in this context", e.loc);
        const subquery = this.bindSubquery(e.subquery, ctx);
        if (subquery.select.columns.length !== 1) throw err("sub-select returns " + subquery.select.columns.length + " columns - expected 1", e.loc);
        return { kind: "subquery", subquery, dataType: subquery.select.columns[0]!.type, loc: e.loc };
      }
      case "function": return this.bindFunction(e, ctx);
      case "raise": throw err("RAISE() may only be used within a trigger-program", e.loc);
    }
  }

  private bindSubquery(sel: A.SelectStmt, ctx: ExprCtx): BoundSubquery {
    const select = this.bindSelect(sel, ctx.scope, ctx.scope.ctes);
    // Correlated refs were recorded on the subquery's own scope(s) during resolution (and, with adjusted depth,
    // on every scope they pass through - including ctx.scope - by `recordOuterRef`).
    const outerRefs: BoundColumnRef[] = [];
    collectOuterRefs(select.body, outerRefs);
    return { select, outerRefs, correlated: outerRefs.length > 0 };
  }

  private bindColumn(e: A.ColumnExpr, ctx: ExprCtx): BoundExpr {
    if (!ctx.allowColumns) throw err(`column references are not allowed in a ${ctx.clause.toUpperCase()} clause: ${e.name}`, e.loc);
    const aliasRef = (): BoundExpr | undefined => {
      if (e.table || !ctx.core?.projectionAliases || !ctx.core.projections) return undefined;
      const idx = ctx.core.projectionAliases.get(e.name.toLowerCase());
      if (idx === undefined) return undefined;
      const p = ctx.core.projections[idx]!.expr;
      if (ctx.clause === "groupBy" && (p.kind === "aggregate" || p.kind === "window")) throw err("aggregate functions are not allowed in the GROUP BY clause", e.loc);
      return p;
    };
    if (ctx.aliasMode === "first") { const a = aliasRef(); if (a) return a; }
    // rowid aliases
    const lower = e.name.toLowerCase();
    const isRowid = lower === "rowid" || lower === "_rowid_" || lower === "oid";
    let depth = 0, flatBase = 0;
    for (let scope: Scope | undefined = ctx.scope; scope; scope = scope.parent, depth++) {
      let found: { relation: number; column: number; col: RelationColumn; alias: string | undefined } | undefined;
      let rowidRel: number | undefined;
      scope.relations.forEach((rel, r) => {
        if (e.table !== undefined && !(rel.alias !== undefined && eq(rel.alias, e.table))) return;
        rel.columns.forEach((c, i) => {
          if (c.hidden && e.table === undefined) return;
          if (!eq(c.name, e.name)) return;
          if (found) throw err(`ambiguous column name: ${e.table ? e.table + "." : ""}${e.name}`, e.loc);
          found = { relation: r, column: i, col: c, alias: rel.alias };
        });
        if (!found && isRowid && rel.kind === "table") {
          if (rowidRel !== undefined) throw err(`ambiguous column name: ${e.name}`, e.loc);
          rowidRel = r;
        }
      });
      if (found) {
        const ref: BoundColumnRef = { kind: "column", depth, relation: found.relation, rel: flatBase + found.relation, column: found.column, name: found.col.name, table: found.alias, dataType: found.col.type, loc: e.loc };
        this.recordOuterRef(ctx.scope, ref);
        return ref;
      }
      if (rowidRel !== undefined) {
        const rel = scope.relations[rowidRel]!;
        if (rel.kind === "table" && rel.table.rowidColumn >= 0) {
          const c = rel.table.columns[rel.table.rowidColumn]!;
          const ref: BoundColumnRef = { kind: "column", depth, relation: rowidRel, rel: flatBase + rowidRel, column: rel.table.rowidColumn, name: c.name, table: rel.alias, dataType: "INTEGER", loc: e.loc };
          this.recordOuterRef(ctx.scope, ref);
          return ref;
        }
        const ref: BoundRowid = { kind: "rowid", depth, relation: rowidRel, rel: flatBase + rowidRel, dataType: "INTEGER", loc: e.loc };
        return ref;
      }
      flatBase += scope.relations.length;
    }
    if (ctx.aliasMode === "last") { const a = aliasRef(); if (a) return a; }
    throw err(`no such column: ${e.table ? e.table + "." : ""}${e.name}`, e.loc);
  }

  /** Record a correlated reference on every scope it passes through (depth adjusted per scope). */
  private recordOuterRef(from: Scope, ref: BoundColumnRef): void {
    if (ref.depth === 0) return;
    let scope: Scope | undefined = from;
    let rel = ref.rel, depth = ref.depth;
    while (scope && depth > 0) {
      scope.outerRefs.push({ ...ref, depth, rel });
      rel -= scope.relations.length;
      depth--;
      scope = scope.parent;
    }
  }

  private bindFunction(e: A.FunctionExpr, ctx: ExprCtx): BoundExpr {
    const info = this.functions.lookup(e.name);
    if (!info) throw err(`no such function: ${e.name}`, e.loc);
    const argc = e.args.length;
    const fits = (a: { minArgs: number; maxArgs: number } | undefined): boolean => !!a && argc >= a.minArgs && (a.maxArgs < 0 || argc <= a.maxArgs);
    if (e.star && e.name !== "count") throw err(`${e.name}(*) is not valid`, e.loc);

    if (e.over !== undefined) {
      if (!ctx.allowWindows) throw err(`misuse of window function ${e.name}()`, e.loc);
      if (ctx.inWindow || ctx.inAggregate) throw err(`window functions may not be nested: ${e.name}()`, e.loc);
      const isAggregate = !info.window && !!info.aggregate;
      const arity = info.window ?? info.aggregate;
      if (!arity) throw err(`${e.name}() may not be used as a window function`, e.loc);
      if (e.star) { if (e.name !== "count") throw err(`${e.name}(*) is not valid`, e.loc); }
      else if (!fits(arity)) throw err(`wrong number of arguments to function ${e.name}()`, e.loc);
      if (e.distinct && !isAggregate) throw err(`DISTINCT is not supported for window function ${e.name}()`, e.loc);
      const inner: ExprCtx = { ...ctx, inWindow: true, allowWindows: false };
      const args = e.args.map((a) => this.bindExpr(a, inner));
      const filter = e.filter ? this.bindExpr(e.filter, inner) : undefined;
      if (filter && !isAggregate) throw err(`FILTER clause may only be used with aggregate window functions`, e.loc);
      const spec = this.bindWindowSpec(e.over, ctx, e.loc);
      const core = ctx.core;
      if (!core) throw err(`misuse of window function ${e.name}()`, e.loc);
      const node: BoundWindow = {
        kind: "window", name: e.name, isAggregate, args, distinct: e.distinct, filter, spec, index: core.windows.length,
        dataType: info.returnType(args.map((a) => a.dataType), isAggregate ? "aggregate" : "window"), loc: e.loc,
      };
      core.windows.push(node);
      return node;
    }

    const scalarFits = fits(info.scalar);
    const aggregateFits = fits(info.aggregate) || (e.star && e.name === "count");
    if (info.aggregate && (!info.scalar || !scalarFits)) {
      if (e.distinct && argc !== 1) throw err("DISTINCT aggregates must have exactly one argument", e.loc);
      if (!aggregateFits) throw err(`wrong number of arguments to function ${e.name}()`, e.loc);
      if (!ctx.allowAggregates || !ctx.core) throw err(`misuse of aggregate function ${e.name}()`, e.loc);
      if (ctx.inAggregate) throw err(`misuse of aggregate function ${e.name}()`, e.loc);
      // aggregates inside window arguments / specs are allowed: the window runs over the aggregated rows (SQLite)
      if (e.distinct && argc !== 1) throw err("DISTINCT aggregates must have exactly one argument", e.loc);
      const inner: ExprCtx = { ...ctx, inAggregate: true, allowWindows: false, aliasMode: undefined };
      const args = e.args.map((a) => this.bindExpr(a, inner));
      const filter = e.filter ? this.bindExpr(e.filter, inner) : undefined;
      const node: BoundAggregate = {
        kind: "aggregate", name: e.name, args, distinct: e.distinct, star: e.star, filter, index: ctx.core.aggregates.length,
        dataType: info.returnType(args.map((a) => a.dataType), "aggregate"), loc: e.loc,
      };
      ctx.core.aggregates.push(node);
      return node;
    }
    if (e.star) throw err(`${e.name}(*) is not valid`, e.loc);
    if (!info.scalar) throw err(`${e.name}() may only be used as a window function`, e.loc);
    if (!scalarFits) throw err(`wrong number of arguments to function ${e.name}()`, e.loc);
    if (e.distinct) throw err(`DISTINCT is only valid for aggregate functions: ${e.name}()`, e.loc);
    if (e.filter) throw err(`FILTER clause is only valid for aggregate functions: ${e.name}()`, e.loc);
    const args = e.args.map((a) => this.bindExpr(a, ctx));
    return { kind: "function", name: e.name, args, dataType: info.returnType(args.map((a) => a.dataType), "scalar"), loc: e.loc };
  }

  private bindWindowSpec(over: A.WindowSpec | string, ctx: ExprCtx, loc: A.SourceLocation): BoundWindowSpec {
    const core = ctx.core;
    let spec: A.WindowSpec;
    if (typeof over === "string") {
      const named = core?.namedWindows.get(over.toLowerCase());
      if (!named) throw err(`no such window: ${over}`, loc);
      spec = named;
    } else spec = over;
    // resolve base window chain
    let partitionBy = spec.partitionBy, orderBy = spec.orderBy, frame = spec.frame;
    const seen = new Set<string>();
    for (let base = spec.baseName; base; ) {
      const key = base.toLowerCase();
      if (seen.has(key)) throw err(`circular window definition: ${base}`, spec.loc);
      seen.add(key);
      const named = core?.namedWindows.get(key);
      if (!named) throw err(`no such window: ${base}`, spec.loc);
      if (partitionBy.length === 0) partitionBy = named.partitionBy;
      else if (named.partitionBy.length > 0) throw err("cannot override PARTITION clause of window", spec.loc);
      if (orderBy.length === 0) orderBy = named.orderBy;
      else if (named.orderBy.length > 0) throw err("cannot override ORDER BY clause of window", spec.loc);
      if (!frame) frame = named.frame;
      base = named.baseName;
    }
    const inner: ExprCtx = { ...ctx, clause: "window", inWindow: true, allowWindows: false, aliasMode: undefined };
    const bindBound = (b: A.FrameBound): BoundFrameBound => {
      if (b.kind === "preceding" || b.kind === "following") {
        const offset = this.bindExpr(b.offset, { ...inner, allowColumns: false });
        if (offset.kind === "literal") {
          const v = offset.value;
          if (!((typeof v === "bigint" && v >= 0n) || (typeof v === "number" && v >= 0))) throw err("frame starting offset must be a non-negative integer", b.offset.loc);
        } else if (offset.kind !== "param") throw err("frame offset must be a constant", b.offset.loc);
        return { kind: b.kind, offset };
      }
      return b;
    };
    const boundFrame = frame ? { unit: frame.unit, start: bindBound(frame.start), end: bindBound(frame.end), exclude: frame.exclude } : undefined;
    if (boundFrame) {
      const order = (b: BoundFrameBound): number => b.kind === "unboundedPreceding" ? 0 : b.kind === "preceding" ? 1 : b.kind === "currentRow" ? 2 : b.kind === "following" ? 3 : 4;
      if (order(boundFrame.start) > order(boundFrame.end)) throw err("unsupported frame specification", spec.loc);
      if (boundFrame.unit === "RANGE" && orderBy.length !== 1 && (boundFrame.start.kind === "preceding" || boundFrame.start.kind === "following" || boundFrame.end.kind === "preceding" || boundFrame.end.kind === "following")) {
        throw err("RANGE with offset PRECEDING/FOLLOWING requires exactly one ORDER BY expression", spec.loc);
      }
    }
    return {
      partitionBy: partitionBy.map((p) => this.bindExpr(p, inner)),
      orderBy: orderBy.map((o) => ({ expr: this.bindExpr(o.expr, inner), desc: o.desc, nullsFirst: o.nulls ? o.nulls === "FIRST" : !o.desc, collation: o.collation })),
      frame: boundFrame,
    };
  }

  // ───────────────────────────── DML ─────────────────────────────

  private targetTable(name: string, loc: A.SourceLocation): TableSchema {
    const table = this.schema.getTable(name);
    if (!table) {
      if (this.schema.getView(name)) throw err(`cannot modify ${name} because it is a view`, loc);
      throw err(`no such table: ${name}`, loc);
    }
    return table;
  }

  private tableRelation(table: TableSchema, alias: string): BoundRelation {
    return { kind: "table", alias, table, columns: table.columns.map((c) => ({ name: c.name, type: c.type, hidden: false })) };
  }

  private columnIndex(table: TableSchema, name: string, loc: A.SourceLocation): number {
    const i = table.columns.findIndex((c) => eq(c.name, name));
    if (i < 0) throw err(`table ${table.name} has no column named ${name}`, loc);
    return i;
  }

  private bindDefaults(table: TableSchema): (BoundExpr | null)[] {
    return table.columns.map((c) => (c.defaultSql === undefined ? null : this.bindDefaultSql(c.defaultSql)));
  }

  private bindDefaultSql(sql: string): BoundExpr {
    return this.bindDefaultExpr(parseExpression(sql));
  }

  /**
   * DEFAULT: constants only. For the unparenthesized form a bare identifier is taken as a string literal
   * (`DEFAULT foo` ≡ `DEFAULT 'foo'`, a SQLite quirk); `DEFAULT (foo)` is an error because `foo` is not constant.
   */
  private bindDefaultExpr(e: A.Expr, bareIdentIsText = true): BoundExpr {
    if (bareIdentIsText && e.type === "column" && !e.table) return { kind: "literal", value: e.name, dataType: "TEXT", loc: e.loc };
    const scope = new Scope(undefined, new Map());
    const b = this.bindExpr(e, { ...this.ctx(scope, "default"), allowColumns: false, allowSubqueries: false });
    return b;
  }

  private bindReturning(cols: A.ResultColumn[] | undefined, scope: Scope): BoundProjection[] | undefined {
    if (!cols) return undefined;
    const out: BoundProjection[] = [];
    const state: CoreState = { aggregates: [], windows: [], namedWindows: new Map() };
    for (const rc of cols) {
      if (rc.type === "star") this.expandStar(scope, 0, out, rc.loc);
      else if (rc.type === "tableStar") {
        const r = scope.relations.findIndex((rel) => rel.alias !== undefined && eq(rel.alias, rc.table));
        if (r < 0) throw err(`no such table: ${rc.table}`, rc.loc);
        this.expandStar(scope, r, out, rc.loc);
      } else {
        const expr = this.bindExpr(rc.expr, { ...this.ctx(scope, "returning", state), allowAggregates: false, allowWindows: false });
        out.push({ expr, name: rc.alias ?? (rc.expr.type === "column" ? rc.expr.name : this.text(rc.expr.loc, `column${out.length + 1}`)) });
      }
    }
    return out;
  }

  private bindInsert(stmt: A.InsertStmt, rootCtes: Map<string, CteEntry>): BoundInsert {
    const { ctes, map } = this.bindCtes(stmt.with, rootCtes, undefined);
    const table = this.targetTable(stmt.table, stmt.loc);
    let columns: number[];
    if (stmt.columns) {
      columns = stmt.columns.map((c) => this.columnIndex(table, c, stmt.loc));
      const dup = columns.find((c, i) => columns.indexOf(c) !== i);
      if (dup !== undefined) throw err(`column ${table.columns[dup]!.name} specified more than once`, stmt.loc);
    } else columns = table.columns.map((_, i) => i);
    let source: BoundInsert["source"];
    const check = (n: number, loc: A.SourceLocation): void => {
      if (n !== columns.length) throw err(`table ${table.name} has ${stmt.columns ? columns.length + " columns specified" : table.columns.length + " columns"} but ${n} values were supplied`, loc);
    };
    if (stmt.defaultValues) source = { kind: "defaults" };
    else if (stmt.values) {
      const scope = new Scope(undefined, map);
      const ctx = this.ctx(scope, "values");
      source = { kind: "values", rows: stmt.values.map((r) => { check(r.length, stmt.loc); return r.map((e) => this.bindExpr(e, ctx)); }) };
    } else {
      const select = this.bindSelect(stmt.select!, undefined, map);
      check(select.columns.length, stmt.select!.loc);
      source = { kind: "select", select };
    }
    const defaults = this.bindDefaults(table);
    const alias = stmt.alias ?? table.name;
    const returnScope = new Scope(undefined, map);
    returnScope.relations.push(this.tableRelation(table, alias));
    let upsert: BoundUpsert | undefined;
    if (stmt.upsert) {
      const u = stmt.upsert;
      const target = u.target.map((c) => this.columnIndex(table, c, u.loc));
      const upScope = new Scope(undefined, map);
      upScope.relations.push(this.tableRelation(table, alias));
      // unqualified names in DO UPDATE resolve to the target row; `excluded.col` must be qualified (SQLite)
      const excluded = this.tableRelation(table, "excluded");
      for (const c of excluded.columns) c.hidden = true;
      upScope.relations.push(excluded);
      const uctx = this.ctx(upScope, "set");
      upsert = { target };
      if (u.targetWhere) upsert.targetWhere = this.bindExpr(u.targetWhere, this.ctx(returnScope, "where"));
      if (u.set) {
        upsert.set = u.set.map((s) => ({ column: this.columnIndex(table, s.column, u.loc), expr: this.bindExpr(s.value, uctx) }));
        const dup = upsert.set.find((s, i) => upsert!.set!.findIndex((x) => x.column === s.column) !== i);
        if (dup) throw err(`column ${table.columns[dup.column]!.name} assigned more than once in ON CONFLICT DO UPDATE`, u.loc);
      }
      if (u.where) upsert.where = this.bindExpr(u.where, uctx);
    }
    const returning = this.bindReturning(stmt.returning, returnScope);
    return { kind: "insert", table, or: stmt.or, columns, source, defaults, upsert, returning, ctes, parameters: this.params.info(), loc: stmt.loc };
  }

  private bindUpdate(stmt: A.UpdateStmt, rootCtes: Map<string, CteEntry>): BoundStatement {
    const { ctes, map } = this.bindCtes(stmt.with, rootCtes, undefined);
    const table = this.targetTable(stmt.table, stmt.loc);
    const alias = stmt.alias ?? table.name;
    const scope = new Scope(undefined, map);
    scope.relations.push(this.tableRelation(table, alias));
    let from: BoundFrom | undefined;
    if (stmt.from) {
      this.collectRelations(stmt.from, scope);
      from = this.bindFrom(stmt.from, scope, { next: 1 }).node;
    }
    const ctx = this.ctx(scope, "set");
    const assignments: { column: number; expr: BoundExpr }[] = [];
    for (const a of stmt.assignments) {
      if (a.columns.length !== 1) throw err("row-value assignments are not supported", a.loc);
      const column = this.columnIndex(table, a.columns[0]!, a.loc);
      if (assignments.some((x) => x.column === column)) throw err(`column ${table.columns[column]!.name} assigned more than once`, a.loc);
      assignments.push({ column, expr: this.bindExpr(a.value, ctx) });
    }
    const where = stmt.where ? this.bindExpr(stmt.where, this.ctx(scope, "where")) : undefined;
    const returning = this.bindReturning(stmt.returning, scope);
    return { kind: "update", table, alias, or: stmt.or, relations: scope.relations, from, assignments, where, returning, ctes, parameters: this.params.info(), loc: stmt.loc };
  }

  private bindDelete(stmt: A.DeleteStmt, rootCtes: Map<string, CteEntry>): BoundStatement {
    const { ctes, map } = this.bindCtes(stmt.with, rootCtes, undefined);
    const table = this.targetTable(stmt.table, stmt.loc);
    const alias = stmt.alias ?? table.name;
    const scope = new Scope(undefined, map);
    scope.relations.push(this.tableRelation(table, alias));
    const where = stmt.where ? this.bindExpr(stmt.where, this.ctx(scope, "where")) : undefined;
    const returning = this.bindReturning(stmt.returning, scope);
    return { kind: "delete", table, alias, relations: scope.relations, where, returning, ctes, parameters: this.params.info(), loc: stmt.loc };
  }

  // ───────────────────────────── DDL ─────────────────────────────

  private bindCreateTable(stmt: A.CreateTableStmt): BoundStatement {
    const exists = this.schema.tableExists(stmt.name);
    if (exists && !stmt.ifNotExists) throw err(`table ${stmt.name} already exists`, stmt.loc);
    if (stmt.name.toLowerCase().startsWith("basalt_") || stmt.name.toLowerCase().startsWith("sqlite_")) throw err(`object name reserved for internal use: ${stmt.name}`, stmt.loc);
    if (stmt.asSelect) {
      const select = this.bindSelect(stmt.asSelect, undefined, new Map());
      const columns: ColumnDef[] = select.columns.map((c) => ({ name: c.name, type: c.type === "ANY" || c.type === "NULL" ? "BLOB" : c.type, notNull: false, primaryKey: false, unique: false }));
      this.checkDuplicateColumns(columns, stmt.loc);
      const table: TableSchema = { name: stmt.name, columns, rowidColumn: -1 };
      return { kind: "createTable", ifNotExists: stmt.ifNotExists, exists, table, defaults: columns.map(() => null), checks: [], uniques: [], withoutRowid: false, asSelect: select, sql: stmt.sql, parameters: this.params.info(), loc: stmt.loc };
    }
    const columns: ColumnDef[] = [];
    const defaults: (BoundExpr | null)[] = [];
    const checksAst: A.Expr[] = [];
    const uniques: number[][] = [];
    let primaryKey: number[] | undefined;
    let pkIsInteger = false;
    const stmtSql = (loc: A.SourceLocation): string => stmt.sql.slice(loc.offset - stmt.loc.offset, loc.end - stmt.loc.offset);

    stmt.columns.forEach((cd, i) => {
      const def: ColumnDef = { name: cd.name, type: columnDataType(cd.typeName), notNull: false, primaryKey: false, unique: false };
      let dflt: BoundExpr | null = null;
      for (const c of cd.constraints) {
        switch (c.kind) {
          case "primaryKey":
            if (primaryKey) throw err(`table "${stmt.name}" has more than one primary key`, cd.loc);
            primaryKey = [i]; def.primaryKey = true;
            pkIsInteger = (cd.typeName ?? "").toUpperCase() === "INTEGER";
            if (c.autoincrement && !pkIsInteger) throw err("AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY", cd.loc);
            break;
          case "notNull": def.notNull = true; break;
          case "null": break;
          case "unique": def.unique = true; uniques.push([i]); break;
          case "check": checksAst.push(c.expr); break;
          case "default": {
            dflt = this.bindDefaultExpr(c.expr, !c.parenthesized);
            def.defaultSql = !c.parenthesized && c.expr.type === "column" && !c.expr.table ? `'${c.expr.name.replace(/'/g, "''")}'` : stmtSql(c.expr.loc);
            break;
          }
          case "collate": break; // ignored (BINARY only)
          case "references": break; // foreign keys are parsed but not enforced
          case "generated": throw err("generated columns are not supported", cd.loc);
        }
      }
      columns.push(def);
      defaults.push(dflt);
    });
    this.checkDuplicateColumns(columns, stmt.loc);
    const colIndex = (name: string, loc: A.SourceLocation): number => {
      const i = columns.findIndex((c) => eq(c.name, name));
      if (i < 0) throw err(`no such column: ${name}`, loc);
      return i;
    };
    for (const tc of stmt.constraints) {
      switch (tc.kind) {
        case "primaryKey": {
          if (primaryKey) throw err(`table "${stmt.name}" has more than one primary key`, tc.loc);
          if (tc.columns.some((c) => c.expr)) throw err("expressions are not allowed in a PRIMARY KEY", tc.loc);
          primaryKey = tc.columns.map((c) => colIndex(c.name, tc.loc));
          for (const i of primaryKey) columns[i]!.primaryKey = true;
          if (primaryKey.length === 1) pkIsInteger = (stmt.columns[primaryKey[0]!]!.typeName ?? "").toUpperCase() === "INTEGER";
          break;
        }
        case "unique": {
          if (tc.columns.some((c) => c.expr)) throw err("expressions are not allowed in a UNIQUE constraint", tc.loc);
          const cols = tc.columns.map((c) => colIndex(c.name, tc.loc));
          if (cols.length === 1) columns[cols[0]!]!.unique = true;
          uniques.push(cols);
          break;
        }
        case "check": checksAst.push(tc.expr); break;
        case "foreignKey": for (const c of tc.columns) colIndex(c, tc.loc); break;
      }
    }
    if (stmt.withoutRowid && !primaryKey) throw err(`PRIMARY KEY missing on table ${stmt.name}`, stmt.loc);
    const rowidColumn = !stmt.withoutRowid && primaryKey && primaryKey.length === 1 && pkIsInteger ? primaryKey[0]! : -1;
    const table: TableSchema = { name: stmt.name, columns, rowidColumn };
    // CHECK constraints are bound against the new table (rows[0] = candidate row)
    const scope = new Scope(undefined, new Map());
    scope.relations.push(this.tableRelation(table, table.name));
    const checks = checksAst.map((e) => this.bindExpr(e, { ...this.ctx(scope, "check"), allowSubqueries: false }));
    const pkOut = primaryKey && rowidColumn < 0 ? primaryKey : undefined;
    return {
      kind: "createTable", ifNotExists: stmt.ifNotExists, exists, table, defaults, checks, primaryKey: pkOut, uniques,
      withoutRowid: stmt.withoutRowid, sql: stmt.sql, parameters: this.params.info(), loc: stmt.loc,
    };
  }

  private checkDuplicateColumns(columns: ColumnDef[], loc: A.SourceLocation): void {
    const seen = new Set<string>();
    for (const c of columns) {
      const k = c.name.toLowerCase();
      if (seen.has(k)) throw err(`duplicate column name: ${c.name}`, loc);
      seen.add(k);
    }
  }

  private bindCreateIndex(stmt: A.CreateIndexStmt): BoundStatement {
    const table = this.schema.getTable(stmt.table);
    if (!table) {
      if (this.schema.getView(stmt.table)) throw err(`views may not be indexed: ${stmt.table}`, stmt.loc);
      throw err(`no such table: ${stmt.table}`, stmt.loc);
    }
    const exists = this.indexExists(stmt.name) || this.schema.tableExists(stmt.name);
    if (exists && !stmt.ifNotExists) throw err(`index ${stmt.name} already exists`, stmt.loc);
    const columns = stmt.columns.map((c) => {
      if (c.expr) throw err("expression indexes are not supported", c.loc);
      return this.columnIndex(table, c.name, c.loc);
    });
    if (new Set(columns).size !== columns.length) throw err("duplicate column in index", stmt.loc);
    const index: IndexSchema = { name: stmt.name, table: table.name, columns, unique: stmt.unique };
    let where: BoundExpr | undefined;
    if (stmt.where) {
      const scope = new Scope(undefined, new Map());
      scope.relations.push(this.tableRelation(table, table.name));
      where = this.bindExpr(stmt.where, { ...this.ctx(scope, "index"), allowSubqueries: false });
    }
    return { kind: "createIndex", ifNotExists: stmt.ifNotExists, exists, index, where, sql: stmt.sql, parameters: this.params.info(), loc: stmt.loc };
  }

  private bindCreateView(stmt: A.CreateViewStmt): BoundStatement {
    const exists = this.schema.tableExists(stmt.name);
    if (exists && !stmt.ifNotExists) throw err(`view ${stmt.name} already exists`, stmt.loc);
    const select = this.bindSelect(stmt.select, undefined, new Map());
    const columns = this.applyColumnList(select.columns, stmt.columns, stmt.name, stmt.loc);
    const selectSql = stmt.sql.slice(stmt.select.loc.offset - stmt.loc.offset, stmt.select.loc.end - stmt.loc.offset);
    return { kind: "createView", ifNotExists: stmt.ifNotExists, exists, name: stmt.name, columns, select, selectSql, sql: stmt.sql, parameters: this.params.info(), loc: stmt.loc };
  }

  private bindAlter(stmt: A.AlterTableStmt): BoundAlterTable {
    const table = this.targetTable(stmt.table, stmt.loc);
    const base = { kind: "alterTable" as const, table, parameters: this.params.info(), loc: stmt.loc };
    switch (stmt.action) {
      case "renameTo":
        if (this.schema.tableExists(stmt.newName)) throw err(`there is already another table or index with this name: ${stmt.newName}`, stmt.loc);
        return { ...base, action: "renameTo", newName: stmt.newName };
      case "renameColumn": {
        const column = this.columnIndex(table, stmt.column, stmt.loc);
        if (table.columns.some((c) => eq(c.name, stmt.newName))) throw err(`duplicate column name: ${stmt.newName}`, stmt.loc);
        return { ...base, action: "renameColumn", column, newName: stmt.newName };
      }
      case "dropColumn": {
        const column = this.columnIndex(table, stmt.column, stmt.loc);
        const c = table.columns[column]!;
        if (c.primaryKey || c.unique || column === table.rowidColumn) throw err(`cannot drop column "${c.name}": PRIMARY KEY or UNIQUE`, stmt.loc);
        if (table.columns.length === 1) throw err(`cannot drop the only column of table ${table.name}`, stmt.loc);
        if (this.schema.listIndexes(table.name).some((i) => i.columns.includes(column))) throw err(`cannot drop column "${c.name}": indexed`, stmt.loc);
        return { ...base, action: "dropColumn", column };
      }
      case "addColumn": {
        const cd = stmt.column;
        if (table.columns.some((c) => eq(c.name, cd.name))) throw err(`duplicate column name: ${cd.name}`, stmt.loc);
        const def: ColumnDef = { name: cd.name, type: columnDataType(cd.typeName), notNull: false, primaryKey: false, unique: false };
        let dflt: BoundExpr | null = null;
        for (const c of cd.constraints) {
          switch (c.kind) {
            case "primaryKey": throw err("Cannot add a PRIMARY KEY column", stmt.loc);
            case "unique": throw err("Cannot add a UNIQUE column", stmt.loc);
            case "notNull": def.notNull = true; break;
            case "default": dflt = this.bindDefaultExpr(c.expr, !c.parenthesized); def.defaultSql = !c.parenthesized && c.expr.type === "column" && !c.expr.table ? `'${c.expr.name.replace(/'/g, "''")}'` : this.text(c.expr.loc, "NULL"); break;
            case "check": throw err("CHECK constraints are not supported in ADD COLUMN", stmt.loc);
            case "generated": throw err("generated columns are not supported", stmt.loc);
            default: break;
          }
        }
        if (def.notNull && (dflt === null || (dflt.kind === "literal" && dflt.value === null))) throw err("Cannot add a NOT NULL column with default value NULL", stmt.loc);
        return { ...base, action: "addColumn", column: def, default: dflt };
      }
    }
  }
}

/** Output columns of a bound select body. */
function bodyColumns(body: BoundSelectBody): RelationColumn[] {
  switch (body.kind) {
    case "core": return body.projections.map((p) => ({ name: p.name, type: p.expr.dataType, hidden: false }));
    case "values": return body.columns;
    case "compound": {
      const l = bodyColumns(body.left), r = bodyColumns(body.right);
      return l.map((c, i) => ({ name: c.name, type: c.type === r[i]!.type ? c.type : commonType([c.type, r[i]!.type]), hidden: false }));
    }
  }
}

/** Collect outer references of a select body's top-level cores (correlated subquery detection). */
function collectOuterRefs(body: BoundSelectBody, out: BoundColumnRef[]): void {
  switch (body.kind) {
    case "core": out.push(...body.outerRefs); break;
    case "compound": collectOuterRefs(body.left, out); collectOuterRefs(body.right, out); break;
    case "values": {
      // VALUES rows bound in their own scope: scan for depth>=1 refs
      for (const row of body.rows) for (const e of row) scanOuter(e, out);
      break;
    }
  }
}
function scanOuter(e: BoundExpr, out: BoundColumnRef[]): void {
  if (e.kind === "column" && e.depth > 0) out.push(e);
  switch (e.kind) {
    case "unary": scanOuter(e.operand, out); break;
    case "binary": scanOuter(e.left, out); scanOuter(e.right, out); break;
    case "function": e.args.forEach((a) => scanOuter(a, out)); break;
    case "case": if (e.operand) scanOuter(e.operand, out); e.whens.forEach((w) => { scanOuter(w.when, out); scanOuter(w.then, out); }); if (e.else) scanOuter(e.else, out); break;
    case "cast": case "isnull": scanOuter(e.expr, out); break;
    case "like": scanOuter(e.left, out); scanOuter(e.right, out); break;
    case "between": scanOuter(e.expr, out); scanOuter(e.low, out); scanOuter(e.high, out); break;
    case "in": scanOuter(e.expr, out); e.list?.forEach((x) => scanOuter(x, out)); break;
    default: break;
  }
}

