# Basalt — architecture and module contracts

Basalt is a relational database engine written from scratch in TypeScript with zero runtime dependencies. It runs in Node (file-backed) and in the browser (OPFS inside a Web Worker, IndexedDB fallback, or purely in memory). This document is the contract every module is built against. Where code and this document disagree, fix the code or update this document in the same change.

## Layering (bottom → top)

```
src/core      Value/Row/Schema types, comparison order, key encoding, varints, errors        (no deps)
src/storage   Backend (bytes on disk) → Pager/BufferPool (page cache) → COW B+tree → FreeList (reclaimed pages)
src/txn       TransactionManager: snapshot isolation on top of copy-on-write roots; single writer, many readers
src/catalog   System tables (tables, columns, indexes, stats) stored in ordinary B+trees; schema cache
src/sql       Lexer → Parser → AST → Binder (name resolution, type inference) → bound tree
src/planner   Bound tree → logical plan → rewrite rules → cost-based join ordering + index selection → physical plan
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
- Every B+tree page: header `[type u8][flags u8][cellCount u16][freeStart u16][freeEnd u16][rightSibling u32 (leaf) | rightmostChild u32 (interior)][reserved]`, then a cell-pointer array (u16 offsets) growing from the header and cells growing from the end (SQLite-style slotted page).
- Cells: interior = `[childPage u32][keyLen varint][key bytes]`; leaf = `[keyLen varint][valueLen varint][key bytes][value bytes]`. Values larger than ~1/4 page spill to **overflow pages** (chain of pages, first 4 bytes = next page id).
- Keys are **order-preserving byte encodings** (`core/encoding.ts`): a type tag byte then: NULL → tag only; BOOLEAN → 0/1; INTEGER → tag + 8 bytes big-endian with sign bit flipped; REAL → tag + IEEE754 bits transformed so memcmp order == numeric order; TEXT → tag + UTF-8 with `0x00` escaped as `0x00 0xFF` and terminated by `0x00 0x00`; BLOB → same escaping. Composite keys concatenate encoded columns. Secondary index keys = encoded index columns + encoded rowid (so they are unique and point at the row).
- Table rows are stored in a B+tree keyed by the encoded rowid (`bigint`). Row values use a compact record format: header with per-column type codes + varint lengths, then column payloads (like the SQLite record format).

### Copy-on-write B+tree and MVCC
- A write transaction never modifies a page that belongs to a committed snapshot: it copies the page to a fresh page id (from the free list or by extending the file), modifies the copy, and the parent is updated recursively up to the root. Commit = write all dirty pages, fsync, write the new meta page (the *other* of the two meta slots), fsync. A crash at any point leaves the previous meta page valid → atomic commits without a WAL.
- **Readers** take the current committed root and txn id at `BEGIN` and never block. **Writers** are serialised (one at a time; others queue on a promise). This is the LMDB model; `docs/DESIGN-NOTES.md` explains the trade-off versus a WAL + undo/redo design.
- Pages freed by a write txn (the pre-image pages) are appended to a **pending-free list tagged with the committing txn id**; they are reusable only when no live reader has a snapshot older than that txn id. `FreeList` tracks this.
- The `Pager` owns the `BufferPool`: a fixed-capacity page cache with pin counts and CLOCK eviction. Dirty pages belong to the current writer; eviction of dirty pages writes them through (the file is only made *visible* by the meta page swap, so writing early is safe).
- `TransactionManager` exposes `beginRead(): Snapshot`, `beginWrite(): WriteTxn` (throws/queues if a writer is active; the engine serialises statements so in practice one writer exists), `commit(txn)`, `rollback(txn)` (discard dirty pages, return newly allocated pages to the free list). Isolation level: snapshot isolation.

### Module contracts (storage)
```ts
interface Backend { readonly pageSize: number; pageCount(): number; readSync(pageId: number, into: Uint8Array): void; writeSync(pageId: number, data: Uint8Array): void; extendSync(newPageCount: number): void; syncSync(): void; close(): Promise<void> }
class MemoryBackend implements Backend; class NodeFileBackend implements Backend; class OpfsBackend implements Backend (worker only); class IndexedDbBackend implements Backend (load-all, async flush)
class Pager { constructor(backend: Backend, poolPages = 2048); get(pageId): PageRef /* pinned */; allocate(): PageRef; free(pageId, txnId); markDirty(pageRef); flush(); readMeta(): Meta; writeMeta(meta) }
class BTree { constructor(pager: Pager, rootPageId: number, txn?: WriteTxn); get(key: Uint8Array): Uint8Array | null; insert(key, value): void /* COW; may change root */; delete(key): boolean; cursor(): BTreeCursor; get root(): number; count(): number }
interface BTreeCursor { seekFirst(); seekLast(); seek(key): boolean /* positions at first key >= key */; valid(): boolean; key(): Uint8Array; value(): Uint8Array; next(); prev() }
```
B+tree must support: split on insert (leaf and interior), merge/rebalance on delete (borrow from sibling or merge; collapse root), variable-length keys, overflow values, and cursors that stay valid across inserts/deletes made by the same transaction into a *different* tree (the executor materialises target rowids before mutating the tree it scanned; document the rule in code).

## Catalog
System tables live in B+trees whose roots are recorded in `basalt_master` (root recorded in meta): `basalt_master(type, name, tbl_name, rootpage, sql)` exactly like `sqlite_master`, plus `basalt_stats(table, column, n_rows, n_distinct, null_frac, min_key, max_key, histogram_json)` written by `ANALYZE`. The `Catalog` class parses `sql` text with the real parser at open time to rebuild `TableSchema`/`IndexSchema`, caches them, and invalidates on DDL. Each table gets a hidden 64-bit rowid unless a column is declared `INTEGER PRIMARY KEY` (then that column *is* the rowid, as in SQLite).

## SQL surface (must all work)
- DDL: `CREATE TABLE [IF NOT EXISTS] t (col TYPE [PRIMARY KEY] [NOT NULL] [UNIQUE] [DEFAULT expr] [CHECK (expr)] , ..., [PRIMARY KEY (a,b)], [UNIQUE (a,b)])`, `DROP TABLE [IF EXISTS]`, `CREATE [UNIQUE] INDEX [IF NOT EXISTS] i ON t (cols)`, `DROP INDEX`, `CREATE VIEW v AS select`, `DROP VIEW`, `ALTER TABLE t RENAME TO`, `ALTER TABLE t ADD COLUMN`.
- DML: `INSERT INTO t [(cols)] VALUES (...),(...)`, `INSERT INTO t SELECT ...`, `INSERT OR REPLACE`, `UPDATE t SET ... [WHERE]`, `DELETE FROM t [WHERE]`.
- Queries: `SELECT [DISTINCT] exprs | * | t.*`, `FROM` with table aliases, derived tables, `JOIN` variants (INNER, LEFT, RIGHT, FULL OUTER, CROSS, NATURAL, `ON`, `USING`), comma joins, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY expr [ASC|DESC] [NULLS FIRST|LAST]`, `LIMIT n [OFFSET m]`, `UNION [ALL]`, `INTERSECT`, `EXCEPT`, `WITH [RECURSIVE] cte AS (...)`, scalar subqueries, `IN (subquery|list)`, `EXISTS`, correlated subqueries (executed by re-evaluation per row when decorrelation does not apply), `CASE`, `CAST`, `BETWEEN`, `LIKE`/`GLOB` (with ESCAPE), `IS [NOT] NULL`, `IS [NOT] DISTINCT FROM`, `COALESCE`, `NULLIF`, `IIF`, string/math builtins (`length, upper, lower, substr, instr, replace, trim, ltrim, rtrim, abs, round, floor, ceil, sqrt, pow, mod, min(a,b), max(a,b), typeof, hex, random, printf/format`), aggregates `COUNT(*)`, `COUNT(x)`, `COUNT(DISTINCT x)`, `SUM`, `TOTAL`, `AVG`, `MIN`, `MAX`, `GROUP_CONCAT`, window functions `ROW_NUMBER, RANK, DENSE_RANK, NTILE, LAG, LEAD, FIRST_VALUE, LAST_VALUE` and aggregate-as-window (`SUM(x) OVER (PARTITION BY .. ORDER BY .. [ROWS BETWEEN ...])`), `VALUES (...)` as a table.
- Transactions: `BEGIN [TRANSACTION]`, `COMMIT`/`END`, `ROLLBACK`, `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` (savepoints snapshot the dirty-page set and root).
- Introspection: `EXPLAIN select` → rows describing the physical plan tree; `EXPLAIN ANALYZE` → same with actual row counts and time per operator; `ANALYZE`; `VACUUM` (rewrite file compactly); `PRAGMA table_info(t)`, `PRAGMA index_list(t)`, `PRAGMA page_count`, `PRAGMA freelist_count`.
- Three-valued logic for NULL everywhere. SQLite type affinity rules are **not** required, but comparisons across INTEGER/REAL must be numeric and TEXT vs number compares by the total order in `core/types.ts`. Integer division truncates; division by zero yields NULL (SQLite behaviour) — the differential fuzzer depends on matching SQLite here.

