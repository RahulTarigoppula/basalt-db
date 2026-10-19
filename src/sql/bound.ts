/**
 * Bound tree: the output of semantic analysis (`binder.ts`). Every name is resolved, every expression typed.
 *
 * ## Row layout contract (shared with `exec/expr.ts`)
 * Expressions are evaluated against `rows: Row[]` - one `Row` per relation in scope. For a query scope with
 * relations `[r0, r1, ...]` (FROM order), `rows[i]` is the current row of relation `i`. The rows of *outer*
 * scopes (for correlated subqueries) are appended after the inner scope's rows, outermost last:
 * `rows = [...innerScopeRows, ...outerRows]`, where `outerRows` is exactly the `rows` array the outer expression
 * was evaluated with. `BoundColumnRef.rel` is the flat index into that array; `depth`/`relation` give the
 * scope-relative view for the planner.
 *
 * Nodes the planner MUST rewrite before compiling an expression (the compiler throws otherwise unless given a hook):
 * `aggregate`, `window`, `rowid`, `resultColumn`. Everything else compiles directly.
 */
import type { ColumnDef, DataType, IndexSchema, TableSchema, Value } from "../core/types.js";
import type { BinaryOp, CompoundOp, ConflictAction, FrameExclude, FrameUnit, JoinType, LikeOp, SourceLocation, UnaryOp } from "./ast.js";

/** Inferred expression type: a concrete DataType or "ANY" when it depends on runtime values (parameters, mixed CASE arms). */
export type ExprType = DataType | "ANY";

/** CAST target. "NUMERIC" = integer when losslessly representable, else real (SQLite semantics). */
export type CastTarget = DataType | "NUMERIC";

/** Arity of one function kind: `maxArgs === -1` means variadic. */
export interface Arity { minArgs: number; maxArgs: number }

/** Function metadata the binder uses to validate calls. Implemented by `exec/functions.ts` (`builtinFunctions`). */
export interface FunctionInfo {
  name: string;
  scalar?: Arity;
  aggregate?: Arity;
  window?: Arity;
  /** Infers the result type for the given argument types and the kind of call. */
  returnType(argTypes: readonly ExprType[], kind: "scalar" | "aggregate" | "window"): ExprType;
  deterministic: boolean;
}

/** Name -> function metadata lookup (case-insensitive). */
export interface FunctionProvider { lookup(name: string): FunctionInfo | undefined }

// ───────────────────────────────── expressions ─────────────────────────────────

export interface BoundLiteral { kind: "literal"; value: Value; dataType: ExprType; loc: SourceLocation }

export interface BoundColumnRef {
  kind: "column";
  /** How many scopes up the referenced relation lives (0 = the expression's own scope). */
  depth: number;
  /** Index of the relation within its scope. */
  relation: number;
  /** Flat index into the `rows` array (see module docs). */
  rel: number;
  /** Column index within the relation's row. */
  column: number;
  /** Resolved column name and the relation alias it was found in (for EXPLAIN / result naming). */
  name: string;
  table: string | undefined;
  dataType: ExprType;
  loc: SourceLocation;
}

/** The implicit rowid of a table relation (`rowid`, `_rowid_`, `oid`) for tables without an INTEGER PRIMARY KEY. */
export interface BoundRowid { kind: "rowid"; depth: number; relation: number; rel: number; dataType: "INTEGER"; loc: SourceLocation }

/** Statement parameter; `index` is 0-based into the parameter array passed at execution time. */
export interface BoundParameter { kind: "param"; index: number; name?: string; dataType: "ANY"; loc: SourceLocation }

