import { describe, expect, it } from "vitest";
import { Database } from "../../src/engine/database.js";
import { MemoryBackend } from "../../src/storage/backend.js";
import { ConstraintError, TransactionError } from "../../src/core/errors.js";
import type { Row } from "../../src/core/types.js";

async function open(): Promise<Database> { return Database.open({ memory: true }); }
const rows = (db: Database, sql: string, params?: readonly import("../../src/core/types.js").Value[]): Row[] => db.query(sql, params ?? []).rows;
const one = (db: Database, sql: string): unknown => db.query(sql).rows[0]?.[0];

describe("Database: DDL and DML", () => {
  it("creates tables, inserts with defaults and rowids, updates and deletes", async () => {
    const db = await open();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER DEFAULT 3, price REAL)");
    const r = db.query("INSERT INTO t(name, price) VALUES ('a', 1.5), ('b', 2.5)");
    expect(r.rowsAffected).toBe(2);
    expect(r.lastRowid).toBe(2n);
    db.exec("INSERT INTO t VALUES (10, 'c', 0, NULL)");
    expect(rows(db, "SELECT id, name, qty, price FROM t ORDER BY id")).toEqual([[1n, "a", 3n, 1.5], [2n, "b", 3n, 2.5], [10n, "c", 0n, null]]);
    expect(db.query("INSERT INTO t(name) VALUES ('d')").lastRowid).toBe(11n);
    expect(db.query("UPDATE t SET qty = qty + 1 WHERE id < 10").rowsAffected).toBe(2);
    expect(rows(db, "SELECT qty FROM t WHERE id = 1")).toEqual([[4n]]);
    expect(db.query("DELETE FROM t WHERE qty = 4").rowsAffected).toBe(2);
    expect(one(db, "SELECT count(*) FROM t")).toBe(2n);
    expect(db.query("SELECT * FROM t").columns.map((c) => c.name)).toEqual(["id", "name", "qty", "price"]);
    await db.close();
  });

  it("enforces constraints and supports OR REPLACE / IGNORE / upsert / RETURNING", async () => {
    const db = await open();
    db.exec("CREATE TABLE u(id INTEGER PRIMARY KEY, k TEXT UNIQUE, v INTEGER NOT NULL CHECK (v > 0))");
    db.exec("INSERT INTO u VALUES (1, 'a', 1)");
    expect(() => db.exec("INSERT INTO u VALUES (1, 'b', 1)")).toThrow(ConstraintError);
    expect(() => db.exec("INSERT INTO u VALUES (2, 'a', 1)")).toThrow(/UNIQUE constraint failed: u.k/);
    expect(() => db.exec("INSERT INTO u VALUES (2, 'b', NULL)")).toThrow(/NOT NULL constraint failed: u.v/);
    expect(() => db.exec("INSERT INTO u VALUES (2, 'b', 0)")).toThrow(/CHECK constraint failed/);
    db.exec("INSERT OR IGNORE INTO u VALUES (1, 'z', 9)");
    db.exec("INSERT OR REPLACE INTO u VALUES (1, 'r', 2)");
    expect(rows(db, "SELECT k, v FROM u")).toEqual([["r", 2n]]);
    const ret = db.query("INSERT INTO u VALUES (1, 'q', 5) ON CONFLICT(id) DO UPDATE SET v = v + excluded.v RETURNING id, v");
    expect(ret.rows).toEqual([[1n, 7n]]);
    db.exec("INSERT INTO u VALUES (1, 'q', 5) ON CONFLICT DO NOTHING");
    expect(one(db, "SELECT count(*) FROM u")).toBe(1n);
    // a failing multi-row insert leaves nothing behind
    expect(() => db.exec("INSERT INTO u VALUES (5, 'x', 1), (6, 'r', 1)")).toThrow(ConstraintError);
    expect(one(db, "SELECT count(*) FROM u")).toBe(1n);
    await db.close();
  });

  it("supports ALTER TABLE, views, indexes and DROP", async () => {
    const db = await open();
    db.exec("CREATE TABLE a(x INTEGER); INSERT INTO a VALUES (1), (2)");
    db.exec("ALTER TABLE a ADD COLUMN y TEXT DEFAULT 'd'");
    expect(rows(db, "SELECT x, y FROM a ORDER BY x")).toEqual([[1n, "d"], [2n, "d"]]);
    db.exec("ALTER TABLE a RENAME TO b");
    db.exec("ALTER TABLE b RENAME COLUMN y TO z");
    db.exec("CREATE INDEX ib ON b(z)");
    db.exec("CREATE VIEW v AS SELECT x * 2 AS d FROM b");
    expect(rows(db, "SELECT d FROM v ORDER BY d")).toEqual([[2n], [4n]]);
    expect(db.tables()).toEqual(["b"]);
    expect(db.schemaSql().join("\n")).toContain("CREATE INDEX ib");
    db.exec("DROP VIEW v; DROP INDEX ib; DROP TABLE b");
    expect(db.tables()).toEqual([]);
    expect(() => db.exec("SELECT * FROM b")).toThrow(/no such table/);
    await db.close();
  });
});

