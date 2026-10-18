import { describe, expect, it } from "vitest";
import { parse, parseExpression, parseOne } from "../../src/sql/parser.js";
import { SyntaxError_ } from "../../src/core/errors.js";
import type { Expr, SelectCore, SelectStmt, Statement } from "../../src/sql/ast.js";

/** Strip `loc` fields so AST shapes can be compared structurally. */
function strip<T>(node: T): T {
  return JSON.parse(JSON.stringify(node, (k, v) => (k === "loc" ? undefined : typeof v === "bigint" ? `${v}n` : v))) as T;
}
const expr = (sql: string): unknown => strip(parseExpression(sql));
const sel = (sql: string): SelectStmt => parseOne(sql) as SelectStmt;
const core = (sql: string): SelectCore => sel(sql).body as SelectCore;

describe("parser: whole SQL surface parses", () => {
  const statements = [
    // SELECT basics
    "SELECT 1", "SELECT 1, 2, 3", "SELECT *", "SELECT * FROM t", "SELECT t.* FROM t", "SELECT a, b AS c, d e FROM t",
    "SELECT DISTINCT a FROM t", "SELECT ALL a FROM t", "SELECT a FROM t WHERE a > 1", "SELECT a FROM t WHERE a > 1 AND b IS NOT NULL",
    "SELECT a, count(*) FROM t GROUP BY a", "SELECT a FROM t GROUP BY a HAVING count(*) > 1", "SELECT a FROM t GROUP BY 1, 2",
    "SELECT a FROM t ORDER BY a", "SELECT a FROM t ORDER BY a DESC, b ASC", "SELECT a FROM t ORDER BY a NULLS FIRST", "SELECT a FROM t ORDER BY a DESC NULLS LAST",
    "SELECT a FROM t ORDER BY a COLLATE NOCASE DESC", "SELECT a FROM t ORDER BY 1", "SELECT a FROM t LIMIT 10", "SELECT a FROM t LIMIT 10 OFFSET 5", "SELECT a FROM t LIMIT 5, 10",
    "SELECT a FROM t WHERE a = 1 GROUP BY a HAVING a > 0 ORDER BY a LIMIT 1 OFFSET 2",
    // FROM / joins
    "SELECT * FROM t AS x", "SELECT * FROM t x", "SELECT * FROM a, b", "SELECT * FROM a, b, c", "SELECT * FROM a JOIN b ON a.id = b.id",
    "SELECT * FROM a INNER JOIN b ON a.id = b.id", "SELECT * FROM a LEFT JOIN b ON a.id = b.id", "SELECT * FROM a LEFT OUTER JOIN b ON a.id = b.id",
    "SELECT * FROM a RIGHT JOIN b ON a.id = b.id", "SELECT * FROM a RIGHT OUTER JOIN b USING (id)", "SELECT * FROM a FULL JOIN b ON a.id = b.id", "SELECT * FROM a FULL OUTER JOIN b USING (id, x)",
    "SELECT * FROM a CROSS JOIN b", "SELECT * FROM a NATURAL JOIN b", "SELECT * FROM a NATURAL LEFT JOIN b", "SELECT * FROM a JOIN b USING (id)",
    "SELECT * FROM a JOIN b ON a.id = b.id JOIN c ON b.id = c.id LEFT JOIN d USING (k)", "SELECT * FROM (a JOIN b ON a.x = b.x) JOIN c ON c.y = a.y",
    "SELECT * FROM (SELECT 1 AS x) AS sub", "SELECT * FROM (SELECT 1 AS x) sub", "SELECT * FROM (SELECT 1)", "SELECT * FROM (VALUES (1, 2), (3, 4)) AS v",
    "SELECT * FROM t INDEXED BY idx", "SELECT * FROM t NOT INDEXED", "SELECT * FROM main.t", "SELECT main.t.a FROM main.t",
    "SELECT * FROM t WHERE a IN (SELECT b FROM u WHERE u.c = t.c)", "SELECT * FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.id = t.id)",
    // compound
    "SELECT 1 UNION SELECT 2", "SELECT 1 UNION ALL SELECT 2", "SELECT 1 INTERSECT SELECT 2", "SELECT 1 EXCEPT SELECT 2",
    "SELECT 1 UNION SELECT 2 UNION ALL SELECT 3 INTERSECT SELECT 4 EXCEPT SELECT 5 ORDER BY 1 LIMIT 3",
    "SELECT a FROM t UNION SELECT b FROM u ORDER BY a DESC", "VALUES (1, 2), (3, 4)", "VALUES (1) UNION ALL VALUES (2)", "(SELECT 1) UNION (SELECT 2)",
    // CTEs
    "WITH x AS (SELECT 1) SELECT * FROM x", "WITH x(a, b) AS (SELECT 1, 2) SELECT a FROM x", "WITH x AS (SELECT 1), y AS (SELECT * FROM x) SELECT * FROM y",
    "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 10) SELECT x FROM cnt",
    "WITH RECURSIVE cnt(x) AS (VALUES (1) UNION ALL SELECT x + 1 FROM cnt LIMIT 5) SELECT x FROM cnt",
    "WITH x AS MATERIALIZED (SELECT 1) SELECT * FROM x", "WITH x AS NOT MATERIALIZED (SELECT 1) SELECT * FROM x",
    // expressions
    "SELECT a + b * c - d / e % f FROM t", "SELECT a || b || c FROM t", "SELECT a << 1, a >> 2, a & 3, a | 4, ~a FROM t", "SELECT -a, +a, NOT a FROM t",
    "SELECT a < b, a <= b, a > b, a >= b, a = b, a == b, a != b, a <> b FROM t", "SELECT a IS b, a IS NOT b, a IS NULL, a IS NOT NULL, a ISNULL, a NOTNULL, a NOT NULL FROM t",
    "SELECT a IS DISTINCT FROM b, a IS NOT DISTINCT FROM b FROM t", "SELECT a BETWEEN 1 AND 2, a NOT BETWEEN 1 AND 2 FROM t",
    "SELECT a IN (1, 2, 3), a NOT IN (1, 2), a IN (), a IN (SELECT b FROM u), a NOT IN (SELECT b FROM u), a IN u FROM t",
    "SELECT a LIKE 'x%', a NOT LIKE 'x%', a LIKE 'x%' ESCAPE '\\', a GLOB '*x', a NOT GLOB 'y*' FROM t",
    "SELECT CASE WHEN a THEN 1 WHEN b THEN 2 ELSE 3 END FROM t", "SELECT CASE a WHEN 1 THEN 'x' WHEN 2 THEN 'y' END FROM t", "SELECT CASE WHEN a THEN 1 END FROM t",
    "SELECT CAST(a AS INTEGER), CAST(b AS VARCHAR(20)), CAST(c AS DOUBLE PRECISION), CAST(d AS NUMERIC(10, 2)) FROM t",
    "SELECT EXISTS (SELECT 1), NOT EXISTS (SELECT 1), (SELECT max(x) FROM t) FROM t", "SELECT a COLLATE NOCASE FROM t", "SELECT a COLLATE NOCASE = b FROM t",
    "SELECT ?, ?3, :name, @name, $name FROM t", "SELECT x'DEAD', 1e10, .5, 0x1F, 'it''s', \"quoted\", [bracket], `tick`", "SELECT NULL, TRUE, FALSE, CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_TIME",
    "SELECT raise(abort, 'msg'), raise(ignore)", "SELECT (1 + 2) * 3", "SELECT ((1))", "SELECT -(-1)", "SELECT 1 - -1", "SELECT - -1", "SELECT 2 * -3",
    // functions, aggregates, windows
    "SELECT count(*), count(x), count(DISTINCT x), sum(x), total(x), avg(x), min(x), max(x), group_concat(x), group_concat(x, ';') FROM t",
    "SELECT sum(x) FILTER (WHERE x > 0) FROM t", "SELECT coalesce(a, b, c), nullif(a, b), iif(a, b, c), length(a), upper(a), substr(a, 1, 2), printf('%d', a) FROM t",
    "SELECT row_number() OVER () FROM t", "SELECT row_number() OVER (ORDER BY a) FROM t", "SELECT rank() OVER (PARTITION BY a ORDER BY b DESC) FROM t",
    "SELECT sum(x) OVER (PARTITION BY a ORDER BY b ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM t",
    "SELECT sum(x) OVER (ORDER BY b ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t", "SELECT sum(x) OVER (ORDER BY b RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t",
    "SELECT sum(x) OVER (ORDER BY b GROUPS BETWEEN 2 PRECEDING AND CURRENT ROW EXCLUDE TIES) FROM t", "SELECT sum(x) OVER (ORDER BY b ROWS 3 PRECEDING) FROM t",
    "SELECT sum(x) OVER (ORDER BY b ROWS CURRENT ROW EXCLUDE CURRENT ROW) FROM t", "SELECT sum(x) OVER (ROWS UNBOUNDED PRECEDING EXCLUDE GROUP) FROM t", "SELECT sum(x) OVER (ROWS UNBOUNDED PRECEDING EXCLUDE NO OTHERS) FROM t",
    "SELECT lag(x) OVER w, lead(x, 1) OVER w, lag(x, 1, 0) OVER w FROM t WINDOW w AS (ORDER BY y)", "SELECT first_value(x) OVER w1, last_value(x) OVER w2 FROM t WINDOW w1 AS (PARTITION BY a), w2 AS (w1 ORDER BY b)",
    "SELECT ntile(4) OVER (ORDER BY x), dense_rank() OVER (ORDER BY x), percent_rank() OVER (ORDER BY x), cume_dist() OVER (ORDER BY x), nth_value(x, 2) OVER (ORDER BY x) FROM t",
    "SELECT count(*) FILTER (WHERE x) OVER (PARTITION BY y) FROM t",
    // INSERT
    "INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (1, 'a', NULL)", "INSERT INTO t (a, b) VALUES (1, 2), (3, 4)", "INSERT INTO t DEFAULT VALUES",
    "INSERT INTO t SELECT * FROM u", "INSERT INTO t (a) SELECT b FROM u WHERE b > 1 ORDER BY b LIMIT 3", "INSERT OR REPLACE INTO t VALUES (1)", "INSERT OR IGNORE INTO t VALUES (1)",
    "INSERT OR ABORT INTO t VALUES (1)", "INSERT OR FAIL INTO t VALUES (1)", "INSERT OR ROLLBACK INTO t VALUES (1)", "REPLACE INTO t VALUES (1)", "INSERT INTO main.t VALUES (1)",
    "INSERT INTO t AS x VALUES (1) ON CONFLICT (a) DO UPDATE SET b = excluded.b WHERE x.b < excluded.b", "INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING",
    "INSERT INTO t VALUES (1) ON CONFLICT (a) WHERE a > 0 DO NOTHING", "INSERT INTO t VALUES (1) RETURNING *", "INSERT INTO t VALUES (1) RETURNING a, b AS c",
    "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", "INSERT INTO t VALUES (1) UNION ALL VALUES (2)", "INSERT INTO t VALUES ((SELECT max(a) FROM t) + 1)",
    // UPDATE / DELETE
    "UPDATE t SET a = 1", "UPDATE t SET a = 1, b = a + 1 WHERE c > 2", "UPDATE OR REPLACE t SET a = 1", "UPDATE OR IGNORE t SET a = 1", "UPDATE t AS x SET a = 1 WHERE x.b = 2",
    "UPDATE t SET a = 1 FROM u WHERE t.id = u.id", "UPDATE t SET a = 1 RETURNING a", "UPDATE t SET (a, b) = (1, 2)", "WITH x AS (SELECT 1 AS v) UPDATE t SET a = (SELECT v FROM x)",
    "DELETE FROM t", "DELETE FROM t WHERE a = 1", "DELETE FROM t AS x WHERE x.a = 1", "DELETE FROM t WHERE a = 1 RETURNING *", "WITH x AS (SELECT 1) DELETE FROM t WHERE a IN (SELECT * FROM x)", "DELETE FROM t INDEXED BY i WHERE a = 1",
    // CREATE TABLE
    "CREATE TABLE t (a)", "CREATE TABLE t (a INTEGER)", "CREATE TABLE t (a INTEGER, b TEXT, c REAL, d BLOB, e NUMERIC)",
    "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, age INT DEFAULT 0 CHECK (age >= 0), price REAL DEFAULT -1.5, d TEXT DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)", "CREATE TABLE t (id INTEGER PRIMARY KEY DESC)", "CREATE TABLE t (id INTEGER PRIMARY KEY ON CONFLICT REPLACE)",
    "CREATE TABLE t (a, b, PRIMARY KEY (a, b))", "CREATE TABLE t (a, b, UNIQUE (a, b))", "CREATE TABLE t (a, b, CHECK (a > b))", "CREATE TABLE t (a, CONSTRAINT pk PRIMARY KEY (a), CONSTRAINT u UNIQUE (a))",
    "CREATE TABLE t (a REFERENCES u(id) ON DELETE CASCADE ON UPDATE SET NULL)", "CREATE TABLE t (a, FOREIGN KEY (a) REFERENCES u(id) DEFERRABLE INITIALLY DEFERRED)",
    "CREATE TABLE IF NOT EXISTS t (a)", "CREATE TEMP TABLE t (a)", "CREATE TEMPORARY TABLE t (a)", "CREATE TABLE t AS SELECT * FROM u", "CREATE TABLE t (a) WITHOUT ROWID", "CREATE TABLE t (a) STRICT",
    "CREATE TABLE t (a VARCHAR(20), b DOUBLE PRECISION, c UNSIGNED BIG INT, d NUMERIC(10, 2), e CHARACTER VARYING(10))",
    "CREATE TABLE t (a TEXT DEFAULT ('x'), b INTEGER DEFAULT (1 + 2), c TEXT DEFAULT 'lit', d INTEGER DEFAULT -5, e INTEGER DEFAULT +5, f INTEGER DEFAULT NULL, g INTEGER DEFAULT TRUE)",
    "CREATE TABLE t (a TEXT COLLATE NOCASE, b TEXT NOT NULL ON CONFLICT IGNORE, c TEXT UNIQUE ON CONFLICT FAIL, d TEXT NULL)",
    "CREATE TABLE t (a INTEGER GENERATED ALWAYS AS (b + 1) STORED, b INTEGER, c AS (b * 2))",
    "CREATE TABLE t (key TEXT, value TEXT, first INTEGER, last INTEGER, row INTEGER, filter TEXT, range TEXT, offset INTEGER, rows INTEGER, over TEXT, partition TEXT)",
    "CREATE TABLE main.t (a)", "CREATE TABLE \"quoted name\" ([a b] INTEGER, `c` TEXT)",
    // other DDL
    "DROP TABLE t", "DROP TABLE IF EXISTS t", "DROP TABLE main.t", "DROP INDEX i", "DROP INDEX IF EXISTS i", "DROP VIEW v", "DROP VIEW IF EXISTS v",
    "CREATE INDEX i ON t (a)", "CREATE INDEX i ON t (a, b)", "CREATE UNIQUE INDEX i ON t (a)", "CREATE INDEX IF NOT EXISTS i ON t (a)", "CREATE UNIQUE INDEX IF NOT EXISTS i ON t (a DESC, b ASC)",
    "CREATE INDEX i ON t (a COLLATE NOCASE)", "CREATE INDEX i ON t (a) WHERE a > 0", "CREATE INDEX i ON t (lower(a))", "CREATE INDEX main.i ON t (a)",
    "CREATE VIEW v AS SELECT a FROM t", "CREATE VIEW IF NOT EXISTS v AS SELECT 1", "CREATE TEMP VIEW v AS SELECT 1", "CREATE VIEW v (x, y) AS SELECT a, b FROM t",
    "ALTER TABLE t RENAME TO u", "ALTER TABLE t ADD COLUMN c INTEGER DEFAULT 0", "ALTER TABLE t ADD c TEXT NOT NULL DEFAULT 'x'", "ALTER TABLE t RENAME COLUMN a TO b", "ALTER TABLE t RENAME a TO b", "ALTER TABLE t DROP COLUMN a", "ALTER TABLE t DROP a",
    // transactions
    "BEGIN", "BEGIN TRANSACTION", "BEGIN DEFERRED", "BEGIN IMMEDIATE TRANSACTION", "BEGIN EXCLUSIVE", "COMMIT", "COMMIT TRANSACTION", "END", "END TRANSACTION",
    "ROLLBACK", "ROLLBACK TRANSACTION", "ROLLBACK TO sp", "ROLLBACK TO SAVEPOINT sp", "ROLLBACK TRANSACTION TO SAVEPOINT sp", "SAVEPOINT sp", "RELEASE sp", "RELEASE SAVEPOINT sp",
    // introspection
    "EXPLAIN SELECT 1", "EXPLAIN ANALYZE SELECT * FROM t", "EXPLAIN QUERY PLAN SELECT 1", "EXPLAIN INSERT INTO t VALUES (1)", "EXPLAIN ANALYZE UPDATE t SET a = 1", "ANALYZE", "ANALYZE t", "ANALYZE main.t", "VACUUM",
    "PRAGMA table_info(t)", "PRAGMA index_list(t)", "PRAGMA page_count", "PRAGMA freelist_count", "PRAGMA foreign_keys = ON", "PRAGMA main.cache_size = -2000", "PRAGMA journal_mode = 'wal'", "PRAGMA user_version = 3",
    // multiple statements & separators
    "SELECT 1; SELECT 2;", ";;SELECT 1;;", "SELECT 1;\n\nSELECT 2", "CREATE TABLE t (a); INSERT INTO t VALUES (1); SELECT * FROM t;",
    // non-reserved keywords as identifiers
    "SELECT first, last, key, value, filter, over, partition, range, rows, window_name, action, plan FROM t", "SELECT * FROM key", "SELECT key.value FROM key",
    // comments
    "SELECT x FROM t WHERE x = 'a' -- comment\n AND y = /* block\n comment */ 'b'",
  ];

  for (const sql of statements) {
    it(`parses: ${sql.replace(/\s+/g, " ").slice(0, 90)}`, () => {
      expect(() => parse(sql)).not.toThrow();
    });
  }

  it("counts multiple statements", () => {
    expect(parse("SELECT 1; SELECT 2;").length).toBe(2);
    expect(parse(";;SELECT 1;;").length).toBe(1);
    expect(parse("").length).toBe(0);
    expect(parse("CREATE TABLE t (a); INSERT INTO t VALUES (1); SELECT * FROM t;").map((s) => s.type)).toEqual(["createTable", "insert", "select"]);
  });
});