## Planner
- Logical operators: Scan, Filter, Project, Join(type, condition), Aggregate(groupBy, aggs), Window, Sort, Limit, Distinct, Union/Intersect/Except, Values, CteRef/Recursive, SubqueryScan.
- Rewrite rules (fixpoint): constant folding, predicate pushdown through Project/Join (into the correct join side respecting outer-join semantics), projection pruning, `EXISTS`/`IN (subquery)` → semi-join, uncorrelated scalar subquery → materialised constant, Limit pushdown into Sort (top-k), merge adjacent Filters/Projects, outer-join simplification when a null-rejecting predicate exists.
- Cost model: per-table stats from `basalt_stats` (fallback: `count()` of the B+tree and default selectivities). Cardinality estimation for predicates (equality 1/ndv, range via histogram, conjunction with independence assumption and exponential back-off). Join ordering: **dynamic programming over connected subsets** for ≤ 8 relations, greedy otherwise. Physical choices: SeqScan vs IndexScan/IndexRangeScan (covering-index aware), NestedLoopJoin vs HashJoin (equi-join) vs MergeJoin (both inputs already sorted), HashAggregate vs SortedAggregate, Sort vs index-provided order, TopK for ORDER BY + LIMIT.
- Output `PhysicalPlan` is a JSON-serialisable tree: `{ op, estRows, estCost, children, props... }` so the web UI can draw it; `EXPLAIN ANALYZE` adds `actualRows`, `loops`, `ms` per node.

