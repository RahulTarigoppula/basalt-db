# Basalt - architecture and module contracts

Basalt is a relational database engine written from scratch in TypeScript with zero runtime dependencies. It runs in Node (file-backed) and in the browser (OPFS inside a Web Worker, IndexedDB fallback, or purely in memory). This document is the contract every module is built against. Where code and this document disagree, fix the code or update this document in the same change.

## Layering (bottom -> top)

```
src/core      Value/Row/Schema types, comparison order, key encoding, varints, errors        (no deps)
src/storage   Backend (bytes on disk) -> Pager/BufferPool (page cache) -> COW B+tree -> FreeList (reclaimed pages)
src/txn       TransactionManager: snapshot isolation on top of copy-on-write roots; single writer, many readers
src/catalog   System tables (tables, columns, indexes, stats) stored in ordinary B+trees; schema cache
src/sql       Lexer -> Parser -> AST -> Binder (name resolution, type inference) -> bound tree
src/planner   Bound tree -> logical plan -> rewrite rules -> cost-based join ordering + index selection -> physical plan
src/exec      Volcano iterators (open/next/close) for every physical operator; expression evaluator; builtin functions
src/engine    Database facade: open/close, exec(sql), query(sql), transactions, EXPLAIN, ANALYZE, VACUUM, events
src/cli       Node REPL (readline), .tables/.schema/.explain dot-commands, import CSV
web/          Vite app: SQL notebook, plan visualiser, storage inspector, datasets, benchmarks (engine runs in a Worker)
```

Rules:
- Lower layers never import upper layers. `core` imports nothing.
- All async I/O lives in `storage/backend`. Everything above the Pager is **synchronous**: the Pager loads pages through a synchronous backend interface (`readSync`/`writeSync`). Browser OPFS supports this via `FileSystemSyncAccessHandle` inside a Worker; Node via `fs.readSync`/`fs.writeSync`; memory via arrays. The IndexedDB fallback loads the whole file into memory at open and flushes dirty pages asynchronously after commit (documented durability caveat).
- INTEGER is `bigint` end to end. The executor may use `number` arithmetic only when both operands are safe integers; results outside the safe range promote to `bigint` arithmetic.

## Storage

