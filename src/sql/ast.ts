/**
 * Abstract syntax tree for Basalt SQL. Every node carries a `loc` (source position) for error messages.
 * The tree is a plain discriminated union so it is JSON-serialisable (except bigint/Uint8Array literal values).
 */
import type { Value } from "../core/types.js";

/** Source position of a node: 1-based line/column plus 0-based character offsets. */
export interface SourceLocation {
  line: number;
  col: number;
  offset: number;
  end: number;
}

// ───────────────────────────────── Expressions ─────────────────────────────────

export type BinaryOp =
  | "||" | "*" | "/" | "%" | "+" | "-" | "<<" | ">>" | "&" | "|"
  | "<" | "<=" | ">" | ">=" | "=" | "==" | "!=" | "<>"
  | "IS" | "IS NOT" | "IS DISTINCT FROM" | "IS NOT DISTINCT FROM"
  | "AND" | "OR";

export type UnaryOp = "-" | "+" | "~" | "NOT";

export type LikeOp = "LIKE" | "GLOB" | "REGEXP" | "MATCH";

export interface LiteralExpr { type: "literal"; value: Value; loc: SourceLocation }
export interface ColumnExpr { type: "column"; schema?: string; table?: string; name: string; loc: SourceLocation }
/** `?` (index undefined -> positional), `?NNN`, `:name`/`@name`/`$name` (name includes the sigil). */
export interface ParamExpr { type: "param"; index?: number; name?: string; loc: SourceLocation }
export interface UnaryExpr { type: "unary"; op: UnaryOp; operand: Expr; loc: SourceLocation }
export interface BinaryExpr { type: "binary"; op: BinaryOp; left: Expr; right: Expr; loc: SourceLocation }
export interface LikeExpr { type: "like"; op: LikeOp; not: boolean; left: Expr; right: Expr; escape?: Expr; loc: SourceLocation }
export interface BetweenExpr { type: "between"; not: boolean; expr: Expr; low: Expr; high: Expr; loc: SourceLocation }
export interface InExpr {
  type: "in"; not: boolean; expr: Expr;
  /** Exactly one of list / subquery / table is set. */
  list?: Expr[]; subquery?: SelectStmt; table?: string;
  loc: SourceLocation;
}
export interface IsNullExpr { type: "isnull"; not: boolean; expr: Expr; loc: SourceLocation }
export interface CaseExpr { type: "case"; operand?: Expr; whens: { when: Expr; then: Expr }[]; else?: Expr; loc: SourceLocation }
export interface CastExpr { type: "cast"; expr: Expr; typeName: string; loc: SourceLocation }
export interface CollateExpr { type: "collate"; expr: Expr; collation: string; loc: SourceLocation }
export interface ExistsExpr { type: "exists"; not: boolean; subquery: SelectStmt; loc: SourceLocation }
export interface SubqueryExpr { type: "subquery"; subquery: SelectStmt; loc: SourceLocation }
export interface FunctionExpr {
  type: "function"; name: string; args: Expr[]; distinct: boolean;
  /** `count(*)` */
  star: boolean;
  filter?: Expr;
  /** Window specification or the name of a WINDOW-clause window. */
  over?: WindowSpec | string;
  loc: SourceLocation;
}
/** `RAISE(IGNORE | ROLLBACK | ABORT | FAIL, message)` - parsed for completeness. */
export interface RaiseExpr { type: "raise"; action: "IGNORE" | "ROLLBACK" | "ABORT" | "FAIL"; message?: string; loc: SourceLocation }

export type Expr =
  | LiteralExpr | ColumnExpr | ParamExpr | UnaryExpr | BinaryExpr | LikeExpr | BetweenExpr | InExpr | IsNullExpr
  | CaseExpr | CastExpr | CollateExpr | ExistsExpr | SubqueryExpr | FunctionExpr | RaiseExpr;

// ───────────────────────────────── Window specs ─────────────────────────────────

export type FrameUnit = "ROWS" | "RANGE" | "GROUPS";
export type FrameBound =
  | { kind: "unboundedPreceding" }
  | { kind: "preceding"; offset: Expr }
  | { kind: "currentRow" }
  | { kind: "following"; offset: Expr }
  | { kind: "unboundedFollowing" };
export type FrameExclude = "NO OTHERS" | "CURRENT ROW" | "GROUP" | "TIES";