export interface BoundUnary { kind: "unary"; op: UnaryOp; operand: BoundExpr; dataType: ExprType; loc: SourceLocation }
export interface BoundBinary { kind: "binary"; op: BinaryOp; left: BoundExpr; right: BoundExpr; dataType: ExprType; loc: SourceLocation }
export interface BoundLike { kind: "like"; op: LikeOp; not: boolean; left: BoundExpr; right: BoundExpr; escape?: BoundExpr; dataType: "INTEGER"; loc: SourceLocation }
export interface BoundBetween { kind: "between"; not: boolean; expr: BoundExpr; low: BoundExpr; high: BoundExpr; dataType: "INTEGER"; loc: SourceLocation }
export interface BoundIn {
  kind: "in"; not: boolean; expr: BoundExpr;
  /** Exactly one of `list` / `subquery` is set. */
  list?: BoundExpr[]; subquery?: BoundSubquery;
  dataType: "INTEGER"; loc: SourceLocation;
}
export interface BoundIsNull { kind: "isnull"; not: boolean; expr: BoundExpr; dataType: "INTEGER"; loc: SourceLocation }
export interface BoundCase { kind: "case"; operand?: BoundExpr; whens: { when: BoundExpr; then: BoundExpr }[]; else?: BoundExpr; dataType: ExprType; loc: SourceLocation }
export interface BoundCast { kind: "cast"; expr: BoundExpr; target: CastTarget; dataType: ExprType; loc: SourceLocation }
/** Scalar builtin call; the compiler looks `name` up in its own registry. */
export interface BoundFunction { kind: "function"; name: string; args: BoundExpr[]; dataType: ExprType; loc: SourceLocation }
/** Aggregate call. `index` is its position in the owning `BoundSelectCore.aggregates`. */
export interface BoundAggregate {
  kind: "aggregate"; name: string; args: BoundExpr[]; distinct: boolean; star: boolean; filter?: BoundExpr;
  index: number; dataType: ExprType; loc: SourceLocation;
}
/** Window function (or aggregate used with OVER). `index` is its position in `BoundSelectCore.windows`. */
export interface BoundWindow {
  kind: "window"; name: string; isAggregate: boolean; args: BoundExpr[]; distinct: boolean; filter?: BoundExpr;
  spec: BoundWindowSpec; index: number; dataType: ExprType; loc: SourceLocation;
}
export interface BoundExists { kind: "exists"; not: boolean; subquery: BoundSubquery; dataType: "INTEGER"; loc: SourceLocation }
export interface BoundScalarSubquery { kind: "subquery"; subquery: BoundSubquery; dataType: ExprType; loc: SourceLocation }
/** Reference to the i-th output column of the enclosing select (used by ORDER BY on compound selects). */
export interface BoundResultColumnRef { kind: "resultColumn"; index: number; dataType: ExprType; loc: SourceLocation }

export type BoundExpr =
  | BoundLiteral | BoundColumnRef | BoundRowid | BoundParameter | BoundUnary | BoundBinary | BoundLike | BoundBetween | BoundIn
  | BoundIsNull | BoundCase | BoundCast | BoundFunction | BoundAggregate | BoundWindow | BoundExists | BoundScalarSubquery
  | BoundResultColumnRef;

/** A subquery used inside an expression. */
export interface BoundSubquery {
  select: BoundSelect;
  /**
   * Column references inside the subquery that resolve to relations OUTSIDE it, as seen from the subquery's own scope
   * (`depth >= 1`). Empty ⇒ uncorrelated (the planner may materialise it once).
   */
  outerRefs: BoundColumnRef[];
  correlated: boolean;
}

// ───────────────────────────────── windows & ordering ─────────────────────────────────

export interface BoundOrderBy {
  expr: BoundExpr;
  desc: boolean;
  /** Resolved NULLS placement (SQLite default: NULLs are smallest -> first for ASC, last for DESC). */
  nullsFirst: boolean;
  collation?: string;
  /** Set when the term refers to a result column (ordinal, alias) of the select. */
  projectionIndex?: number;
}

export type BoundFrameBound =
  | { kind: "unboundedPreceding" }
  | { kind: "preceding"; offset: BoundExpr }
  | { kind: "currentRow" }
  | { kind: "following"; offset: BoundExpr }
  | { kind: "unboundedFollowing" };