### File format
- Page size 4096 bytes (constant `PAGE_SIZE`). Page 0 and page 1 are **meta pages** (double-buffered). Page ids are uint32; page 0/1 reserved, data begins at page 2.
- Meta page layout: magic `"BASALT01"` (8), format version u32, page size u32, txn id u64, root page id of the master catalog B+tree u32, free-list head page u32, page count u32, checksum u32 (CRC32 of the preceding bytes). The valid meta page is the one with a correct checksum and the higher txn id.
- Every non-meta page: 16-byte header `[type u8][flags u8][cellCount u16][freeStart u16][freeEnd u16][right u32][fragBytes u16][reserved u16]`, then a cell-pointer array (u16 offsets) growing from the header and cells growing from the end (SQLite-style slotted page). `right` is the rightmost child for INTERIOR pages, the next page for OVERFLOW and FREELIST pages, and 0 for LEAF pages: **leaves carry no sibling links** (under copy-on-write a copied leaf would leave its left neighbour's pointer stale), cursors keep the root-to-leaf path instead. `fragBytes` counts dead bytes reclaimed by defragmentation.
- Cells: interior = `[childPage u32][keyLen varint][key bytes]`; leaf = `[keyLen varint][valueLen varint][key bytes][value bytes]`. A cell is at most `MAX_CELL_SIZE` = 1000 bytes (so ≥ 4 cells fit per page); when `key + value` would exceed that, the leaf cell becomes `[keyLen][valueLen][key][overflowPage u32]` and the whole value lives in a chain of **overflow pages** (common header, next page in `right`, 4080 payload bytes each). Keys are limited to `MAX_KEY_SIZE` = 960 bytes.
- Keys are **order-preserving byte encodings** (`core/encoding.ts`) whose memcmp order equals `compareValues`: a type tag byte then payload. NULL `0x01` -> tag only; BOOLEAN `0x02` -> 0/1; **numbers share one ordering domain** (INTEGER and REAL compare numerically) via tags `0x03..0x08` = NaN, -Infinity, finite < -2^63, in-range, finite ≥ 2^63, +Infinity; an in-range number is `0x06` + `floor(x)` as 8 bytes big-endian with the sign bit flipped + a flag byte (`0x00` integral - so 5 and 5.0 encode identically and `decodeKey` yields `5n`; `0x01` + the IEEE754 bits of x transformed so memcmp order == numeric order otherwise); TEXT `0x09` -> CESU-8 (each UTF-16 code unit UTF-8-style, so byte order == JavaScript string order used by `compareValues`) with `0x00` escaped as `0x00 0xFF` and terminated by `0x00 0x00`; BLOB `0x0A` -> same escaping. Composite keys concatenate encoded columns. Secondary index keys = encoded index columns + encoded rowid (so they are unique and point at the row).
- Table rows are stored in a B+tree keyed by the encoded rowid (`bigint`). Row values use a compact record format: header with per-column type codes + varint lengths, then column payloads (like the SQLite record format).

### Copy-on-write B+tree and MVCC
- A write transaction never modifies a page that belongs to a committed snapshot: it copies the page to a fresh page id (from the free list or by extending the file), modifies the copy, and the parent is updated recursively up to the root. Commit = write all dirty pages, fsync, write the new meta page (the *other* of the two meta slots), fsync. A crash at any point leaves the previous meta page valid -> atomic commits without a WAL.
- **Readers** take the current committed root and txn id at `BEGIN` and never block. **Writers** are serialised (one at a time; others queue on a promise). This is the LMDB model; `docs/DESIGN-NOTES.md` explains the trade-off versus a WAL + undo/redo design.
- Pages freed by a write txn (the pre-image pages) are appended to a **pending-free list tagged with the committing txn id** `T`; they are reusable only when every live reader's snapshot id is `>= T` (`FreeList.setBound(min live snapshot id, or last committed id when none)`). Pages allocated and freed inside the same txn are tagged `0` (reusable at once); pages a txn allocated before a savepoint and freed after it are retagged `0` when the savepoint is released (`WriteTxn.release`), so a long transaction of many statements recycles its own pre-images instead of growing the file per statement. The list is persisted at commit into FREELIST trunk pages (`[pageId u32][txnId u64]` entries, chained via `right`; head in meta); the previous trunk pages are freed with the committing txn id, so the free list is itself copy-on-write.
- The `Pager` owns the `BufferPool`: a fixed-capacity page cache with pin counts and CLOCK eviction. Dirty pages belong to the current writer; eviction of dirty pages writes them through (the file is only made *visible* by the meta page swap, so writing early is safe).
- `TransactionManager` exposes `beginRead(): Snapshot`, `beginWrite(): WriteTxn` (throws/queues if a writer is active; the engine serialises statements so in practice one writer exists), `commit(txn)`, `rollback(txn)` (discard dirty pages, return newly allocated pages to the free list). Isolation level: snapshot isolation.

### Module contracts (storage)
```ts
interface Backend { readonly pageSize: number; pageCount(): number; readSync(pageId: number, into: Uint8Array): void; writeSync(pageId: number, data: Uint8Array): void; writeManySync?(firstPageId: number, data: Uint8Array): void /* optional: one write for a run of adjacent pages; commit coalesces dirty pages through it */; extendSync(newPageCount: number): void; syncSync(): void; close(): Promise<void> }
class MemoryBackend implements Backend; class NodeFileBackend implements Backend; class OpfsBackend implements Backend (worker only); class IndexedDbBackend implements Backend (load-all, async flush)
class Pager { constructor(backend: Backend, poolPages = 2048); get(pageId): PageRef /* pinned; unpin() when done */; allocate(): PageRef /* zeroed, pinned, dirty */; free(pageId, txnId); markDirty(pageRef); flush(); sync(); readMeta(): Meta; writeMeta(meta) /* writes the other slot */; discard(pageId); truncate(pageCount); setReusableBound(txnId); stats(); readonly freelist: FreeList }
interface WriteContext { readonly txnId: number; owns(pageId): boolean; allocate(): PageRef; free(pageId): void }   // implemented by txn/WriteTxn so storage never imports txn
class BTree { constructor(pager: Pager, rootPageId: number, txn?: WriteContext); static create(pager, txn): BTree; get(key: Uint8Array): Uint8Array | null; insert(key, value): void /* COW; may change root */; delete(key): boolean; cursor(): BTreeCursor; get root(): number; count(): number; depth(): number; destroy(): void }
class TransactionManager { beginRead(): Snapshot; endRead(snapshot); beginWrite(): WriteTxn /* throws if a writer is active */; commit(txn); rollback(txn) }
class WriteTxn implements WriteContext { txnId; masterRoot /* get/set */; freelistHead; savepoint(): SavepointToken; rollbackTo(token); release(token) }
interface BTreeCursor { seekFirst(); seekLast(); seek(key): boolean /* positions at first key >= key; returns true iff that key equals `key` */; valid(): boolean; key(): Uint8Array; value(): Uint8Array; next(); prev() }
```
B+tree must support: split on insert (leaf and interior), merge/rebalance on delete (borrow from sibling or merge; collapse root), variable-length keys, overflow values, and cursors that stay valid across inserts/deletes made by the same transaction into a *different* tree (the executor materialises target rowids before mutating the tree it scanned; the rule is documented in `btree.ts`). Cursors do not pin pages (they re-fetch the leaf through the cache on each access), so they need no `close()`.
Savepoints are **copy-on-write epochs**, not dirty-page copies: after `savepoint()` the pages allocated earlier in the transaction count as not-owned and are copied before modification, so `rollbackTo()` only drops the pages allocated since the savepoint, un-frees the pages freed since, and restores the root (`docs/DESIGN-NOTES.md`).

## Catalog
System tables live in B+trees whose roots are recorded in `basalt_master` (root recorded in meta): `basalt_master(type, name, tbl_name, rootpage, sql)` exactly like `sqlite_master`, plus `basalt_stats(table, column, n_rows, n_distinct, null_frac, min_key, max_key, histogram_json)` written by `ANALYZE`. The `Catalog` class parses `sql` text with the real parser at open time to rebuild `TableSchema`/`IndexSchema`, caches them, and invalidates on DDL. Each table gets a hidden 64-bit rowid unless a column is declared `INTEGER PRIMARY KEY` (then that column *is* the rowid, as in SQLite).

## SQL surface (must all work)
- DDL: `CREATE TABLE [IF NOT EXISTS] t (col TYPE [PRIMARY KEY] [NOT NULL] [UNIQUE] [DEFAULT expr] [CHECK (expr)] , ..., [PRIMARY KEY (a,b)], [UNIQUE (a,b)])`, `DROP TABLE [IF EXISTS]`, `CREATE [UNIQUE] INDEX [IF NOT EXISTS] i ON t (cols)`, `DROP INDEX`, `CREATE VIEW v AS select`, `DROP VIEW`, `ALTER TABLE t RENAME TO`, `ALTER TABLE t ADD COLUMN`.
- DML: `INSERT INTO t [(cols)] VALUES (...),(...)`, `INSERT INTO t SELECT ...`, `INSERT OR REPLACE`, `UPDATE t SET ... [WHERE]`, `DELETE FROM t [WHERE]`.
- Queries: `SELECT [DISTINCT] exprs | * | t.*`, `FROM` with table aliases, derived tables, `JOIN` variants (INNER, LEFT, RIGHT, FULL OUTER, CROSS, NATURAL, `ON`, `USING`), comma joins, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY expr [ASC|DESC] [NULLS FIRST|LAST]`, `LIMIT n [OFFSET m]`, `UNION [ALL]`, `INTERSECT`, `EXCEPT`, `WITH [RECURSIVE] cte AS (...)`, scalar subqueries, `IN (subquery|list)`, `EXISTS`, correlated subqueries (executed by re-evaluation per row when decorrelation does not apply), `CASE`, `CAST`, `BETWEEN`, `LIKE`/`GLOB` (with ESCAPE), `IS [NOT] NULL`, `IS [NOT] DISTINCT FROM`, `COALESCE`, `NULLIF`, `IIF`, string/math builtins (`length, upper, lower, substr, instr, replace, trim, ltrim, rtrim, abs, round, floor, ceil, sqrt, pow, mod, min(a,b), max(a,b), typeof, hex, random, printf/format`), aggregates `COUNT(*)`, `COUNT(x)`, `COUNT(DISTINCT x)`, `SUM`, `TOTAL`, `AVG`, `MIN`, `MAX`, `GROUP_CONCAT`, window functions `ROW_NUMBER, RANK, DENSE_RANK, NTILE, LAG, LEAD, FIRST_VALUE, LAST_VALUE` and aggregate-as-window (`SUM(x) OVER (PARTITION BY .. ORDER BY .. [ROWS BETWEEN ...])`), `VALUES (...)` as a table.
- Transactions: `BEGIN [TRANSACTION]`, `COMMIT`/`END`, `ROLLBACK`, `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` (savepoints are copy-on-write epochs that record the root; see the storage section).
- Introspection: `EXPLAIN select` -> rows describing the physical plan tree; `EXPLAIN ANALYZE` -> same with actual row counts and time per operator; `ANALYZE`; `VACUUM` (rewrite file compactly); `PRAGMA table_info(t)`, `PRAGMA index_list(t)`, `PRAGMA page_count`, `PRAGMA freelist_count`.
- Three-valued logic for NULL everywhere. SQLite type affinity rules are **not** required, but comparisons across INTEGER/REAL must be numeric and TEXT vs number compares by the total order in `core/types.ts`. Integer division truncates; division by zero yields NULL (SQLite behaviour) - the differential fuzzer depends on matching SQLite here.

### Module contracts (SQL frontend & expression engine)
```ts
// src/sql
tokenize(sql): Token[]                                   // line/col on every token; SyntaxError_ with line/col
parse(sql): Statement[]; parseOne(sql): Statement; parseExpression(sql): Expr   // AST in sql/ast.ts, every node has `loc`
interface SchemaProvider { getTable(name): TableSchema | undefined; getView(name): ViewSchema | undefined; getIndex(name): IndexSchema | undefined; listIndexes(table): IndexSchema[]; tableExists(name): boolean }
interface FunctionProvider { lookup(name): FunctionInfo | undefined }   // arity/kind/return-type metadata; exec/functions.ts `builtinFunctions` implements it
bind(stmt, schema: SchemaProvider, functions: FunctionProvider, { sql? }): BoundStatement   // BindError; bound tree in sql/bound.ts
// src/exec
interface EvalContext { params: readonly Value[]; evalSubquery(sub: BoundSubquery, rows: Row[]): readonly Row[]; random?(): number; now?(): number }
compileExpr(expr: BoundExpr, opts?: CompileOptions): (rows: Row[], ctx: EvalContext) => Value   // compiled once; constant sub-trees folded
class FunctionRegistry { getScalar(name); getAggregate(name) /* {init, step, final} */; getWindow(name) /* {compute(WindowFrameContext)} */; lookup(name) }
```
- **Row layout.** A bound expression is evaluated against `rows: Row[]`, one `Row` per relation of its scope in FROM order; the rows of enclosing scopes are appended after them (outermost last). `BoundColumnRef.rel` is the flat index into that array, `depth/relation` the scope-relative view. A correlated subquery is evaluated with `[...itsOwnRelationRows, ...rows]` where `rows` is exactly the array the outer expression received, so nesting composes. `BoundSubquery.outerRefs` lists the correlated refs (empty => uncorrelated, safe to materialise once).
- **Planner-only nodes.** `aggregate`, `window`, `rowid` and `resultColumn` nodes must be rewritten (or supplied through `CompileOptions` hooks) before compiling; `BoundSelectCore.aggregates/windows` list them by index. `mapColumnRefs` re-layouts column refs without descending into subqueries.
- **Bound DML/DDL conventions.** `BoundInsert.defaults[i]` is the bound DEFAULT per table column (evaluated with `rows = []`); upsert `SET` expressions see `rows[0]` = existing row, `rows[1]` = the `excluded` row; CHECK constraints and partial-index predicates see `rows[0]` = the candidate row; RETURNING sees `rows[0]` = the affected row. `BoundCte.recursive` carries `{anchor, recursiveTerm, unionAll}` for self-referencing CTEs.
- **Deviations / decisions (binding against SQLite behaviour):** numbers are typed by representation - `bigint` is INTEGER, `number` is always REAL (`typeof(5.0)` = `real`), BOOLEAN values coerce to 0/1 and `TRUE`/`FALSE` literals are integers; comparison results are `1n`/`0n`/NULL. Inferred types are `DataType | "ANY"` (`ANY` for parameters and mixed CASE arms). Column declared types follow SQLite affinity rules (`columnDataType`): untyped columns and NUMERIC-affinity names are recorded as `BLOB` / `REAL` respectively, purely informational (no affinity conversion on INSERT). `COLLATE` is parsed and ignored (BINARY only); `upper/lower` and `LIKE` are ASCII-only like SQLite; `abs(INT64_MIN)` throws "integer overflow" (SQLite) while `-INT64_MIN` and `SUM` overflow promote to REAL. Parameters are numbered by order of appearance in the SQL text (`?`, `?NNN`, named reuse). Aggregate queries accept bare non-grouped columns (SQLite leniency). Not supported: generated columns, expression indexes, row values (except `UPDATE SET (a,b) = (x,y)` which the parser expands), `REGEXP`/`MATCH`, triggers, table-valued functions, correlated CTEs. Foreign-key clauses parse but are not bound or enforced.

## Planner
- Logical operators: Scan, Filter, Project, Join(type, condition), Aggregate(groupBy, aggs), Window, Sort, Limit, Distinct, Union/Intersect/Except, Values, CteRef/Recursive, SubqueryScan.
- Rewrite rules (fixpoint): constant folding, predicate pushdown through Project/Join (into the correct join side respecting outer-join semantics), projection pruning, `EXISTS`/`IN (subquery)` -> semi-join, uncorrelated scalar subquery -> materialised constant, Limit pushdown into Sort (top-k), merge adjacent Filters/Projects, outer-join simplification when a null-rejecting predicate exists.
- Cost model: per-table stats from `basalt_stats` (fallback: `count()` of the B+tree and default selectivities). Cardinality estimation for predicates (equality 1/ndv, range via histogram, conjunction with independence assumption and exponential back-off). Join ordering: **dynamic programming over connected subsets** for ≤ 8 relations, greedy otherwise. Physical choices: SeqScan vs IndexScan/IndexRangeScan (covering-index aware), NestedLoopJoin vs HashJoin (equi-join) vs MergeJoin (both inputs already sorted), HashAggregate vs SortedAggregate, Sort vs index-provided order, TopK for ORDER BY + LIMIT.
- Output `PhysicalPlan` is a JSON-serialisable tree: `{ op, estRows, estCost, children, props... }` so the web UI can draw it; `EXPLAIN ANALYZE` adds `actualRows`, `loops`, `ms` per node.

## Executor
- Volcano / iterator model: `interface Operator { open(ctx): void; next(): Row | null; close(): void; readonly schema: ResultColumn[]; stats: {rows, ms} }`.
- Operators: SeqScan, IndexScan, IndexRangeScan, Filter, Project, NestedLoopJoin (all join types), HashJoin (inner/left/right/full/semi/anti), MergeJoin, HashAggregate, SortedAggregate, Window (partition -> sort -> frame evaluation), Sort (in-memory; must spill to a temp B+tree beyond a configurable row threshold), TopK (heap), Limit, Distinct, Union/Intersect/Except (hash-based), Values, Materialize, RecursiveCte, Insert/Update/Delete (with constraint checks and index maintenance), CreateTable/CreateIndex/etc. run as plan nodes too so EXPLAIN works on everything.
- The expression evaluator compiles bound expressions into closures `(row, ctx) => Value` once per plan (no per-row AST walking).
- UPDATE/DELETE must materialise the target rowids first (Halloween problem) because the B+tree they modify is the one they scan.

## Engine API (`src/engine/database.ts`)
```ts
class Database {
  static async open(opts: { backend: Backend } | { memory: true } | { file: string /* node */ } | { opfs: string /* worker */ }): Promise<Database>
  exec(sql: string): QueryResult[]              // runs every statement; auto-commit when not in a txn
  query(sql: string, params?: Value[]): QueryResult // single statement; `?` and `:name` positional/named params
  prepare(sql: string): Statement              // Statement.run(params), .all(params), .iterate(params)
  transaction<T>(fn: (db) => T): T             // BEGIN/COMMIT/ROLLBACK wrapper
  explain(sql: string, analyze = false): PlanNode
  stats(): { pageCount, freePages, cacheHits, cacheMisses, txnId }
  on(event: "commit" | "statement", cb): void
  close(): Promise<void>
}
```
All of `exec/query/prepare` are **synchronous** (storage is sync); only `open`/`close` are async. In the browser the Worker wraps this in a message protocol (`web/src/worker/protocol.ts`).

## Testing strategy (required, in this order of value)
1. **Storage unit tests**: B+tree with 100k random inserts/deletes verified against a sorted Map; cursor ordering; overflow values; crash simulation (write N pages then "crash" by discarding the backend's unsynced writes -> reopen -> previous snapshot intact); free-list reuse; buffer-pool eviction correctness under pin pressure.
2. **sqllogictest-style suites** in `tests/slt/*.slt` run by `tests/slt/runner.test.ts` (format: `statement ok`, `statement error`, `query <types> [nosort|rowsort|valuesort]` + `----` + expected). Cover every SQL feature above.
3. **Differential fuzzing against SQLite** via `node:sqlite` (`scripts/fuzz.ts` and a CI-run smaller variant in `tests/fuzz.test.ts`): generate random schemas + data + SELECT queries from a grammar restricted to the SQLite-compatible subset, run on both, compare sorted results. Any mismatch is a bug (or a documented semantic divergence listed in `docs/SQLITE-DIVERGENCES.md`).
4. **Planner tests**: assert chosen plan shapes (index used, join order) for canonical queries with controlled stats.
5. **MVCC tests**: a reader sees its snapshot while a writer commits; rollback restores; savepoints.
6. **Benchmarks** (`bench/run.ts`): TPC-H-shaped mini schema (customer/orders/lineitem at a small scale factor generated deterministically), report ms per query and rows/s for inserts; results table pasted into README.

## Web app (`web/`)
Design identity: *"the reading room"* - warm paper background `#f5f0e8`, ink `#1b1a17`, one accent (oxidised copper `#2a7f6f`), serif display face (Fraunces) for headings, Inter for UI, JetBrains Mono for SQL and results. Dark theme auto via `prefers-color-scheme`. No frameworks: vanilla TS + small components; CodeMirror 6 is allowed for the SQL editor (the only runtime dependency, web-only).
Screens: (1) **Notebook** - cells of SQL with results grid, ms, row count, keyboard `Ctrl/Cmd+Enter`, persisted to an OPFS database `notebook.basalt`; (2) **Plan** - EXPLAIN ANALYZE tree rendered as an SVG tree with estimated vs actual rows and a heat colour for time, hover shows operator details; (3) **Storage** - live page map (grid of pages coloured by type), click a page to see its decoded header/cells, B+tree depth and fill factor per table, free list, cache hit ratio; (4) **Datasets** - one-click load of bundled datasets (TPC-H mini, a 50k-row synthetic "orders", and a synthetic `world`-style countries/cities schema) with sample queries; (5) **Bench** - run the benchmark suite in the browser and chart results. A `?q=` URL parameter pre-fills a query so the README can deep-link examples.

## Query lifecycle (phase 2)

One statement, `SELECT c.name, sum(o.amount) FROM c JOIN o ON o.cid = c.id WHERE o.amount > 5 GROUP BY c.name ORDER BY 2 DESC LIMIT 3`, travels through these stages:

1. `Database.query` parses the text (`sql/parser.ts`) and classifies the statement: SELECT is read-only, so outside an explicit transaction it runs in a fresh read snapshot (`TransactionManager.beginRead`); write statements take the single writer and commit on success. Inside `BEGIN` the session snapshot or write transaction is reused, and each write statement runs under a savepoint so a failure leaves the transaction intact.
2. The catalog for that snapshot (`Catalog.forSnapshot`, cached per committed txn id) is the `SchemaProvider` for the binder: it rebuilt `TableSchema` / `IndexSchema` / views by parsing every `basalt_master.sql` with the real parser and binder.
3. `bind()` produces the bound tree: column references `(depth, relation, column)`, the aggregate `sum(o.amount)` registered as `BoundSelectCore.aggregates[0]`, ORDER BY 2 as a `resultColumn` reference.
4. `planner/build.ts` turns the core into a logical plan: `Scan(c, rel 0)` and `Scan(o, rel 1)` joined INNER with the ON condition, `Filter(WHERE)`, `Aggregate(groupBy=[c.name], aggs=[sum], passthrough=[])`, `Project`, `Sort`, `Limit`. `IN (subquery)` / `EXISTS` conjuncts become SEMI / ANTI joins here.
5. `planner/rules.ts` runs to a fixpoint: constant folding, `o.amount > 5` pushed below the join onto the scan of `o`, one-sided ON conjuncts pushed, outer joins simplified by null-rejecting predicates, DISTINCT dropped over unique keys, and every scan learns its required columns (covering-index detection).
6. `planner/physical.ts` costs alternatives with `planner/stats.ts` (ANALYZE statistics, live `BTree.count()` fallback, default selectivities) and `planner/cost.ts`: access paths (SeqScan with rowid bounds, RowidLookup, IndexScan with an equality prefix plus one range, order-providing scans in either direction), join order (bitmask DP over subsets up to 8 relations in `join-order.ts`, greedy above), HashJoin for the equi-condition, MergeJoin when both inputs are already ordered, HashAggregate or SortedAggregate, and Sort + Limit folded into TopK. The result is a `PhysicalNode` tree whose every node carries a `Layout`: the meaning of each position of the flat rows it produces.
7. `exec/build.ts` builds Volcano operators. Each expression is re-laid out against the layout stack of the operator that evaluates it (`planner/layout.ts`: `rows[0]` is the operator's own row, `rows[d]` the row of the enclosing scope d levels up) and compiled once with `exec/expr.ts`. Subqueries met on the way are planned and registered on the shared execution state (`SubqueryRunner`, materialised once when uncorrelated, cached by correlated values otherwise).
8. The root operator is opened with an `ExecContext`, pulled to exhaustion and closed; rows and column metadata form the `QueryResult`. `EXPLAIN` renders `toPlanNode()` instead; `EXPLAIN ANALYZE` wraps every operator in a `TimedOperator` first.

### Module contracts (catalog, planner, executor, engine)
```ts
// src/catalog
class Catalog { constructor(pager); forSnapshot(snapshot): SchemaSet; beginWrite(txn): WritableCatalog; committed(w): void; version: number }
class SchemaSet implements SchemaProvider { tables; indexes; views; entries; masterRoot; table(name): TableInfo | undefined; index(name); listIndexInfos(table); rootOf(name); stats(pager): Map<table, TableStats> }
class WritableCatalog implements SchemaProvider { set: SchemaSet; rootOf; setRoot(name, root) /* after every B+tree write */; allocateRowid(table); noteRowid; rowCount(table); createTable(bound); dropTable; createIndex(schema, sql, where); dropIndex; createView; dropView; renameTable; addColumn; renameColumn; ensureStatsTable; flush() /* writes pending master rows, sets txn.masterRoot */; saveState()/restoreState() /* savepoints */ }
interface TableInfo { schema: TableSchema; root; sql; checks: BoundExpr[]; checkText; padDefaults: Value[]; internal }
interface IndexInfo { schema: IndexSchema; root; where?: BoundExpr; auto: boolean }
// src/planner
class Layout { slots: {keys: string[]; name; type}[]; find(key) }   // keys: c0:<rel>:<col>, r0:<rel>, a:<i>, w:<i>, e:<exprKey>, o:<i>
rewriteExpr(expr, stack: Layout[], uses?): BoundExpr                  // bound refs become {rel: depth, column: slot}
buildSelect(select, {schema}): LNode; optimize(plan, schema): LNode; planSelect(select, ctx): PhysicalNode; planInsert/planUpdate/planDelete/planCreateTable
interface PlanContext { schema: SchemaLookup; stats: StatsSource; cteCache? }
type PhysicalNode = PSeqScan | PRowidLookup | PIndexScan | PSubqueryScan | PCteScan | PWorkingTable | PFilter | PProject | PNestedLoop | PHashJoin | PMergeJoin | PHashAggregate | PSortedAggregate | PWindow | PSort | PTopK | PLimit | PDistinct | PSetOp | PValues | PMaterialize | PRecursiveCte | PTruncate | PInsert | PUpdate | PDelete | PCreateTable | PCreateIndex | PCreateView | PDrop | PAlter | PAnalyze | PVacuum | PPragma | PExplain   // each: layout, estRows, estCost, ordering
toPlanNode(node, stats?): PlanNode /* {op, estRows, estCost, props, children, actualRows?, loops?, ms?} */; formatPlan(node): string[]
// src/exec
interface Operator { open(ctx: ExecContext): void; next(): Row | null; close(): void; schema: ResultColumn[]; stats: {rows, ms, loops} }
class SharedExec { storage: StorageAccess; params; subplans; cteRows; workingTables; rowsAffected; lastRowid; random() }
class ExecContext implements EvalContext { shared; outerRows: Row[]; evalSubquery(sub, rows) }
class OperatorBuilder { build(node, outerLayouts): Operator; compile(expr, stack): CompiledExpr; built: Map<PhysicalNode, Operator> }
// src/engine
class Database { static open(opts); exec; query(sql, params?: Value[] | Record<string, Value>); prepare; transaction; explain(sql, analyze?): PlanNode; stats(); on("commit" | "statement", cb); off; close(); tables(); schemaSql(name?); pageMap(): PageInfo[]; describePage(id): PageDetail; btreeStats(name): {depth, pages, fill, entries}; randomSeed?; sortSpillThreshold? }
class Statement { run(params); all; get; iterate; columns; parameterCount }
```

### Deviations and decisions (phase 2)
- Layering: `catalog` and `planner` import the expression engine (`exec/expr.ts`, `exec/functions.ts`) for constant folding, default evaluation and the function registry; they never import operators. `exec` imports `planner` for node types and layouts.
- `basalt_stats` columns are `(tbl, col, n_rows, n_distinct, null_frac, min_key, max_key, histogram_json)`; the histogram is a JSON array of 33 equi-height bucket boundaries.
- Several `Database` handles over one `Backend` share the pager, transaction manager and catalog (registry keyed by backend object); each handle has its own transaction state. `BEGIN` is deferred (reader first, upgrade to writer only if nothing was committed since the snapshot); `BEGIN IMMEDIATE` takes the writer.
- Every statement inside an explicit transaction runs under a savepoint (statement-level atomicity); catalog state is snapshotted alongside.
- UNIQUE / non-rowid PRIMARY KEY constraints are automatic unique indexes `basalt_autoindex_<table>_<n>`. Rows added before `ALTER TABLE ADD COLUMN` are padded on read with the constant default of the column.
- `VACUUM` copies every tree into a fresh in-memory image and writes it over the backend page by page (not crash-safe during the copy; documented limitation). `ALTER TABLE DROP COLUMN` is not supported.
- Sort spills to a temporary B+tree in a scratch `MemoryBackend` above 100k rows (`Database.sortSpillThreshold`); keys are the order-preserving encoding with a NULL-placement flag byte and complemented bytes for DESC.
- Cost constants live in `planner/cost.ts` (sequential page 1.0, random page 1.25 because pages are usually cached, CPU per row 0.01, per expression 0.0025). Without statistics a column is assumed to have max(10% of rows, 200) distinct values; ranges 0.33.
- Public result type `ResultColumn.type` may be `"ANY"` when the type depends on runtime values.
- See `docs/SQLITE-DIVERGENCES.md` for the SQL-level differences from SQLite.