## Executor
- Volcano / iterator model: `interface Operator { open(ctx): void; next(): Row | null; close(): void; readonly schema: ResultColumn[]; stats: {rows, ms} }`.
- Operators: SeqScan, IndexScan, IndexRangeScan, Filter, Project, NestedLoopJoin (all join types), HashJoin (inner/left/right/full/semi/anti), MergeJoin, HashAggregate, SortedAggregate, Window (partition → sort → frame evaluation), Sort (in-memory; must spill to a temp B+tree beyond a configurable row threshold), TopK (heap), Limit, Distinct, Union/Intersect/Except (hash-based), Values, Materialize, RecursiveCte, Insert/Update/Delete (with constraint checks and index maintenance), CreateTable/CreateIndex/etc. run as plan nodes too so EXPLAIN works on everything.
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
1. **Storage unit tests**: B+tree with 100k random inserts/deletes verified against a sorted Map; cursor ordering; overflow values; crash simulation (write N pages then "crash" by discarding the backend's unsynced writes → reopen → previous snapshot intact); free-list reuse; buffer-pool eviction correctness under pin pressure.
2. **sqllogictest-style suites** in `tests/slt/*.slt` run by `tests/slt/runner.test.ts` (format: `statement ok`, `statement error`, `query <types> [nosort|rowsort|valuesort]` + `----` + expected). Cover every SQL feature above.
3. **Differential fuzzing against SQLite** via `node:sqlite` (`scripts/fuzz.ts` and a CI-run smaller variant in `tests/fuzz.test.ts`): generate random schemas + data + SELECT queries from a grammar restricted to the SQLite-compatible subset, run on both, compare sorted results. Any mismatch is a bug (or a documented semantic divergence listed in `docs/SQLITE-DIVERGENCES.md`).
4. **Planner tests**: assert chosen plan shapes (index used, join order) for canonical queries with controlled stats.
5. **MVCC tests**: a reader sees its snapshot while a writer commits; rollback restores; savepoints.
6. **Benchmarks** (`bench/run.ts`): TPC-H-shaped mini schema (customer/orders/lineitem at a small scale factor generated deterministically), report ms per query and rows/s for inserts; results table pasted into README.

## Web app (`web/`)
Design identity: *"the reading room"* — warm paper background `#f5f0e8`, ink `#1b1a17`, one accent (oxidised copper `#2a7f6f`), serif display face (Fraunces) for headings, Inter for UI, JetBrains Mono for SQL and results. Dark theme auto via `prefers-color-scheme`. No frameworks: vanilla TS + small components; CodeMirror 6 is allowed for the SQL editor (the only runtime dependency, web-only).
Screens: (1) **Notebook** — cells of SQL with results grid, ms, row count, keyboard `Ctrl/Cmd+Enter`, persisted to an OPFS database `notebook.basalt`; (2) **Plan** — EXPLAIN ANALYZE tree rendered as an SVG tree with estimated vs actual rows and a heat colour for time, hover shows operator details; (3) **Storage** — live page map (grid of pages coloured by type), click a page to see its decoded header/cells, B+tree depth and fill factor per table, free list, cache hit ratio; (4) **Datasets** — one-click load of bundled datasets (TPC-H mini, a 50k-row synthetic "orders", and a synthetic `world`-style countries/cities schema) with sample queries; (5) **Bench** — run the benchmark suite in the browser and chart results. A `?q=` URL parameter pre-fills a query so the README can deep-link examples.
