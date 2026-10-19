/**
 * Random schema / data / SELECT generator for differential fuzzing against SQLite. The grammar is restricted to the
 * semantics Basalt shares with SQLite (see docs/SQLITE-DIVERGENCES.md): comparisons stay within one type family,
 * integers stay small, text never meets numbers, REAL results are compared with tolerance.
 */
import type { Value } from "../src/core/types.js";

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Table { name: string; columns: { name: string; type: "INTEGER" | "REAL" | "TEXT" }[]; rows: Value[][] }

const WORDS = ["ant", "bee", "cat", "dog", "eel", "fox", "gnu", "hen"];

export function genSchema(rand: () => number): Table[] {
  const n = 2 + Math.floor(rand() * 2);
  const tables: Table[] = [];
  for (let t = 0; t < n; t++) {
    const columns: Table["columns"] = [{ name: "id", type: "INTEGER" }, { name: "a", type: "INTEGER" }, { name: "b", type: "REAL" }, { name: "c", type: "TEXT" }];
    const rows: Value[][] = [];
    const count = 3 + Math.floor(rand() * 15);
    for (let i = 0; i < count; i++) {
      rows.push([
        BigInt(i + 1),
        rand() < 0.15 ? null : BigInt(Math.floor(rand() * 20) - 5),
        rand() < 0.15 ? null : Math.round((rand() * 40 - 10) * 4) / 4 + 0.25,
        rand() < 0.15 ? null : WORDS[Math.floor(rand() * WORDS.length)]!,
      ]);
    }
    tables.push({ name: `t${t}`, columns, rows });
  }
  return tables;
}

export function schemaSql(tables: Table[]): string[] {
  const out: string[] = [];
  for (const t of tables) {
    out.push(`CREATE TABLE ${t.name}(${t.columns.map((c) => `${c.name} ${c.type}${c.name === "id" ? " PRIMARY KEY" : ""}`).join(", ")})`);
    for (const r of t.rows) out.push(`INSERT INTO ${t.name} VALUES (${r.map(lit).join(", ")})`);
  }
  return out;
}

function lit(v: Value): string {
  if (v === null) return "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isInteger(v) ? `${v}.0` : String(v);
  return `'${String(v)}'`;
}

interface Rel { alias: string; table: Table }

