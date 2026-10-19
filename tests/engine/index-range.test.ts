import { describe, expect, it } from "vitest";
import { Database } from "../../src/engine/database.js";
import type { PlanNode } from "../../src/planner/explain.js";

function ops(n: PlanNode, out: string[] = []): string[] {
  out.push(n.op);
  for (const c of n.children) ops(c, out);
  return out;
}

async function load(): Promise<Database> {
  const db = await Database.open({ memory: true });
  db.exec("CREATE TABLE o (id INTEGER PRIMARY KEY, created_day INTEGER, amount REAL, note TEXT)");
  const vals: string[] = [];
  for (let i = 0; i < 50000; i++) vals.push(`(${i % 730}, ${((i * 7919) % 1000) / 10}, 'n${i}')`);
  for (let k = 0; k < vals.length; k += 5000) db.exec("INSERT INTO o (created_day, amount, note) VALUES " + vals.slice(k, k + 5000).join(","));
  db.exec("CREATE INDEX o_day ON o (created_day)");
  db.exec("ANALYZE");
  return db;
}

/**
 * Regression: the cost model charged a full random page per index -> table lookup, so an index range over ~4% of a
 * 50k-row table (2,139 rows) lost to a sequential scan with a filter (205 ms vs 185 ms measured). A cached B+tree
 * descent costs a few CPU rows, not a disk page; the index path must win here and run well under a full scan.
 */
describe("index range scans", () => {
  it("picks IndexScan for a BETWEEN over ~4% of the rows after ANALYZE", async () => {
    const db = await load();
    const q = "SELECT count(*), sum(amount) FROM o WHERE created_day BETWEEN 200 AND 230";
    const plan = db.explain(q);
    expect(ops(plan)).toContain("IndexScan");
    expect(ops(plan)).not.toContain("SeqScan");
    expect(db.query(q).rows[0]![0]).toBe(2139n);
    // a non-selective range (most of the table) with a table lookup per row must still use the sequential scan
    expect(ops(db.explain("SELECT sum(amount) FROM o WHERE created_day BETWEEN 10 AND 700"))).toContain("SeqScan");
    await db.close();
  });

  it("runs the index range well under a full scan (generous bound)", async () => {
    const db = await load();
    const q = "SELECT count(*), sum(amount) FROM o WHERE created_day BETWEEN 200 AND 230";
    db.query(q); // warm plan cache
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) db.query(q);
    const perRun = (performance.now() - t0) / 5;
    expect(perRun).toBeLessThan(60); // ~5 ms in Node; the sequential scan takes ~130 ms
    await db.close();
  });
});