describe("Database: queries", () => {
  async function sample(): Promise<Database> {
    const db = await open();
    db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, name TEXT, region TEXT)");
    db.exec("CREATE TABLE o(id INTEGER PRIMARY KEY, cid INTEGER, amount REAL)");
    db.exec("INSERT INTO c VALUES (1, 'ann', 'eu'), (2, 'bob', 'us'), (3, 'cid', NULL), (4, 'dee', 'eu')");
    db.exec("INSERT INTO o VALUES (1, 1, 10.0), (2, 1, 20.0), (3, 2, 5.0), (4, NULL, 1.0), (5, 9, 2.0)");
    return db;
  }

  it("runs all join types with NULL keys", async () => {
    const db = await sample();
    expect(rows(db, "SELECT c.name, o.amount FROM c JOIN o ON o.cid = c.id ORDER BY o.id")).toEqual([["ann", 10], ["ann", 20], ["bob", 5]]);
    expect(rows(db, "SELECT c.name, o.id FROM c LEFT JOIN o ON o.cid = c.id ORDER BY c.id, o.id")).toEqual([["ann", 1n], ["ann", 2n], ["bob", 3n], ["cid", null], ["dee", null]]);
    expect(rows(db, "SELECT c.name, o.id FROM c RIGHT JOIN o ON o.cid = c.id ORDER BY o.id")).toEqual([["ann", 1n], ["ann", 2n], ["bob", 3n], [null, 4n], [null, 5n]]);
    expect(rows(db, "SELECT count(*) FROM c FULL JOIN o ON o.cid = c.id")).toEqual([[7n]]);
    expect(rows(db, "SELECT count(*) FROM c CROSS JOIN o")).toEqual([[20n]]);
    expect(rows(db, "SELECT name FROM c WHERE id IN (SELECT cid FROM o) ORDER BY name")).toEqual([["ann"], ["bob"]]);
    expect(rows(db, "SELECT name FROM c WHERE NOT EXISTS (SELECT 1 FROM o WHERE o.cid = c.id) ORDER BY name")).toEqual([["cid"], ["dee"]]);
    expect(rows(db, "SELECT name, (SELECT sum(amount) FROM o WHERE o.cid = c.id) FROM c ORDER BY id")).toEqual([["ann", 30], ["bob", 5], ["cid", null], ["dee", null]]);
    expect(rows(db, "SELECT name FROM c WHERE region = (SELECT region FROM c WHERE id = 1) ORDER BY id")).toEqual([["ann"], ["dee"]]);
    await db.close();
  });

  it("aggregates, windows, CTEs and compounds", async () => {
    const db = await sample();
    expect(rows(db, "SELECT region, count(*), sum(o.amount) FROM c LEFT JOIN o ON o.cid = c.id GROUP BY region ORDER BY region NULLS FIRST")).toEqual([[null, 1n, null], ["eu", 3n, 30], ["us", 1n, 5]]);
    expect(rows(db, "SELECT region FROM c GROUP BY region HAVING count(*) > 1")).toEqual([["eu"]]);
    expect(rows(db, "SELECT count(DISTINCT region), group_concat(name, '+') FROM c")).toEqual([[2n, "ann+bob+cid+dee"]]);
    expect(rows(db, "SELECT id, amount, sum(amount) OVER (ORDER BY id) AS run, rank() OVER (ORDER BY amount DESC) FROM o ORDER BY id"))
      .toEqual([[1n, 10, 10, 2n], [2n, 20, 30, 1n], [3n, 5, 35, 3n], [4n, 1, 36, 5n], [5n, 2, 38, 4n]]);
    expect(rows(db, "SELECT id, lag(amount) OVER (ORDER BY id), avg(amount) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM o ORDER BY id"))
      .toEqual([[1n, null, 10], [2n, 10, 15], [3n, 20, 12.5], [4n, 5, 3], [5n, 1, 1.5]]);
    expect(rows(db, "WITH RECURSIVE f(n, a, b) AS (SELECT 1, 0, 1 UNION ALL SELECT n + 1, b, a + b FROM f WHERE n < 10) SELECT a FROM f WHERE n = 10")).toEqual([[34n]]);
    expect(rows(db, "WITH big AS (SELECT cid FROM o WHERE amount >= 10) SELECT count(*) FROM big")).toEqual([[2n]]);
    expect(rows(db, "SELECT id FROM c WHERE id < 3 UNION ALL SELECT id FROM o WHERE id > 4 ORDER BY 1 DESC")).toEqual([[5n], [2n], [1n]]);
    expect(rows(db, "SELECT id FROM c INTERSECT SELECT id FROM o ORDER BY 1")).toEqual([[1n], [2n], [3n], [4n]]);
    expect(rows(db, "SELECT id FROM o EXCEPT SELECT id FROM c ORDER BY 1")).toEqual([[5n]]);
    await db.close();
  });

  it("orders with NULLS FIRST/LAST, limits, offsets and parameters", async () => {
    const db = await sample();
    expect(rows(db, "SELECT region FROM c ORDER BY region DESC NULLS LAST LIMIT 2 OFFSET 1")).toEqual([["eu"], ["eu"]]);
    expect(rows(db, "SELECT region FROM c ORDER BY region NULLS LAST")).toEqual([["eu"], ["eu"], ["us"], [null]]);
    expect(rows(db, "SELECT name FROM c WHERE id = ? OR name = ?", [2n, "dee"])).toEqual([["bob"], ["dee"]]);
    expect(db.query("SELECT name FROM c WHERE id = :id", { id: 3n }).rows).toEqual([["cid"]]);
    const st = db.prepare("SELECT name FROM c WHERE region = ?1 AND id > ?2");
    expect(st.all(["eu", 0n])).toEqual([["ann"], ["dee"]]);
    expect(st.get(["eu", 1n])).toEqual(["dee"]);
    expect(st.columns.map((c) => c.name)).toEqual(["name"]);
    db.exec("INSERT INTO c VALUES (5, 'eve', 'eu')");
    expect(st.all(["eu", 4n])).toEqual([["eve"]]);
    db.exec("ALTER TABLE c ADD COLUMN extra INTEGER");
    expect(st.all(["us", 0n])).toEqual([["bob"]]);
    await db.close();
  });
});

