import { describe, expect, it } from "vitest";
import { Database } from "../../src/engine/database.js";

/**
 * Regression: every statement inside BEGIN/COMMIT runs under its own savepoint epoch. Before the fix the
 * pages a statement copied (pre-images allocated by earlier statements of the same transaction) were
 * freed with the transaction's tag and could not be reused until commit, so 5,000 single-row inserts
 * grew the file to ~10k pages. Pages a transaction allocated and later freed itself were never visible
 * to any reader, so once the savepoint is released they must be reusable immediately.
 */
describe("page reuse inside a transaction", () => {
  it("5000 single-row inserts in one transaction stay within 2x of one multi-row insert", async () => {
    const multi = await Database.open({ memory: true });
    multi.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT)");
    const vals: string[] = [];
    for (let i = 0; i < 5000; i++) vals.push(`(${i}, 'row-${i}')`);
    multi.exec("INSERT INTO t (a, b) VALUES " + vals.join(","));
    const multiPages = multi.stats().pageCount;

    const single = await Database.open({ memory: true });
    single.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT)");
    const st = single.prepare("INSERT INTO t (a, b) VALUES (?, ?)");
    single.exec("BEGIN");
    for (let i = 0; i < 5000; i++) st.run([BigInt(i), "row-" + i]);
    single.exec("COMMIT");
    const s = single.stats();
    expect(s.pageCount).toBeLessThanOrEqual(multiPages * 2);
    expect(s.freePages).toBeLessThan(50);
    expect(single.query("SELECT count(*), sum(a) FROM t").rows[0]).toEqual([5000n, 12497500n]);
    expect(multi.query("SELECT count(*), sum(a) FROM t").rows[0]).toEqual([5000n, 12497500n]);
    await multi.close();
    await single.close();
  });

  it("keeps savepoint rollback correct when freed pages are recycled within the transaction", async () => {
    const db = await Database.open({ memory: true });
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT)");
    const st = db.prepare("INSERT INTO t (a, b) VALUES (?, ?)");
    db.exec("BEGIN");
    for (let i = 0; i < 500; i++) st.run([BigInt(i), "row-" + i]);
    db.exec("SAVEPOINT s1");
    for (let i = 500; i < 1500; i++) st.run([BigInt(i), "row-" + i]);
    db.exec("UPDATE t SET b = b || '!' WHERE a < 100");
    db.exec("SAVEPOINT s2");
    db.exec("DELETE FROM t WHERE a >= 200");
    db.exec("RELEASE s2");
    for (let i = 2000; i < 2300; i++) st.run([BigInt(i), "row-" + i]);
    db.exec("ROLLBACK TO s1");
    expect(db.query("SELECT count(*), sum(a) FROM t").rows[0]).toEqual([500n, 124750n]);
    expect(db.query("SELECT b FROM t WHERE a = 1").rows[0]).toEqual(["row-1"]);
    for (let i = 500; i < 800; i++) st.run([BigInt(i), "row-" + i]);
    db.exec("RELEASE s1");
    db.exec("COMMIT");
    expect(db.query("SELECT count(*), sum(a) FROM t").rows[0]).toEqual([800n, 319600n]);
    const s = db.stats();
    expect(s.pageCount).toBeLessThan(200);
    await db.close();
  });

  it("explain() does not poison the plan cache for the same SQL text", async () => {
    const db = await Database.open({ memory: true });
    db.exec("CREATE TABLE t (a INTEGER)");
    db.exec("INSERT INTO t VALUES (1), (2)");
    const q = "SELECT a FROM t ORDER BY a";
    db.explain(q);
    expect(db.query(q).rows).toEqual([[1n], [2n]]);
    await db.close();
  });
});