describe("parser: AST shapes", () => {
  it("builds select core with all clauses", () => {
    const s = sel("SELECT DISTINCT a, b AS c, t.*, * FROM t WHERE a > 1 GROUP BY a HAVING count(*) > 1 ORDER BY a DESC NULLS LAST LIMIT 10 OFFSET 5");
    const c = s.body as SelectCore;
    expect(c.distinct).toBe(true);
    expect(c.columns.map((x) => x.type)).toEqual(["expr", "expr", "tableStar", "star"]);
    expect((c.columns[1] as { alias?: string }).alias).toBe("c");
    expect(c.from).toMatchObject({ type: "table", name: "t" });
    expect(c.where).toMatchObject({ type: "binary", op: ">" });
    expect(c.groupBy).toHaveLength(1);
    expect(c.having).toMatchObject({ type: "binary", op: ">" });
    expect(s.orderBy).toMatchObject([{ desc: true, nulls: "LAST" }]);
    expect(strip(s.limit)).toEqual({ type: "literal", value: "10n" });
    expect(strip(s.offset)).toEqual({ type: "literal", value: "5n" });
  });

  it("parses LIMIT x, y as offset, limit", () => {
    const s = sel("SELECT 1 LIMIT 5, 10");
    expect(strip(s.offset)).toEqual({ type: "literal", value: "5n" });
    expect(strip(s.limit)).toEqual({ type: "literal", value: "10n" });
  });

  it("builds join trees left-associatively", () => {
    const c = core("SELECT * FROM a JOIN b ON a.id = b.id LEFT OUTER JOIN c USING (x, y) NATURAL JOIN d CROSS JOIN e, f");
    const f = c.from!;
    expect(f.type).toBe("join");
    const j = f as Extract<typeof f, { type: "join" }>;
    expect(j.joinType).toBe("INNER"); // comma join
    expect(j.on).toBeUndefined();
    expect((j.right as { name: string }).name).toBe("f");
    const cross = j.left as Extract<typeof f, { type: "join" }>;
    expect(cross.joinType).toBe("CROSS");
    const natural = cross.left as Extract<typeof f, { type: "join" }>;
    expect(natural.natural).toBe(true);
    const left = natural.left as Extract<typeof f, { type: "join" }>;
    expect(left.joinType).toBe("LEFT");
    expect(left.using).toEqual(["x", "y"]);
    const inner = left.left as Extract<typeof f, { type: "join" }>;
    expect(inner.joinType).toBe("INNER");
    expect(inner.on).toMatchObject({ type: "binary", op: "=" });
    expect(inner.left).toMatchObject({ type: "table", name: "a" });
  });

  it("parses derived tables, aliases and VALUES tables", () => {
    const c = core("SELECT * FROM (SELECT 1 AS x) AS sub, (VALUES (1), (2)) v, t AS u INDEXED BY i");
    const f = c.from as Extract<NonNullable<SelectCore["from"]>, { type: "join" }>;
    expect(f.right).toMatchObject({ type: "table", name: "t", alias: "u", indexedBy: "i" });
    const inner = f.left as Extract<NonNullable<SelectCore["from"]>, { type: "join" }>;
    expect(inner.left).toMatchObject({ type: "subquery", alias: "sub" });
    expect(inner.right).toMatchObject({ type: "subquery", alias: "v" });
    expect((inner.right as { select: SelectStmt }).select.body.type).toBe("values");
  });

  it("parses compound selects with trailing ORDER BY/LIMIT applying to the whole", () => {
    const s = sel("SELECT 1 UNION SELECT 2 UNION ALL SELECT 3 INTERSECT SELECT 4 EXCEPT SELECT 5 ORDER BY 1 LIMIT 2");
    expect(s.body.type).toBe("compound");
    const ops: string[] = [];
    let b = s.body;
    while (b.type === "compound") { ops.unshift(b.op); b = b.left; }
    expect(ops).toEqual(["UNION", "UNION ALL", "INTERSECT", "EXCEPT"]);
    expect(s.orderBy).toHaveLength(1);
    expect(s.limit).toBeDefined();
  });

  it("parses WITH RECURSIVE", () => {
    const s = sel("WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 10) SELECT x FROM cnt");
    expect(s.with!.recursive).toBe(true);
    expect(s.with!.ctes[0]!.name).toBe("cnt");
    expect(s.with!.ctes[0]!.columns).toEqual(["x"]);
    expect(s.with!.ctes[0]!.select.body.type).toBe("compound");
  });

  it("parses window specifications and frames", () => {
    const c = core("SELECT sum(x) OVER (PARTITION BY a, b ORDER BY c DESC ROWS BETWEEN 1 PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE CURRENT ROW), lag(x, 1, 0) OVER w FROM t WINDOW w AS (ORDER BY y RANGE UNBOUNDED PRECEDING)");
    const f1 = (c.columns[0] as { expr: Expr }).expr as Extract<Expr, { type: "function" }>;
    expect(f1.name).toBe("sum");
    const spec = f1.over as Exclude<typeof f1.over, string | undefined>;
    expect(spec.partitionBy).toHaveLength(2);
    expect(spec.orderBy[0]!.desc).toBe(true);
    expect(strip(spec.frame)).toEqual({ unit: "ROWS", start: { kind: "preceding", offset: { type: "literal", value: "1n" } }, end: { kind: "unboundedFollowing" }, exclude: "CURRENT ROW" });
    const f2 = (c.columns[1] as { expr: Expr }).expr as Extract<Expr, { type: "function" }>;
    expect(f2.over).toBe("w");
    expect(f2.args).toHaveLength(3);
    expect(c.windows![0]!.name).toBe("w");
    expect(strip(c.windows![0]!.spec.frame)).toEqual({ unit: "RANGE", start: { kind: "unboundedPreceding" }, end: { kind: "currentRow" }, exclude: "NO OTHERS" });
  });

  it("parses aggregate call modifiers", () => {
    const c = core("SELECT count(*), count(DISTINCT x), sum(x) FILTER (WHERE x > 0), group_concat(x, ',') FROM t");
    const fns = c.columns.map((col) => (col as { expr: Expr }).expr as Extract<Expr, { type: "function" }>);
    expect(fns[0]).toMatchObject({ name: "count", star: true, args: [] });
    expect(fns[1]).toMatchObject({ name: "count", distinct: true });
    expect(fns[1]!.args).toHaveLength(1);
    expect(fns[2]!.filter).toMatchObject({ type: "binary", op: ">" });
    expect(fns[3]!.args).toHaveLength(2);
  });

  it("parses INSERT variants", () => {
    const i = parseOne("INSERT OR REPLACE INTO t (a, b) VALUES (1, 2), (3, 4)") as Extract<Statement, { type: "insert" }>;
    expect(i.or).toBe("REPLACE");
    expect(i.table).toBe("t");
    expect(i.columns).toEqual(["a", "b"]);
    expect(i.values).toHaveLength(2);
    expect(i.values![1]).toHaveLength(2);
    expect((parseOne("REPLACE INTO t VALUES (1)") as Extract<Statement, { type: "insert" }>).or).toBe("REPLACE");
    expect((parseOne("INSERT INTO t DEFAULT VALUES") as Extract<Statement, { type: "insert" }>).defaultValues).toBe(true);
    const s = parseOne("INSERT INTO t SELECT * FROM u") as Extract<Statement, { type: "insert" }>;
    expect(s.select).toBeDefined();
    expect(s.values).toBeUndefined();
    const u = parseOne("INSERT INTO t AS x VALUES (1) ON CONFLICT (a) DO UPDATE SET b = excluded.b WHERE x.b < 1 RETURNING *") as Extract<Statement, { type: "insert" }>;
    expect(u.alias).toBe("x");
    expect(u.upsert!.target).toEqual(["a"]);
    expect(u.upsert!.set).toHaveLength(1);
    expect(u.upsert!.where).toBeDefined();
    expect(u.returning![0]!.type).toBe("star");
    const dn = parseOne("INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING") as Extract<Statement, { type: "insert" }>;
    expect(dn.upsert!.set).toBeUndefined();
    const w = parseOne("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x") as Extract<Statement, { type: "insert" }>;
    expect(w.with!.ctes).toHaveLength(1);
  });

  it("parses UPDATE and DELETE", () => {
    const u = parseOne("UPDATE OR IGNORE t AS x SET a = 1, b = a + 1 FROM v WHERE x.id = v.id RETURNING a") as Extract<Statement, { type: "update" }>;
    expect(u.or).toBe("IGNORE");
    expect(u.alias).toBe("x");
    expect(u.assignments.map((a) => a.columns)).toEqual([["a"], ["b"]]);
    expect(u.from).toMatchObject({ type: "table", name: "v" });
    expect(u.where).toBeDefined();
    expect(u.returning).toHaveLength(1);
    const d = parseOne("DELETE FROM t AS x WHERE x.a = 1 RETURNING *") as Extract<Statement, { type: "delete" }>;
    expect(d.alias).toBe("x");
    expect(d.where).toBeDefined();
    expect(d.returning).toHaveLength(1);
    expect((parseOne("DELETE FROM t") as Extract<Statement, { type: "delete" }>).where).toBeUndefined();
  });

  it("parses CREATE TABLE column and table constraints", () => {
    const sql = "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, age INT DEFAULT 0 CHECK (age >= 0), price REAL DEFAULT -1.5, r REFERENCES u(id) ON DELETE CASCADE, PRIMARY KEY (id), UNIQUE (name, age), CHECK (price > 0), FOREIGN KEY (r) REFERENCES u(id)) WITHOUT ROWID";
    const c = parseOne(sql) as Extract<Statement, { type: "createTable" }>;
    expect(c.ifNotExists).toBe(true);
    expect(c.withoutRowid).toBe(true);
    expect(c.sql).toBe(sql);
    expect(c.columns.map((x) => x.name)).toEqual(["id", "name", "age", "price", "r"]);
    expect(c.columns.map((x) => x.typeName)).toEqual(["INTEGER", "TEXT", "INT", "REAL", undefined]);
    expect(c.columns[0]!.constraints).toEqual([{ kind: "primaryKey", desc: false, autoincrement: true, onConflict: undefined, name: undefined }]);
    expect(c.columns[1]!.constraints.map((k) => k.kind)).toEqual(["notNull", "unique", "collate"]);
    expect(c.columns[2]!.constraints.map((k) => k.kind)).toEqual(["default", "check"]);
    expect(strip((c.columns[3]!.constraints[0] as { expr: Expr }).expr)).toEqual({ type: "literal", value: -1.5 });
    expect(c.columns[4]!.constraints[0]).toMatchObject({ kind: "references", table: "u", columns: ["id"] });
    expect(c.constraints.map((k) => k.kind)).toEqual(["primaryKey", "unique", "check", "foreignKey"]);
    expect((c.constraints[1] as { columns: { name: string }[] }).columns.map((x) => x.name)).toEqual(["name", "age"]);
  });

  it("captures multi-word type names with parameters", () => {
    const c = parseOne("CREATE TABLE t (a VARCHAR(20), b DOUBLE PRECISION, c UNSIGNED BIG INT, d NUMERIC(10, 2), e)") as Extract<Statement, { type: "createTable" }>;
    expect(c.columns.map((x) => x.typeName)).toEqual(["VARCHAR(20)", "DOUBLE PRECISION", "UNSIGNED BIG INT", "NUMERIC(10, 2)", undefined]);
  });

  it("parses CREATE TABLE AS SELECT", () => {
    const c = parseOne("CREATE TEMP TABLE t AS SELECT * FROM u") as Extract<Statement, { type: "createTable" }>;
    expect(c.temp).toBe(true);
    expect(c.asSelect).toBeDefined();
    expect(c.columns).toEqual([]);
  });

  it("parses CREATE INDEX / VIEW / DROP / ALTER", () => {
    const i = parseOne("CREATE UNIQUE INDEX IF NOT EXISTS i ON t (a, b DESC, c COLLATE NOCASE ASC) WHERE a > 0") as Extract<Statement, { type: "createIndex" }>;
    expect(i).toMatchObject({ unique: true, ifNotExists: true, name: "i", table: "t" });
    expect(i.columns.map((c) => [c.name, c.desc, c.collation])).toEqual([["a", false, undefined], ["b", true, undefined], ["c", false, "NOCASE"]]);
    expect(i.where).toBeDefined();
    const ix = parseOne("CREATE INDEX i ON t (lower(a))") as Extract<Statement, { type: "createIndex" }>;
    expect(ix.columns[0]!.expr).toBeDefined();
    expect(ix.columns[0]!.name).toBe("lower(a)");
    const v = parseOne("CREATE VIEW IF NOT EXISTS v (x, y) AS SELECT a, b FROM t") as Extract<Statement, { type: "createView" }>;
    expect(v).toMatchObject({ ifNotExists: true, name: "v", columns: ["x", "y"] });
    expect(v.select.body.type).toBe("select");
    expect(parseOne("DROP TABLE IF EXISTS t")).toMatchObject({ type: "drop", object: "TABLE", ifExists: true, name: "t" });
    expect(parseOne("DROP INDEX i")).toMatchObject({ type: "drop", object: "INDEX", ifExists: false });
    expect(parseOne("DROP VIEW v")).toMatchObject({ type: "drop", object: "VIEW" });
    expect(parseOne("ALTER TABLE t RENAME TO u")).toMatchObject({ type: "alterTable", table: "t", action: "renameTo", newName: "u" });
    expect(parseOne("ALTER TABLE t RENAME COLUMN a TO b")).toMatchObject({ action: "renameColumn", column: "a", newName: "b" });
    expect(parseOne("ALTER TABLE t DROP COLUMN a")).toMatchObject({ action: "dropColumn", column: "a" });
    const add = parseOne("ALTER TABLE t ADD COLUMN c INTEGER DEFAULT 0") as Extract<Statement, { type: "alterTable" }> & { action: "addColumn" };
    expect(add.column.name).toBe("c");
    expect(add.column.constraints[0]!.kind).toBe("default");
  });

  it("parses transaction statements", () => {
    expect(parseOne("BEGIN")).toMatchObject({ type: "begin", mode: undefined });
    expect(parseOne("BEGIN IMMEDIATE TRANSACTION")).toMatchObject({ type: "begin", mode: "IMMEDIATE" });
    expect(parseOne("COMMIT").type).toBe("commit");
    expect(parseOne("END TRANSACTION").type).toBe("commit");
    expect(parseOne("ROLLBACK")).toMatchObject({ type: "rollback", savepoint: undefined });
    expect(parseOne("ROLLBACK TRANSACTION TO SAVEPOINT sp")).toMatchObject({ type: "rollback", savepoint: "sp" });
    expect(parseOne("SAVEPOINT sp")).toMatchObject({ type: "savepoint", name: "sp" });
    expect(parseOne("RELEASE SAVEPOINT sp")).toMatchObject({ type: "release", name: "sp" });
  });

  it("parses EXPLAIN / ANALYZE / VACUUM / PRAGMA", () => {
    expect(parseOne("EXPLAIN SELECT 1")).toMatchObject({ type: "explain", analyze: false, queryPlan: false, statement: { type: "select" } });
    expect(parseOne("EXPLAIN ANALYZE DELETE FROM t")).toMatchObject({ type: "explain", analyze: true, statement: { type: "delete" } });
    expect(parseOne("EXPLAIN QUERY PLAN SELECT 1")).toMatchObject({ type: "explain", queryPlan: true });
    expect(parseOne("ANALYZE")).toMatchObject({ type: "analyze", target: undefined });
    expect(parseOne("ANALYZE t")).toMatchObject({ type: "analyze", target: "t" });
    expect(parseOne("VACUUM").type).toBe("vacuum");
    const p1 = parseOne("PRAGMA table_info(t)") as Extract<Statement, { type: "pragma" }>;
    expect(p1).toMatchObject({ name: "table_info", assign: false });
    expect(strip(p1.value)).toEqual({ type: "literal", value: "t" });
    expect(parseOne("PRAGMA page_count")).toMatchObject({ type: "pragma", name: "page_count", value: undefined });
    const p2 = parseOne("PRAGMA main.cache_size = -2000") as Extract<Statement, { type: "pragma" }>;
    expect(p2).toMatchObject({ schema: "main", name: "cache_size", assign: true });
    expect(strip(p2.value)).toEqual({ type: "literal", value: "-2000n" });
    expect(strip((parseOne("PRAGMA foreign_keys = ON") as Extract<Statement, { type: "pragma" }>).value)).toEqual({ type: "literal", value: "ON" });
  });

  it("parses literals and parameters", () => {
    expect(expr("?")).toEqual({ type: "param" });
    expect(expr("?7")).toEqual({ type: "param", index: 7 });
    expect(expr(":n")).toEqual({ type: "param", name: ":n" });
    expect(expr("@n")).toEqual({ type: "param", name: "@n" });
    expect(expr("$n")).toEqual({ type: "param", name: "$n" });
    expect(expr("NULL")).toEqual({ type: "literal", value: null });
    expect(expr("TRUE")).toEqual({ type: "literal", value: "1n" });
    expect(expr("FALSE")).toEqual({ type: "literal", value: "0n" });
    expect(expr("'it''s'")).toEqual({ type: "literal", value: "it's" });
    expect(expr("1.5")).toEqual({ type: "literal", value: 1.5 });
    expect(expr("-5")).toEqual({ type: "literal", value: "-5n" });
    expect(expr("-9223372036854775808")).toEqual({ type: "literal", value: "-9223372036854775808n" });
    expect(expr("-(-9223372036854775808)")).toEqual({ type: "literal", value: 9223372036854775808 });
    expect(expr("CURRENT_TIMESTAMP")).toEqual({ type: "function", name: "current_timestamp", args: [], distinct: false, star: false });
  });

  it("parses column references with qualifiers", () => {
    expect(expr("a")).toEqual({ type: "column", name: "a" });
    expect(expr("t.a")).toEqual({ type: "column", table: "t", name: "a" });
    expect(expr("main.t.a")).toEqual({ type: "column", schema: "main", table: "t", name: "a" });
    expect(expr('"T"."A"')).toEqual({ type: "column", table: "T", name: "A" });
  });

  it("parses CASE, CAST, EXISTS, subqueries, COLLATE, RAISE", () => {
    expect(expr("CASE WHEN a THEN 1 ELSE 2 END")).toMatchObject({ type: "case", whens: [{ when: { type: "column", name: "a" }, then: { type: "literal" } }], else: { type: "literal" } });
    expect(expr("CASE a WHEN 1 THEN 'x' END")).toMatchObject({ type: "case", operand: { type: "column" } });
    expect(expr("CAST(a AS VARCHAR(20))")).toEqual({ type: "cast", expr: { type: "column", name: "a" }, typeName: "VARCHAR(20)" });
    expect(expr("CAST(a AS DOUBLE PRECISION)")).toMatchObject({ typeName: "DOUBLE PRECISION" });
    expect(expr("EXISTS (SELECT 1)")).toMatchObject({ type: "exists", not: false });
    expect(expr("NOT EXISTS (SELECT 1)")).toMatchObject({ type: "exists", not: true });
    expect(expr("(SELECT 1)")).toMatchObject({ type: "subquery" });
    expect(expr("a COLLATE NOCASE")).toEqual({ type: "collate", expr: { type: "column", name: "a" }, collation: "NOCASE" });
    expect(expr("RAISE(ABORT, 'x')")).toEqual({ type: "raise", action: "ABORT", message: "x" });
  });

  it("parses IN forms", () => {
    expect(expr("a IN (1, 2)")).toMatchObject({ type: "in", not: false, list: [{ type: "literal" }, { type: "literal" }] });
    expect(expr("a NOT IN ()")).toMatchObject({ type: "in", not: true, list: [] });
    expect(expr("a IN (SELECT b FROM t)")).toMatchObject({ type: "in", subquery: { type: "select" } });
    expect(expr("a IN t")).toMatchObject({ type: "in", table: "t" });
  });

  it("parses IS variants", () => {
    expect(expr("a IS NULL")).toEqual({ type: "isnull", not: false, expr: { type: "column", name: "a" } });
    expect(expr("a IS NOT NULL")).toMatchObject({ type: "isnull", not: true });
    expect(expr("a ISNULL")).toMatchObject({ type: "isnull", not: false });
    expect(expr("a NOTNULL")).toMatchObject({ type: "isnull", not: true });
    expect(expr("a NOT NULL")).toMatchObject({ type: "isnull", not: true });
    expect(expr("a IS b")).toMatchObject({ type: "binary", op: "IS" });
    expect(expr("a IS NOT b")).toMatchObject({ type: "binary", op: "IS NOT" });
    expect(expr("a IS DISTINCT FROM b")).toMatchObject({ type: "binary", op: "IS DISTINCT FROM" });
    expect(expr("a IS NOT DISTINCT FROM b")).toMatchObject({ type: "binary", op: "IS NOT DISTINCT FROM" });
  });

  it("parses LIKE/GLOB with NOT and ESCAPE", () => {
    expect(expr("a LIKE 'x%'")).toMatchObject({ type: "like", op: "LIKE", not: false });
    expect(expr("a NOT LIKE 'x%' ESCAPE '!'")).toMatchObject({ type: "like", op: "LIKE", not: true, escape: { type: "literal", value: "!" } });
    expect(expr("a GLOB '*'")).toMatchObject({ type: "like", op: "GLOB" });
    expect(expr("a NOT GLOB '*'")).toMatchObject({ type: "like", op: "GLOB", not: true });
  });
});

