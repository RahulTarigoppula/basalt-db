/**
 * Benchmark: a deterministic TPC-H shaped mini dataset (customer 1.5k, orders 15k, lineitem 60k) generated in memory,
 * bulk insert with and without secondary indexes, and eight queries (TPC-H Q1/Q3/Q5/Q6/Q10 variants plus three point
 * and index lookups). Prints a markdown table.  `npm run bench`
 */
import { Database } from "../src/engine/database.js";
import type { Value } from "../src/core/types.js";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const N_CUST = 1500, N_ORD = 15_000, N_LINE = 60_000;
const NATIONS = ["FRANCE", "GERMANY", "JAPAN", "BRAZIL", "INDIA", "CANADA", "EGYPT", "PERU"];
const REGIONS = ["EUROPE", "EUROPE", "ASIA", "AMERICA", "ASIA", "AMERICA", "AFRICA", "AMERICA"];
const STATUS = ["F", "O", "P"];
const FLAGS = ["A", "N", "R"];

function dataset(): { customer: Value[][]; orders: Value[][]; lineitem: Value[][] } {
  const rand = rng(42);
  const customer: Value[][] = [], orders: Value[][] = [], lineitem: Value[][] = [];
  for (let i = 1; i <= N_CUST; i++) customer.push([BigInt(i), `Customer#${i}`, BigInt(Math.floor(rand() * 8)), Math.round(rand() * 10000 * 100) / 100, `seg${i % 5}`]);
  let lk = 1;
  for (let o = 1; o <= N_ORD; o++) {
    const date = 19920101 + Math.floor(rand() * 60000);
    orders.push([BigInt(o), BigInt(1 + Math.floor(rand() * N_CUST)), STATUS[o % 3]!, 0, BigInt(date), BigInt(1 + Math.floor(rand() * 5))]);
    const lines = 4;
    for (let l = 0; l < lines && lineitem.length < N_LINE; l++) {
      const qty = 1 + Math.floor(rand() * 50), price = Math.round(rand() * 1000 * 100) / 100;
      lineitem.push([BigInt(lk++), BigInt(o), BigInt(l + 1), BigInt(qty), price, Math.round(rand() * 10) / 100, Math.round(rand() * 8) / 100, FLAGS[Math.floor(rand() * 3)]!, STATUS[Math.floor(rand() * 2)]!, BigInt(date + Math.floor(rand() * 100))]);
    }
  }
  return { customer, orders, lineitem };
}

const SCHEMA = [
  "CREATE TABLE nation(n_nationkey INTEGER PRIMARY KEY, n_name TEXT, n_region TEXT)",
  "CREATE TABLE customer(c_custkey INTEGER PRIMARY KEY, c_name TEXT, c_nationkey INTEGER, c_acctbal REAL, c_mktsegment TEXT)",
  "CREATE TABLE orders(o_orderkey INTEGER PRIMARY KEY, o_custkey INTEGER, o_orderstatus TEXT, o_totalprice REAL, o_orderdate INTEGER, o_shippriority INTEGER)",
  "CREATE TABLE lineitem(l_id INTEGER PRIMARY KEY, l_orderkey INTEGER, l_linenumber INTEGER, l_quantity INTEGER, l_extendedprice REAL, l_discount REAL, l_tax REAL, l_returnflag TEXT, l_linestatus TEXT, l_shipdate INTEGER)",
];
const INDEXES = ["CREATE INDEX i_o_cust ON orders(o_custkey)", "CREATE INDEX i_l_order ON lineitem(l_orderkey)", "CREATE INDEX i_c_nation ON customer(c_nationkey)", "CREATE INDEX i_l_ship ON lineitem(l_shipdate)"];