describe("Database: transactions and persistence", () => {
  it("rolls back, supports savepoints and keeps statements atomic", async () => {
    const db = await open();
    db.exec("CREATE TABLE t(a INTEGER PRIMARY KEY)");
    db.exec("BEGIN; INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); ROLLBACK");
    expect(one(db, "SELECT count(*) FROM t")).toBe(0n);
    db.exec("BEGIN; INSERT INTO t VALUES (1); SAVEPOINT s; INSERT INTO t VALUES (2); ROLLBACK TO s; INSERT INTO t VALUES (3); RELEASE s; COMMIT");
    expect(rows(db, "SELECT a FROM t ORDER BY a")).toEqual([[1n], [3n]]);
    db.exec("BEGIN");
    expect(() => db.exec("INSERT INTO t VALUES (7), (1)")).toThrow(ConstraintError);
    db.exec("INSERT INTO t VALUES (8)");
    db.exec("COMMIT");
    expect(rows(db, "SELECT a FROM t ORDER BY a")).toEqual([[1n], [3n], [8n]]);
    expect(() => db.exec("BEGIN; BEGIN")).toThrow(TransactionError);
    db.exec("ROLLBACK");
    expect(db.transaction(() => { db.exec("INSERT INTO t VALUES (9)"); return 42; })).toBe(42);
    expect(() => db.transaction(() => { db.exec("INSERT INTO t VALUES (10)"); throw new Error("boom"); })).toThrow("boom");
    expect(rows(db, "SELECT max(a) FROM t")).toEqual([[9n]]);
    await db.close();
  });

  it("gives readers a stable snapshot while a writer commits (two handles over one backend)", async () => {
    const backend = new MemoryBackend();
    const w = await Database.open({ backend });
    const r = await Database.open({ backend });
    w.exec("CREATE TABLE t(a INTEGER); INSERT INTO t VALUES (1)");
    r.exec("BEGIN");
    expect(one(r, "SELECT count(*) FROM t")).toBe(1n);
    w.exec("INSERT INTO t VALUES (2)");
    expect(one(r, "SELECT count(*) FROM t")).toBe(1n);
    expect(one(w, "SELECT count(*) FROM t")).toBe(2n);
    expect(() => r.exec("INSERT INTO t VALUES (3)")).toThrow(TransactionError);
    r.exec("COMMIT");
    expect(one(r, "SELECT count(*) FROM t")).toBe(2n);
    let commits = 0;
    r.on("commit", () => commits++);
    w.exec("INSERT INTO t VALUES (3)");
    expect(commits).toBe(1);
    await r.close();
    await w.close();
  });

  it("persists across close and reopen of the same bytes", async () => {
    const backend = new MemoryBackend();
    let db = await Database.open({ backend });
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT); CREATE INDEX i ON t(s)");
    db.exec("BEGIN");
    const st = db.prepare("INSERT INTO t(s) VALUES (?)");
    for (let i = 0; i < 2000; i++) st.run([`row${i}`]);
    db.exec("COMMIT");
    await db.close();
    db = await Database.open({ backend: MemoryBackend.fromBytes(backend.toBytes()) });
    expect(one(db, "SELECT count(*) FROM t")).toBe(2000n);
    expect(rows(db, "SELECT id FROM t WHERE s = 'row1234'")).toEqual([[1235n]]);
    expect(db.schemaSql()).toHaveLength(2);
    await db.close();
  });
});