export interface BoundFrame { unit: FrameUnit; start: BoundFrameBound; end: BoundFrameBound; exclude: FrameExclude }

export interface BoundWindowSpec {
  partitionBy: BoundExpr[];
  orderBy: BoundOrderBy[];
  /** Undefined ⇒ default frame (RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW). */
  frame?: BoundFrame;
}

// ───────────────────────────────── relations & selects ─────────────────────────────────

export interface RelationColumn {
  name: string;
  type: ExprType;
  /** Hidden columns (the duplicate side of USING/NATURAL joins) are excluded from `*` and unqualified lookup. */
  hidden: boolean;
}

export type BoundRelation =
  | { kind: "table"; alias: string; table: TableSchema; columns: RelationColumn[]; indexedBy?: string | null }
  | { kind: "subquery"; alias: string | undefined; select: BoundSelect; columns: RelationColumn[] }
  | { kind: "view"; alias: string; name: string; select: BoundSelect; columns: RelationColumn[] }
  /** Reference to a CTE visible in scope; `recursiveRef` marks the self-reference inside a recursive CTE body. */
  | { kind: "cte"; alias: string; name: string; cte: BoundCte; recursiveRef: boolean; columns: RelationColumn[] };

export type BoundFrom =
  | { kind: "relation"; index: number }
  | {
    kind: "join"; joinType: JoinType; left: BoundFrom; right: BoundFrom;
    /** ON condition, or the conjunction of equalities derived from USING/NATURAL. */
    condition?: BoundExpr;
    /** Column pairs equated by USING/NATURAL (empty for ON/comma joins). */
    using: { name: string; left: BoundColumnRef; right: BoundColumnRef }[];
  };

export interface BoundProjection { expr: BoundExpr; name: string }

export interface BoundSelectCore {
  kind: "core";
  /** Relations of this scope in FROM order; `rows[i]` is relation `i`. */
  relations: BoundRelation[];
  from?: BoundFrom;
  where?: BoundExpr;
  groupBy: BoundExpr[];
  having?: BoundExpr;
  /** All aggregate calls in this core (SELECT list, HAVING, ORDER BY), referenced by `BoundAggregate.index`. */
  aggregates: BoundAggregate[];
  /** All window calls in this core, referenced by `BoundWindow.index`. */
  windows: BoundWindow[];
  distinct: boolean;
  projections: BoundProjection[];
  /** Column refs to outer scopes used anywhere in this core (including nested subqueries), as seen from this scope. */
  outerRefs: BoundColumnRef[];
}

export interface BoundValues { kind: "values"; rows: BoundExpr[][]; columns: RelationColumn[] }

export interface BoundCompound { kind: "compound"; op: CompoundOp; left: BoundSelectBody; right: BoundSelectBody }

export type BoundSelectBody = BoundSelectCore | BoundValues | BoundCompound;

export interface BoundCte {
  name: string;
  columns: RelationColumn[];
  select: BoundSelect;
  materialized?: boolean;
  /** Set for self-referencing CTEs: `select.body` is `anchor <op> recursiveTerm`. */
  recursive?: { anchor: BoundSelectBody; recursiveTerm: BoundSelectBody; unionAll: boolean };
}

export interface BoundSelect {
  kind: "select";
  ctes: BoundCte[];
  body: BoundSelectBody;
  /** For a simple select: bound in the core's scope. For compounds/VALUES: `resultColumn` references. */
  orderBy: BoundOrderBy[];
  limit?: BoundExpr;
  offset?: BoundExpr;
  /** Output columns. */
  columns: RelationColumn[];
  loc: SourceLocation;
}

// ───────────────────────────────── statements ─────────────────────────────────

/** Parameter usage of a statement: `count` slots; `names[i]` is the name bound to slot i (or undefined for `?`). */
export interface ParameterInfo { count: number; names: (string | undefined)[] }