describe("parser: precedence", () => {
  const bin = (op: string, left: unknown, right: unknown) => ({ type: "binary", op, left, right });
  const col = (name: string) => ({ type: "column", name });
  const lit = (v: string | number) => ({ type: "literal", value: v });

  it("1 + 2 * 3", () => { expect(expr("1 + 2 * 3")).toEqual(bin("+", lit("1n"), bin("*", lit("2n"), lit("3n")))); });
  it("(1 + 2) * 3", () => { expect(expr("(1 + 2) * 3")).toEqual(bin("*", bin("+", lit("1n"), lit("2n")), lit("3n"))); });
  it("1 - 2 - 3 is left associative", () => { expect(expr("1 - 2 - 3")).toEqual(bin("-", bin("-", lit("1n"), lit("2n")), lit("3n"))); });
  it("8 / 2 / 2 is left associative", () => { expect(expr("8 / 2 / 2")).toEqual(bin("/", bin("/", lit("8n"), lit("2n")), lit("2n"))); });
  it("NOT a = b", () => { expect(expr("NOT a = b")).toEqual({ type: "unary", op: "NOT", operand: bin("=", col("a"), col("b")) }); });
  it("NOT a AND b", () => { expect(expr("NOT a AND b")).toEqual(bin("AND", { type: "unary", op: "NOT", operand: col("a") }, col("b"))); });
  it("a IS NULL AND b", () => { expect(expr("a IS NULL AND b")).toEqual(bin("AND", { type: "isnull", not: false, expr: col("a") }, col("b"))); });
  it("a OR b AND c", () => { expect(expr("a OR b AND c")).toEqual(bin("OR", col("a"), bin("AND", col("b"), col("c")))); });
  it("x BETWEEN 1 AND 2 OR y", () => {
    expect(expr("x BETWEEN 1 AND 2 OR y")).toEqual(bin("OR", { type: "between", not: false, expr: col("x"), low: lit("1n"), high: lit("2n") }, col("y")));
  });
  it("x BETWEEN 1 + 1 AND 2 * 2", () => {
    expect(expr("x BETWEEN 1 + 1 AND 2 * 2")).toMatchObject({ type: "between", low: bin("+", lit("1n"), lit("1n")), high: bin("*", lit("2n"), lit("2n")) });
  });
  it("-2 + 3 folds the signed literal", () => { expect(expr("-2 + 3")).toEqual(bin("+", lit("-2n"), lit("3n"))); });
  it("-a * b binds unary minus tightest", () => { expect(expr("-a * b")).toEqual(bin("*", { type: "unary", op: "-", operand: col("a") }, col("b"))); });
  it("a || b || c is left associative", () => { expect(expr("a || b || c")).toEqual(bin("||", bin("||", col("a"), col("b")), col("c"))); });
  it("|| binds tighter than *", () => { expect(expr("a * b || c")).toEqual(bin("*", col("a"), bin("||", col("b"), col("c")))); });
  it("comparison binds tighter than equality", () => { expect(expr("1 < 2 = 3 < 4")).toEqual(bin("=", bin("<", lit("1n"), lit("2n")), bin("<", lit("3n"), lit("4n")))); });
  it("bitwise binds tighter than comparison, looser than +", () => {
    expect(expr("a + b << c < d")).toEqual(bin("<", bin("<<", bin("+", col("a"), col("b")), col("c")), col("d")));
    expect(expr("a & b = c")).toEqual(bin("=", bin("&", col("a"), col("b")), col("c")));
  });
  it("a = b = c is left associative", () => { expect(expr("a = b = c")).toEqual(bin("=", bin("=", col("a"), col("b")), col("c"))); });
  it("a LIKE b ESCAPE c AND d", () => {
    expect(expr("a LIKE b ESCAPE c AND d")).toEqual(bin("AND", { type: "like", op: "LIKE", not: false, left: col("a"), right: col("b"), escape: col("c") }, col("d")));
  });
  it("a IN (1) = b", () => { expect(expr("a IN (1) = b")).toEqual(bin("=", { type: "in", not: false, expr: col("a"), list: [lit("1n")] }, col("b"))); });
  it("COLLATE binds tightest", () => { expect(expr("a COLLATE NOCASE = b")).toEqual(bin("=", { type: "collate", expr: col("a"), collation: "NOCASE" }, col("b"))); });
  it("a IS NOT NULL OR b", () => { expect(expr("a IS NOT NULL OR b")).toEqual(bin("OR", { type: "isnull", not: true, expr: col("a") }, col("b"))); });
  it("~a + b", () => { expect(expr("~a + b")).toEqual(bin("+", { type: "unary", op: "~", operand: col("a") }, col("b"))); });
  it("NOT NOT a", () => { expect(expr("NOT NOT a")).toEqual({ type: "unary", op: "NOT", operand: { type: "unary", op: "NOT", operand: col("a") } }); });
  it("function call then operator", () => {
    expect(expr("f(x) OVER (ORDER BY y) + 1")).toMatchObject({ type: "binary", op: "+", left: { type: "function", name: "f" } });
  });
});

