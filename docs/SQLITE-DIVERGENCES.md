# Deliberate divergences from SQLite

Basalt follows SQLite semantics wherever the differential fuzzer (`tests/fuzz.test.ts`, `scripts/fuzz.ts`) and the
sqllogictest suites can observe them. The following differences are intentional and the fuzz grammar avoids them.

## Types and affinity

- Values are typed by representation: `bigint` is INTEGER, `number` is always REAL. `typeof(5.0)` is `real` (as in
  SQLite), but no column affinity conversion happens on INSERT: a TEXT column stores whatever value it is given, and
  `'12'` stored in an INTEGER column stays TEXT. SQLite would coerce `'12'` to 12.
- Comparisons never apply affinity: `WHERE int_col = '5'` compares INTEGER to TEXT and is false (TEXT sorts after
  numbers), where SQLite would convert the literal. Comparison results are the integers `1` / `0` (or NULL).
- BOOLEAN is a storable type (`TRUE` / `FALSE` literals are integers 1 / 0; booleans normalise to 0 / 1 in comparisons,
  hashing and index keys).
- Numbers share one ordering domain in index keys, so `5` and `5.0` are the same key: a UNIQUE index treats them as
  duplicates (SQLite does too) and an index scan decoding keys yields INTEGER for integral REAL values; table rows keep
  the exact type because scans read the record, not the key.

## SQL surface

- Not supported: generated columns, expression indexes, partial indexes as access paths (they are maintained and
  enforce uniqueness but scans do not use them), `REGEXP` / `MATCH`, triggers, table-valued functions, correlated
  CTEs, lateral references between FROM items, `ALTER TABLE DROP COLUMN`, `ATTACH`, collations other than BINARY,
  `INDEXED BY` on an unusable index (falls back to a full index scan).
- `INSERT OR ROLLBACK` / `OR FAIL` / `OR ABORT` all behave as ABORT: the statement is rolled back, the transaction
  stays open.
- `ON CONFLICT DO UPDATE`: unqualified names refer to the target row; the candidate row must be named `excluded.col`.
- Foreign keys parse but are not enforced.
- `IN (list)` predicates do not use indexes; `LIKE 'abc%'` does not become an index range.
- A recursive CTE with `LIMIT` stops producing rows once the limit is reached (queue order); `ORDER BY` without a
  LIMIT sorts the final result instead of prioritising the recursion queue as SQLite does.
- `EXPLAIN` returns one text line per plan node (PostgreSQL style) instead of VDBE opcodes; `EXPLAIN QUERY PLAN` is
  accepted and produces the same output.
- `PRAGMA`s other than `table_info`, `index_list`, `index_info`, `table_list`, `page_count`, `freelist_count`,
  `page_size`, `cache_size`, `user_version`, `journal_mode`, `foreign_keys`, `synchronous` and `encoding` are ignored.

## Transactions and storage

- `BEGIN` is deferred: a transaction becomes a reader with its first SELECT and can only be upgraded to the writer
  while nothing has been committed since its snapshot (otherwise `TransactionError`, where SQLite returns
  `SQLITE_BUSY_SNAPSHOT`). `BEGIN IMMEDIATE` takes the writer at once. One writer at a time across handles.
- `VACUUM` rewrites the file in place from a compact image and is not crash-safe while the pages are being written.
- Automatic indexes for UNIQUE / PRIMARY KEY constraints are named `basalt_autoindex_<table>_<n>` and have a synthetic
  `CREATE UNIQUE INDEX` statement in `basalt_master.sql` (SQLite stores NULL).
- `basalt_master` and `basalt_stats` replace `sqlite_master` / `sqlite_stat1`.

## Builtins

- `random()` is seedable per `Database` (`db.randomSeed`), `current_timestamp` and friends are fixed per statement.
- `upper` / `lower` / `LIKE` are ASCII-only, as in SQLite without ICU.