export interface BoundStatementBase { parameters: ParameterInfo; loc: SourceLocation }

export interface BoundSelectStatement extends BoundStatementBase { kind: "select"; select: BoundSelect }

export interface BoundUpsert {
  /** Conflict target column indexes (empty = any unique constraint). */
  target: number[];
  targetWhere?: BoundExpr;
  /** Undefined ⇒ DO NOTHING. Expressions see `rows[0]` = existing row, `rows[1]` = the `excluded` row. */
  set?: { column: number; expr: BoundExpr }[];
  where?: BoundExpr;
}

export interface BoundInsert extends BoundStatementBase {
  kind: "insert";
  table: TableSchema;
  or?: ConflictAction;
  /** Target column indexes, in the order values are supplied. */
  columns: number[];
  source: { kind: "values"; rows: BoundExpr[][] } | { kind: "select"; select: BoundSelect } | { kind: "defaults" };
  /** Per table column: bound DEFAULT expression (evaluated with `rows = []`), or null when the column has no default. */
  defaults: (BoundExpr | null)[];
  upsert?: BoundUpsert;
  /** RETURNING expressions; `rows[0]` is the inserted row. */
  returning?: BoundProjection[];
  ctes: BoundCte[];
}

export interface BoundUpdate extends BoundStatementBase {
  kind: "update";
  table: TableSchema;
  alias: string;
  or?: ConflictAction;
  /** Scope relations: `[target, ...FROM relations]`. */
  relations: BoundRelation[];
  from?: BoundFrom;
  assignments: { column: number; expr: BoundExpr }[];
  where?: BoundExpr;
  returning?: BoundProjection[];
  ctes: BoundCte[];
}

export interface BoundDelete extends BoundStatementBase {
  kind: "delete";
  table: TableSchema;
  alias: string;
  relations: BoundRelation[];
  where?: BoundExpr;
  returning?: BoundProjection[];
  ctes: BoundCte[];
}

export interface BoundCreateTable extends BoundStatementBase {
  kind: "createTable";
  ifNotExists: boolean;
  /** True when the table already exists (only legal with IF NOT EXISTS). */
  exists: boolean;
  table: TableSchema;
  /** Bound DEFAULT per column (evaluated with `rows = []`), null when none. */
  defaults: (BoundExpr | null)[];
  /** CHECK constraints bound against `rows[0]` = the candidate row. */
  checks: BoundExpr[];
  /** Composite/explicit PRIMARY KEY column indexes (undefined when none or when the PK is the rowid column). */
  primaryKey?: number[];
  /** UNIQUE constraints (column index lists), including single-column `UNIQUE` columns. */
  uniques: number[][];
  withoutRowid: boolean;
  asSelect?: BoundSelect;
  sql: string;
}

export interface BoundCreateIndex extends BoundStatementBase {
  kind: "createIndex";
  ifNotExists: boolean;
  exists: boolean;
  index: IndexSchema;
  /** Partial-index predicate bound against `rows[0]` = table row. */
  where?: BoundExpr;
  sql: string;
}

export interface BoundCreateView extends BoundStatementBase {
  kind: "createView";
  ifNotExists: boolean;
  exists: boolean;
  name: string;
  columns: RelationColumn[];
  select: BoundSelect;
  /** The SELECT text to store in the catalog. */
  selectSql: string;
  sql: string;
}

export interface BoundDrop extends BoundStatementBase { kind: "drop"; object: "TABLE" | "INDEX" | "VIEW"; name: string; ifExists: boolean; exists: boolean }

export type BoundAlterTable = BoundStatementBase & { kind: "alterTable"; table: TableSchema } & (
  | { action: "renameTo"; newName: string }
  | { action: "renameColumn"; column: number; newName: string }
  | { action: "addColumn"; column: ColumnDef; default: BoundExpr | null }
  | { action: "dropColumn"; column: number }
);