export interface WindowFrame { unit: FrameUnit; start: FrameBound; end: FrameBound; exclude: FrameExclude }

export interface WindowSpec {
  /** Base window name (`OVER (w ORDER BY ...)`). */
  baseName?: string;
  partitionBy: Expr[];
  orderBy: OrderingTerm[];
  frame?: WindowFrame;
  loc: SourceLocation;
}

export interface OrderingTerm { expr: Expr; desc: boolean; nulls?: "FIRST" | "LAST"; collation?: string; loc: SourceLocation }

// ───────────────────────────────── SELECT ─────────────────────────────────

export type ResultColumn =
  | { type: "star"; loc: SourceLocation }
  | { type: "tableStar"; table: string; loc: SourceLocation }
  | { type: "expr"; expr: Expr; alias?: string; loc: SourceLocation };

export type JoinType = "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS";

export type TableRef =
  | { type: "table"; schema?: string; name: string; alias?: string; indexedBy?: string | null /* null = NOT INDEXED */; loc: SourceLocation }
  | { type: "subquery"; select: SelectStmt; alias?: string; loc: SourceLocation }
  | { type: "join"; joinType: JoinType; natural: boolean; left: TableRef; right: TableRef; on?: Expr; using?: string[]; loc: SourceLocation };

export interface SelectCore {
  type: "select";
  distinct: boolean;
  columns: ResultColumn[];
  from?: TableRef;
  where?: Expr;
  groupBy?: Expr[];
  having?: Expr;
  windows?: { name: string; spec: WindowSpec }[];
  loc: SourceLocation;
}

export interface ValuesCore { type: "values"; rows: Expr[][]; loc: SourceLocation }

export type CompoundOp = "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT";

export interface CompoundSelect { type: "compound"; op: CompoundOp; left: SelectBody; right: SelectBody; loc: SourceLocation }

export type SelectBody = SelectCore | ValuesCore | CompoundSelect;

export interface CommonTableExpr {
  name: string;
  columns?: string[];
  materialized?: boolean;
  select: SelectStmt;
  loc: SourceLocation;
}

export interface WithClause { recursive: boolean; ctes: CommonTableExpr[]; loc: SourceLocation }

export interface SelectStmt {
  type: "select";
  with?: WithClause;
  body: SelectBody;
  orderBy?: OrderingTerm[];
  limit?: Expr;
  offset?: Expr;
  loc: SourceLocation;
}

// ───────────────────────────────── DML ─────────────────────────────────

export type ConflictAction = "ROLLBACK" | "ABORT" | "FAIL" | "IGNORE" | "REPLACE";

export interface UpsertClause {
  /** Conflict target columns (empty -> any uniqueness conflict). */
  target: string[];
  targetWhere?: Expr;
  /** `DO NOTHING` when undefined. */
  set?: { column: string; value: Expr }[];
  where?: Expr;
  loc: SourceLocation;
}

export interface InsertStmt {
  type: "insert";
  with?: WithClause;
  or?: ConflictAction;
  table: string;
  alias?: string;
  columns?: string[];
  /** One of: values rows, a select, or DEFAULT VALUES (`defaultValues: true`). */
  values?: Expr[][];
  select?: SelectStmt;
  defaultValues?: boolean;
  upsert?: UpsertClause;
  returning?: ResultColumn[];
  loc: SourceLocation;
}

export interface UpdateStmt {
  type: "update";
  with?: WithClause;
  or?: ConflictAction;
  table: string;
  alias?: string;
  assignments: { columns: string[]; value: Expr; loc: SourceLocation }[];
  from?: TableRef;
  where?: Expr;
  returning?: ResultColumn[];
  loc: SourceLocation;
}

export interface DeleteStmt {
  type: "delete";
  with?: WithClause;
  table: string;
  alias?: string;
  where?: Expr;
  returning?: ResultColumn[];
  loc: SourceLocation;
}

// ───────────────────────────────── DDL ─────────────────────────────────

export type ColumnConstraint =
  | { kind: "primaryKey"; desc: boolean; autoincrement: boolean; onConflict?: ConflictAction; name?: string }
  | { kind: "notNull"; onConflict?: ConflictAction; name?: string }
  | { kind: "null"; name?: string }
  | { kind: "unique"; onConflict?: ConflictAction; name?: string }
  | { kind: "check"; expr: Expr; name?: string }
  /** `parenthesized` distinguishes `DEFAULT (expr)` (constant expression) from `DEFAULT literal`/bare identifier. */
  | { kind: "default"; expr: Expr; parenthesized: boolean; name?: string }
  | { kind: "collate"; collation: string; name?: string }
  | { kind: "references"; table: string; columns?: string[]; name?: string }
  | { kind: "generated"; expr: Expr; stored: boolean; name?: string };