describe("parser: errors carry line and column", () => {
  const cases: [string, RegExp][] = [
    ["SELECT 1 +", /expected expression near end of input at 1:11/],
    ["SELECT * FROM", /expected table name near end of input at 1:14/],
    ["SELCT 1", /expected statement near 'SELCT' at 1:1/],
    ["SELECT (1", /expected '\)' near end of input at 1:10/],
    ["SELECT a FROM t WHERE", /expected expression near end of input at 1:22/],
    ["CREATE TABLE t", /expected '\(' near end of input at 1:15/],
    ["SELECT 1\n   FROM t WHERE x ==== 1", /expected expression near '==' at 2:21/],
    ["SELECT * FROM t JOIN", /expected table name near end of input at 1:21/],
    ["SELECT 1 2", /expected ';' or end of input near '2' at 1:10/],
    ["SELECT 1 FROM t WHERE a BETWEEN 1 2", /expected AND near '2' at 1:35/],
    ["SELECT CASE WHEN 1 THEN 2", /expected END near end of input/],
    ["SELECT CAST(1 AS)", /expected type name near '\)' at 1:17/],
    ["INSERT INTO t (a, b VALUES (1)", /expected '\)' near 'VALUES'/],
    ["UPDATE t a = 1", /expected SET near '='/],
    ["DELETE t", /expected FROM near 't'/],
    ["CREATE TABLE t ()", /expected column name near '\)'/],
    ["CREATE INDEX ON t (a)", /expected index name near 'ON'/],
    ["SELECT * FROM t NATURAL JOIN u ON 1", /NATURAL join may not have an ON or USING/],
    ["SELECT sum(x) OVER (ROWS BETWEEN UNBOUNDED FOLLOWING AND CURRENT ROW) FROM t", /UNBOUNDED FOLLOWING is invalid/],
    ["SELECT (1, 2)", /row values are not supported/],
    ["UPDATE t SET (a, b) = (SELECT 1, 2)", /row-value subqueries are not supported/],
    ["UPDATE t SET (a, b) = (1, 2, 3)", /2 columns assigned 3 values/],
    ["DROP t", /expected TABLE, INDEX or VIEW after DROP/],
    ["ALTER TABLE t FOO", /expected RENAME, ADD or DROP/],
    ["SELECT 'abc", /unterminated string literal at 1:8/],
    ["SELECT 1;\nSELEC 2", /expected statement near 'SELEC' at 2:1/],
    ["SELECT a FROM t ORDER", /expected BY near end of input/],
    ["SELECT a FROM t GROUP a", /expected BY near 'a'/],
    ["WITH x AS SELECT 1 SELECT 2", /expected '\(' near 'SELECT'/],
    ["SELECT 1 UNION", /expected SELECT near end of input/],
    ["SELECT * FROM t WHERE a IN (1, 2", /expected '\)' near end of input/],
    ["BEGIN FOO", /expected ';' or end of input near 'FOO'/],
  ];
  for (const [sql, re] of cases) {
    it(`rejects ${JSON.stringify(sql)}`, () => {
      expect(() => parse(sql)).toThrow(re);
      try { parse(sql); } catch (e) { expect(e).toBeInstanceOf(SyntaxError_); }
    });
  }

  it("exposes line/col on the error object", () => {
    try {
      parse("SELECT 1\n   FROM t WHERE x ==== 1");
      expect.fail("should throw");
    } catch (e) {
      const err = e as SyntaxError_;
      expect(err.line).toBe(2);
      expect(err.col).toBe(21);
      expect(err.code).toBe("SYNTAX");
    }
  });

  it("parseExpression rejects trailing input", () => {
    expect(() => parseExpression("1 + 2 3")).toThrow(/unexpected input after expression near '3' at 1:7/);
  });

  it("parseOne rejects multiple statements", () => {
    expect(() => parseOne("SELECT 1; SELECT 2")).toThrow(/exactly one statement/);
  });

  it("reserved words cannot be bare identifiers", () => {
    expect(() => parse("SELECT * FROM select")).toThrow(/expected table name/);
    expect(() => parse("SELECT from FROM t")).toThrow();
    expect(() => parse('SELECT "from" FROM t')).not.toThrow();
  });
});