export interface BoundBegin extends BoundStatementBase { kind: "begin"; mode?: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE" }
export interface BoundCommit extends BoundStatementBase { kind: "commit" }
export interface BoundRollback extends BoundStatementBase { kind: "rollback"; savepoint?: string }
export interface BoundSavepoint extends BoundStatementBase { kind: "savepoint"; name: string }
export interface BoundRelease extends BoundStatementBase { kind: "release"; name: string }
export interface BoundExplain extends BoundStatementBase { kind: "explain"; analyze: boolean; queryPlan: boolean; statement: BoundStatement }
export interface BoundAnalyze extends BoundStatementBase { kind: "analyze"; target?: string }
export interface BoundVacuum extends BoundStatementBase { kind: "vacuum" }
export interface BoundPragma extends BoundStatementBase { kind: "pragma"; name: string; value?: Value; assign: boolean }

export type BoundStatement =
  | BoundSelectStatement | BoundInsert | BoundUpdate | BoundDelete
  | BoundCreateTable | BoundCreateIndex | BoundCreateView | BoundDrop | BoundAlterTable
  | BoundBegin | BoundCommit | BoundRollback | BoundSavepoint | BoundRelease
  | BoundExplain | BoundAnalyze | BoundVacuum | BoundPragma;

// ───────────────────────────────── helpers ─────────────────────────────────

/**
 * SQLite type-affinity rules applied to a declared type name. `undefined`/empty ⇒ "BLOB" (no affinity).
 * Returns "NUMERIC" for names that match none of the INT/CHAR/BLOB/REAL rules.
 */
export function affinityOf(typeName: string | undefined): DataType | "NUMERIC" {
  if (!typeName) return "BLOB";
  const u = typeName.toUpperCase();
  if (u.includes("INT")) return "INTEGER";
  if (u.includes("CHAR") || u.includes("CLOB") || u.includes("TEXT")) return "TEXT";
  if (u.includes("BLOB")) return "BLOB";
  if (u.includes("REAL") || u.includes("FLOA") || u.includes("DOUB")) return "REAL";
  if (u.includes("BOOL")) return "BOOLEAN";
  return "NUMERIC";
}

/** Maps a declared column type to the stored `DataType` (NUMERIC affinity is recorded as REAL). */
export function columnDataType(typeName: string | undefined): DataType {
  const a = affinityOf(typeName);
  return a === "NUMERIC" ? "REAL" : a;
}

/** Visits every sub-expression (pre-order), descending into subqueries only when `intoSubqueries` is true. */
export function walkBoundExpr(expr: BoundExpr, visit: (e: BoundExpr) => void, intoSubqueries = false): void {
  visit(expr);
  const rec = (e: BoundExpr | undefined): void => { if (e) walkBoundExpr(e, visit, intoSubqueries); };
  switch (expr.kind) {
    case "unary": rec(expr.operand); break;
    case "binary": rec(expr.left); rec(expr.right); break;
    case "like": rec(expr.left); rec(expr.right); rec(expr.escape); break;
    case "between": rec(expr.expr); rec(expr.low); rec(expr.high); break;
    case "in": rec(expr.expr); expr.list?.forEach(rec); if (intoSubqueries && expr.subquery) walkBoundSelect(expr.subquery.select, visit); break;
    case "isnull": rec(expr.expr); break;
    case "case": rec(expr.operand); for (const w of expr.whens) { rec(w.when); rec(w.then); } rec(expr.else); break;
    case "cast": rec(expr.expr); break;
    case "function": expr.args.forEach(rec); break;
    case "aggregate": expr.args.forEach(rec); rec(expr.filter); break;
    case "window":
      expr.args.forEach(rec); rec(expr.filter); expr.spec.partitionBy.forEach(rec);
      for (const o of expr.spec.orderBy) rec(o.expr);
      if (expr.spec.frame) {
        for (const b of [expr.spec.frame.start, expr.spec.frame.end]) if (b.kind === "preceding" || b.kind === "following") rec(b.offset);
      }
      break;
    case "exists": case "subquery": if (intoSubqueries) walkBoundSelect(expr.subquery.select, visit); break;
    default: break;
  }
}

/** Visits every expression in a bound select (including nested subqueries and CTE bodies). */
export function walkBoundSelect(select: BoundSelect, visit: (e: BoundExpr) => void): void {
  for (const cte of select.ctes) walkBoundSelect(cte.select, visit);
  walkBody(select.body, visit);
  for (const o of select.orderBy) walkBoundExpr(o.expr, visit, true);
  if (select.limit) walkBoundExpr(select.limit, visit, true);
  if (select.offset) walkBoundExpr(select.offset, visit, true);
}

function walkBody(body: BoundSelectBody, visit: (e: BoundExpr) => void): void {
  switch (body.kind) {
    case "compound": walkBody(body.left, visit); walkBody(body.right, visit); break;
    case "values": for (const row of body.rows) for (const e of row) walkBoundExpr(e, visit, true); break;
    case "core": {
      for (const r of body.relations) if (r.kind === "subquery" || r.kind === "view") walkBoundSelect(r.select, visit);
      const walkFrom = (f: BoundFrom | undefined): void => {
        if (!f || f.kind !== "join") return;
        walkFrom(f.left); walkFrom(f.right);
        if (f.condition) walkBoundExpr(f.condition, visit, true);
      };
      walkFrom(body.from);
      if (body.where) walkBoundExpr(body.where, visit, true);
      for (const g of body.groupBy) walkBoundExpr(g, visit, true);
      if (body.having) walkBoundExpr(body.having, visit, true);
      for (const p of body.projections) walkBoundExpr(p.expr, visit, true);
      break;
    }
  }
}

/**
 * Returns a copy of `expr` with every column reference replaced by `fn(ref)` (which may return the ref itself).
 * Does not descend into subqueries (their refs are relative to their own scope). Used by the planner to re-layout rows.
 */
export function mapColumnRefs(expr: BoundExpr, fn: (ref: BoundColumnRef | BoundRowid) => BoundExpr): BoundExpr {
  const m = (e: BoundExpr): BoundExpr => mapColumnRefs(e, fn);
  const mo = (e: BoundExpr | undefined): BoundExpr | undefined => (e ? m(e) : undefined);
  switch (expr.kind) {
    case "column": case "rowid": return fn(expr);
    case "unary": return { ...expr, operand: m(expr.operand) };
    case "binary": return { ...expr, left: m(expr.left), right: m(expr.right) };
    case "like": return { ...expr, left: m(expr.left), right: m(expr.right), escape: mo(expr.escape) };
    case "between": return { ...expr, expr: m(expr.expr), low: m(expr.low), high: m(expr.high) };
    case "in": return { ...expr, expr: m(expr.expr), list: expr.list?.map(m) };
    case "isnull": return { ...expr, expr: m(expr.expr) };
    case "case": return { ...expr, operand: mo(expr.operand), whens: expr.whens.map((w) => ({ when: m(w.when), then: m(w.then) })), else: mo(expr.else) };
    case "cast": return { ...expr, expr: m(expr.expr) };
    case "function": return { ...expr, args: expr.args.map(m) };
    case "aggregate": return { ...expr, args: expr.args.map(m), filter: mo(expr.filter) };
    case "window": {
      const frame = expr.spec.frame;
      const mb = (b: BoundFrameBound): BoundFrameBound => (b.kind === "preceding" || b.kind === "following") ? { kind: b.kind, offset: m(b.offset) } : b;
      return {
        ...expr, args: expr.args.map(m), filter: mo(expr.filter),
        spec: {
          partitionBy: expr.spec.partitionBy.map(m),
          orderBy: expr.spec.orderBy.map((o) => ({ ...o, expr: m(o.expr) })),
          frame: frame ? { ...frame, start: mb(frame.start), end: mb(frame.end) } : undefined,
        },
      };
    }
    default: return expr;
  }
}