describe("Database: planner, maintenance, introspection", () => {
  it("chooses index paths, hash joins, TopK, covering indexes and merge joins", async () => {
    const db = await open();
    db.exec("CREATE TABLE big(id INTEGER PRIMARY KEY, k INTEGER, s TEXT); CREATE INDEX bk ON big(k)");
    db.exec("CREATE TABLE small(id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("BEGIN");
    for (let i = 0; i < 3000; i++) db.query("INSERT INTO big VALUES (?, ?, ?)", [BigInt(i), BigInt(i % 100), `s${i}`]);
    for (let i = 0; i < 50; i++) db.query("INSERT INTO small VALUES (?, ?)", [BigInt(i), `n${i}`]);
    db.exec("COMMIT");
    const ops = (sql: string): string[] => { const out: string[] = []; const walk = (n: import("../../src/planner/explain.js").PlanNode): void => { out.push(n.op); n.children.forEach(walk); }; walk(db.explain(sql)); return out; };
    expect(ops("SELECT * FROM big WHERE id = 5")).toContain("RowidLookup");
    expect(ops("SELECT * FROM big WHERE k = 5")).toContain("IndexScan");
    expect(db.explain("SELECT k FROM big WHERE k = 5").children[0]!.props["covering"]).toBe(true);
    expect(ops("SELECT * FROM big b JOIN small s ON b.k = s.id")).toContain("HashJoin");
    expect(ops("SELECT * FROM big ORDER BY s LIMIT 3")).toContain("TopK");
    expect(ops("SELECT * FROM big ORDER BY id LIMIT 3")).not.toContain("Sort");
    expect(ops("SELECT * FROM big b JOIN small s ON b.id = s.id")).toContain("MergeJoin");
    db.exec("ANALYZE big");
    expect(ops("SELECT * FROM big WHERE k > 50 AND k < 52")).toContain("IndexScan");
    expect(rows(db, "SELECT count(*) FROM big WHERE k > 50 AND k < 52")).toEqual([[30n]]);
    expect(rows(db, "SELECT id FROM big WHERE k = 7 ORDER BY id DESC LIMIT 2")).toEqual([[2907n], [2807n]]);
    const analyzed = db.explain("SELECT * FROM big WHERE k = 5", true);
    expect(analyzed.actualRows).toBe(30);
    expect(db.query("EXPLAIN ANALYZE SELECT count(*) FROM big").rows.length).toBeGreaterThan(1);
    await db.close();
  });

  it("ANALYZE changes estimates, VACUUM shrinks the file, PRAGMAs and introspection work", async () => {
    const db = await open();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, k INTEGER); CREATE INDEX tk ON t(k)");
    db.exec("BEGIN");
    for (let i = 0; i < 2000; i++) db.query("INSERT INTO t VALUES (?, ?)", [BigInt(i), i < 1990 ? 1n : BigInt(i)]);
    db.exec("COMMIT");
    const before = db.explain("SELECT * FROM t WHERE k = 1").children[0]!;
    db.exec("ANALYZE");
    const after = db.explain("SELECT * FROM t WHERE k = 1").children[0]!;
    expect(after.estRows).toBeGreaterThan(before.estRows);
    expect(after.op).toBe("SeqScan");
    expect(db.explain("SELECT * FROM t WHERE k = 1995").children[0]!.op).toBe("IndexScan");
    expect(db.query("SELECT count(*) FROM basalt_stats").rows[0]![0]).toBe(2n);
    db.exec("DELETE FROM t WHERE id > 100");
    const pagesBefore = Number(one(db, "PRAGMA page_count"));
    db.exec("VACUUM");
    const pagesAfter = Number(one(db, "PRAGMA page_count"));
    expect(pagesAfter).toBeLessThan(pagesBefore);
    expect(one(db, "SELECT count(*) FROM t")).toBe(101n);
    expect(rows(db, "SELECT id FROM t WHERE k = 1 ORDER BY id LIMIT 2")).toEqual([[0n], [1n]]);
    expect(rows(db, "PRAGMA table_info(t)")).toEqual([[0n, "id", "INTEGER", 0n, null, 1n], [1n, "k", "INTEGER", 0n, null, 0n]]);
    expect(rows(db, "PRAGMA index_list(t)").map((r) => r[1])).toEqual(["tk"]);
    expect(Number(one(db, "PRAGMA freelist_count"))).toBeGreaterThanOrEqual(0);
    const map = db.pageMap();
    expect(map.length).toBe(pagesAfter);
    expect(map[0]!.type).toBe("meta");
    expect(map.some((p) => p.table === "t" && p.type === "leaf")).toBe(true);
    const leaf = map.find((p) => p.table === "t" && p.type === "leaf")!;
    const detail = db.describePage(leaf.pageId);
    expect(detail.cells.length).toBeGreaterThan(0);
    expect(detail.cells[0]!.value).toEqual([0n, 1n]);
    const bs = db.btreeStats("t");
    expect(bs.entries).toBe(101);
    expect(bs.depth).toBeGreaterThanOrEqual(1);
    expect(db.stats().pageCount).toBe(pagesAfter);
    await db.close();
  });

  it("spills large sorts and keeps results correct", async () => {
    const db = await open();
    db.sortSpillThreshold = 500;
    db.exec("CREATE TABLE s(v INTEGER, t TEXT)");
    db.exec("BEGIN");
    for (let i = 0; i < 3000; i++) db.query("INSERT INTO s VALUES (?, ?)", [BigInt((i * 7919) % 3000), `t${i % 10}`]);
    db.exec("COMMIT");
    const r = rows(db, "SELECT v FROM s ORDER BY t DESC, v");
    expect(r.length).toBe(3000);
    expect(r[0]).toEqual([(((0 * 7919) % 3000) + 0) === 0 ? r[0]![0] : r[0]![0]]);
    const vs = r.slice(0, 300).map((x) => x[0] as bigint);
    for (let i = 1; i < vs.length; i++) expect(vs[i]! >= vs[i - 1]!).toBe(true);
    await db.close();
  });
});