export interface ColumnDefinition {
  name: string;
  /** Declared type name as written (e.g. "VARCHAR(20)"), or undefined for untyped columns. */
  typeName?: string;
  constraints: ColumnConstraint[];
  loc: SourceLocation;
}

export interface IndexedColumn { name: string; expr?: Expr; collation?: string; desc: boolean; loc: SourceLocation }

export type TableConstraint =
  | { kind: "primaryKey"; columns: IndexedColumn[]; onConflict?: ConflictAction; name?: string; loc: SourceLocation }
  | { kind: "unique"; columns: IndexedColumn[]; onConflict?: ConflictAction; name?: string; loc: SourceLocation }
  | { kind: "check"; expr: Expr; name?: string; loc: SourceLocation }
  | { kind: "foreignKey"; columns: string[]; table: string; refColumns?: string[]; name?: string; loc: SourceLocation };

export interface CreateTableStmt {
  type: "createTable";
  ifNotExists: boolean;
  temp: boolean;
  name: string;
  columns: ColumnDefinition[];
  constraints: TableConstraint[];
  withoutRowid: boolean;
  /** `CREATE TABLE ... AS SELECT` (then columns/constraints are empty). */
  asSelect?: SelectStmt;
  /** Original statement text (stored in the catalog). */
  sql: string;
  loc: SourceLocation;
}

export interface DropStmt { type: "drop"; object: "TABLE" | "INDEX" | "VIEW"; ifExists: boolean; name: string; loc: SourceLocation }

export interface CreateIndexStmt {
  type: "createIndex";
  unique: boolean;
  ifNotExists: boolean;
  name: string;
  table: string;
  columns: IndexedColumn[];
  where?: Expr;
  sql: string;
  loc: SourceLocation;
}

export interface CreateViewStmt {
  type: "createView";
  ifNotExists: boolean;
  temp: boolean;
  name: string;
  columns?: string[];
  select: SelectStmt;
  sql: string;
  loc: SourceLocation;
}

export type AlterTableStmt =
  | { type: "alterTable"; table: string; action: "renameTo"; newName: string; loc: SourceLocation }
  | { type: "alterTable"; table: string; action: "renameColumn"; column: string; newName: string; loc: SourceLocation }
  | { type: "alterTable"; table: string; action: "addColumn"; column: ColumnDefinition; loc: SourceLocation }
  | { type: "alterTable"; table: string; action: "dropColumn"; column: string; loc: SourceLocation };

// ───────────────────────────────── Transactions & misc ─────────────────────────────────

export interface BeginStmt { type: "begin"; mode?: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE"; loc: SourceLocation }
export interface CommitStmt { type: "commit"; loc: SourceLocation }
export interface RollbackStmt { type: "rollback"; savepoint?: string; loc: SourceLocation }
export interface SavepointStmt { type: "savepoint"; name: string; loc: SourceLocation }
export interface ReleaseStmt { type: "release"; name: string; loc: SourceLocation }
export interface ExplainStmt { type: "explain"; analyze: boolean; queryPlan: boolean; statement: Statement; loc: SourceLocation }
export interface AnalyzeStmt { type: "analyze"; target?: string; loc: SourceLocation }
export interface VacuumStmt { type: "vacuum"; loc: SourceLocation }
export interface PragmaStmt {
  type: "pragma"; schema?: string; name: string;
  /** `PRAGMA x = v` -> value with `assign: true`; `PRAGMA x(v)` -> value with `assign: false`. */
  value?: Expr; assign: boolean;
  loc: SourceLocation;
}

export type Statement =
  | SelectStmt | InsertStmt | UpdateStmt | DeleteStmt
  | CreateTableStmt | DropStmt | CreateIndexStmt | CreateViewStmt | AlterTableStmt
  | BeginStmt | CommitStmt | RollbackStmt | SavepointStmt | ReleaseStmt
  | ExplainStmt | AnalyzeStmt | VacuumStmt | PragmaStmt;

export type StatementType = Statement["type"];