/** Generates one SELECT; returns the SQL and whether the result is fully ordered (LIMIT only when it is). */
export function genQuery(rand: () => number, tables: Table[]): string {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const rels: Rel[] = [{ alias: "x", table: pick(tables) }];
  let from = `${rels[0]!.table.name} x`;
  if (rand() < 0.5) {
    const t2 = pick(tables);
    rels.push({ alias: "y", table: t2 });
    const kind = pick(["JOIN", "LEFT JOIN", "JOIN", "CROSS JOIN"]);
    const cond = kind === "CROSS JOIN" ? "" : ` ON ${pick(["x.a = y.a", "x.id = y.id", "x.c = y.c", "x.a < y.a", "x.id = y.a"])}`;
    from += ` ${kind} ${t2.name} y${cond}`;
  }
  const col = (type?: "INTEGER" | "REAL" | "TEXT"): string => {
    const r = pick(rels);
    const cs = r.table.columns.filter((c) => !type || c.type === type);
    return `${r.alias}.${pick(cs).name}`;
  };
  const intExpr = (d = 0): string => {
    const k = rand();
    if (d > 1 || k < 0.4) return col("INTEGER");
    if (k < 0.55) return `(${intExpr(d + 1)} + ${intExpr(d + 1)})`;
    if (k < 0.65) return `(${intExpr(d + 1)} * ${Math.floor(rand() * 4)})`;
    if (k < 0.75) return `abs(${intExpr(d + 1)})`;
    if (k < 0.85) return `coalesce(${intExpr(d + 1)}, ${Math.floor(rand() * 9)})`;
    if (k < 0.93) return `CASE WHEN ${pred(d + 1)} THEN ${intExpr(d + 1)} ELSE ${Math.floor(rand() * 9)} END`;
    return `length(${col("TEXT")})`;
  };
  const realExpr = (): string => pick([col("REAL"), `(${col("REAL")} * 2)`, `(${col("REAL")} + ${col("INTEGER")})`, `round(${col("REAL")}, 1)`, `(${col("REAL")} / 2)`]);
  const textExpr = (): string => pick([col("TEXT"), `upper(${col("TEXT")})`, `(${col("TEXT")} || '_')`, `substr(${col("TEXT")}, 1, 2)`]);
  const pred = (d = 0): string => {
    const k = rand();
    if (d < 2 && k < 0.15) return `(${pred(d + 1)} AND ${pred(d + 1)})`;
    if (d < 2 && k < 0.25) return `(${pred(d + 1)} OR ${pred(d + 1)})`;
    if (k < 0.3) return `NOT ${pred(d + 1)}`;
    if (k < 0.45) return `${col("INTEGER")} ${pick(["=", "<", ">", "<=", ">=", "<>"])} ${Math.floor(rand() * 20) - 5}`;
    if (k < 0.55) return `${col("REAL")} ${pick(["<", ">"])} ${Math.floor(rand() * 30) - 10}.5`;
    if (k < 0.65) return `${col("TEXT")} ${pick(["=", "<", ">"])} '${pick(WORDS)}'`;
    if (k < 0.72) return `${col()} IS ${rand() < 0.5 ? "" : "NOT "}NULL`;
    if (k < 0.8) return `${col("INTEGER")} IN (${Math.floor(rand() * 9)}, ${Math.floor(rand() * 9)}, NULL)`;
    if (k < 0.86) return `${col("INTEGER")} BETWEEN ${Math.floor(rand() * 5)} AND ${5 + Math.floor(rand() * 9)}`;
    if (k < 0.92) return `${col("TEXT")} LIKE '${pick(["%e%", "c%", "_o_", "%x"])}'`;
    return `${intExpr(d + 1)} = ${intExpr(d + 1)}`;
  };
  const agg = (): string => pick([`count(*)`, `count(${col()})`, `sum(${col("INTEGER")})`, `min(${col("INTEGER")})`, `max(${col("TEXT")})`, `avg(${col("REAL")})`, `total(${col("INTEGER")})`, `count(DISTINCT ${col("INTEGER")})`, `sum(${col("REAL")})`]);
  const grouped = rand() < 0.35;
  let select: string[];
  let groupBy = "";
  if (grouped) {
    const keys = [col(), ...(rand() < 0.4 ? [col()] : [])];
    select = [...keys, agg(), agg()];
    groupBy = ` GROUP BY ${keys.join(", ")}`;
    if (rand() < 0.4) groupBy += ` HAVING ${pick([`count(*) > 1`, `count(*) >= 1`, `min(${col("INTEGER")}) > 0`])}`;
  } else {
    select = [];
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) select.push(pick([intExpr(), realExpr(), textExpr(), col()]));
    if (rand() < 0.2) select.push(`CASE WHEN ${pred()} THEN 1 ELSE 0 END`);
  }
  let sql = `SELECT ${rand() < 0.15 && !grouped ? "DISTINCT " : ""}${select.join(", ")} FROM ${from}`;
  if (rand() < 0.7) sql += ` WHERE ${pred()}`;
  sql += groupBy;
  if (rand() < 0.5) {
    const n = select.length;
    const terms: string[] = [];
    for (let i = 1; i <= n; i++) terms.push(`${i}${rand() < 0.3 ? " DESC" : ""}`);
    sql += ` ORDER BY ${terms.join(", ")}`;
    if (rand() < 0.5) sql += ` LIMIT ${1 + Math.floor(rand() * 8)}`;
  }
  return sql;
}

/** Normalises a value for comparison: integers exactly, reals rounded, text exactly. */
export function normalizeValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "bigint") return `i:${v}`;
  if (typeof v === "number") return Number.isInteger(v) ? `i:${v}` : `r:${v.toPrecision(10)}`;
  if (typeof v === "boolean") return v ? "i:1" : "i:0";
  return `t:${String(v)}`;
}

export function normalizeRows(rows: unknown[][], ordered: boolean): string[] {
  const out = rows.map((r) => r.map(normalizeValue).join("|"));
  if (!ordered) out.sort();
  return out;
}