const QUERIES: [string, string][] = [
  ["Q1 pricing summary", "SELECT l_returnflag, l_linestatus, sum(l_quantity), sum(l_extendedprice), sum(l_extendedprice * (1 - l_discount)), avg(l_quantity), count(*) FROM lineitem WHERE l_shipdate <= 19980902 GROUP BY l_returnflag, l_linestatus ORDER BY l_returnflag, l_linestatus"],
  ["Q3 shipping priority", "SELECT l_orderkey, sum(l_extendedprice * (1 - l_discount)) AS revenue, o_orderdate, o_shippriority FROM customer, orders, lineitem WHERE c_mktsegment = 'seg1' AND c_custkey = o_custkey AND l_orderkey = o_orderkey AND o_orderdate < 19950315 AND l_shipdate > 19950315 GROUP BY l_orderkey, o_orderdate, o_shippriority ORDER BY revenue DESC, o_orderdate LIMIT 10"],
  ["Q5 local supplier volume", "SELECT n_name, sum(l_extendedprice * (1 - l_discount)) AS revenue FROM customer, orders, lineitem, nation WHERE c_custkey = o_custkey AND l_orderkey = o_orderkey AND c_nationkey = n_nationkey AND n_region = 'ASIA' AND o_orderdate >= 19940101 AND o_orderdate < 19950101 GROUP BY n_name ORDER BY revenue DESC"],
  ["Q6 forecasting revenue", "SELECT sum(l_extendedprice * l_discount) AS revenue FROM lineitem WHERE l_shipdate >= 19940101 AND l_shipdate < 19950101 AND l_discount BETWEEN 0.05 AND 0.07 AND l_quantity < 24"],
  ["Q10 returned items", "SELECT c_custkey, c_name, sum(l_extendedprice * (1 - l_discount)) AS revenue, c_acctbal, n_name FROM customer, orders, lineitem, nation WHERE c_custkey = o_custkey AND l_orderkey = o_orderkey AND o_orderdate >= 19931001 AND o_orderdate < 19940101 AND l_returnflag = 'R' AND c_nationkey = n_nationkey GROUP BY c_custkey, c_name, c_acctbal, n_name ORDER BY revenue DESC LIMIT 20"],
  ["point lookup by PK (x1000)", "SELECT o_totalprice FROM orders WHERE o_orderkey = ?"],
  ["index lookup orders by customer (x1000)", "SELECT count(*), sum(o_totalprice) FROM orders WHERE o_custkey = ?"],
  ["index range lineitem by shipdate", "SELECT count(*), sum(l_quantity) FROM lineitem WHERE l_shipdate BETWEEN 19950101 AND 19950131"],
];

function fmt(n: number): string { return n >= 100 ? n.toFixed(0) : n.toFixed(1); }

async function insertAll(withIndexes: boolean): Promise<{ db: Database; ms: number; rows: number }> {
  const db = await Database.open({ memory: true, poolPages: 8192 });
  for (const s of SCHEMA) db.exec(s);
  if (withIndexes) for (const s of INDEXES) db.exec(s);
  db.exec("BEGIN");
  NATIONS.forEach((n, i) => db.query("INSERT INTO nation VALUES (?, ?, ?)", [BigInt(i), n, REGIONS[i]!]));
  const d = dataset();
  const t0 = performance.now();
  const ins = (table: string, rows: Value[][]): void => {
    const st = db.prepare(`INSERT INTO ${table} VALUES (${rows[0]!.map(() => "?").join(", ")})`);
    for (const r of rows) st.run(r);
  };
  ins("customer", d.customer); ins("orders", d.orders); ins("lineitem", d.lineitem);
  db.exec("COMMIT");
  const ms = performance.now() - t0;
  return { db, ms, rows: d.customer.length + d.orders.length + d.lineitem.length };
}

async function main(): Promise<void> {
  const lines: string[] = ["| benchmark | ms | rows/s or rows |", "|---|---:|---:|"];
  const plain = await insertAll(false);
  lines.push(`| bulk insert 76.5k rows, no secondary indexes | ${fmt(plain.ms)} | ${fmt(plain.rows / (plain.ms / 1000))} rows/s |`);
  await plain.db.close();
  const { db, ms, rows } = await insertAll(true);
  lines.push(`| bulk insert 76.5k rows, 4 secondary indexes | ${fmt(ms)} | ${fmt(rows / (ms / 1000))} rows/s |`);
  const t0 = performance.now();
  db.exec("ANALYZE");
  lines.push(`| ANALYZE (all tables) | ${fmt(performance.now() - t0)} | |`);
  for (const [name, sql] of QUERIES) {
    const st = db.prepare(sql);
    let out = 0;
    const reps = name.includes("x1000") ? 1000 : 3;
    st.run(name.includes("x1000") ? [1n] : []); // warm up
    const t = performance.now();
    for (let i = 0; i < reps; i++) out = st.run(name.includes("x1000") ? [BigInt(1 + (i * 7) % 15000)] : []).rows.length;
    const elapsed = (performance.now() - t) / (name.includes("x1000") ? 1 : reps);
    lines.push(`| ${name} | ${fmt(elapsed)} | ${out} rows |`);
  }
  console.log(lines.join("\n"));
  console.log("\nEXPLAIN Q3:\n" + db.query("EXPLAIN " + QUERIES[1]![1]).rows.map((r) => r[0]).join("\n"));
  await db.close();
}

void main();
