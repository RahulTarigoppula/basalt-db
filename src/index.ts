/**
 * Basalt public API. Import `Database` and open it over a backend:
 *
 *   const db = await Database.open({ memory: true });
 *   db.exec("CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT)");
 *   db.query("SELECT * FROM t WHERE a = ?", [1n]);
 *
 * Node-only backends (`NodeFileBackend`) are not exported here: use `Database.open({ file })`, which imports them lazily.
 */
export type { DataType, Value, Row, ColumnDef, TableSchema, IndexSchema, ResultColumn, QueryResult } from "./core/types.js";
export { compareValues, typeOfValue } from "./core/types.js";
export { BasaltError, SyntaxError_, BindError, ConstraintError, TransactionError, StorageError, CorruptionError } from "./core/errors.js";
export { Database, type OpenOptions, type DatabaseStats, type DatabaseEvent, type CommitEvent, type StatementEvent, type Params } from "./engine/database.js";
export { Statement } from "./engine/statement.js";
export { formatValue } from "./engine/result.js";
export type { PageInfo, PageDetail, PageCell, PageKind, BTreeStats } from "./engine/inspect.js";
export type { PlanNode } from "./planner/explain.js";
export { formatPlan } from "./planner/explain.js";
export { MemoryBackend, type Backend } from "./storage/backend.js";
export { OpfsBackend } from "./storage/opfs-backend.js";
export { IndexedDbBackend } from "./storage/idb-backend.js";
export { PAGE_SIZE } from "./storage/page.js";
export { parse, parseOne, parseExpression } from "./sql/parser.js";
export { tokenize } from "./sql/lexer.js";
export { formatReal } from "./exec/functions.js";
