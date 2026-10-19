/**
 * Fills the expected results of `tests/slt/*.slt` query records that have an empty `----` section by running the
 * statements through SQLite (`node:sqlite`). Throwaway tooling: never imported by src/. Usage:
 *   node --import tsx scripts/slt-gen.ts [--check] [files...]
 * With --check, existing expectations are compared against SQLite and differences are reported.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatRows, parseSlt } from "../tests/slt/slt-format.js";
import type { Row, Value } from "../src/core/types.js";

const args = process.argv.slice(2);
const check = args.includes("--check");
const dir = join(process.cwd(), "tests", "slt");
const files = args.filter((a) => !a.startsWith("--"));
const targets = files.length ? files : readdirSync(dir).filter((f) => f.endsWith(".slt")).map((f) => join(dir, f));

function toValue(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint" || typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  return String(v);
}

for (const file of targets) {
  const text = readFileSync(file, "utf8");
  const records = parseSlt(text);
  const sq = new DatabaseSync(":memory:");
  const lines = text.split(/\r?\n/);
  const inserts: { afterLine: number; rows: string[]; replace: number }[] = [];
  let diffs = 0;
  for (const rec of records) {
    if (rec.kind === "halt") break;
    if (rec.kind === "statement") {
      try { sq.exec(rec.sql); if (!rec.ok) console.log(`${file}:${rec.line}: SQLite did NOT error`); }
      catch (e) { if (rec.ok) console.log(`${file}:${rec.line}: SQLite error: ${(e as Error).message}`); }
      continue;
    }
    let rows: Row[];
    try {
      const st = sq.prepare(rec.sql);
      st.setReadBigInts(true);
      st.setReturnArrays(true);
      rows = (st.all() as unknown as unknown[][]).map((r) => r.map(toValue));
    } catch (e) { console.log(`${file}:${rec.line}: SQLite query error: ${(e as Error).message}`); continue; }
    const formatted = formatRows(rows, rec.types ?? "", rec.sort ?? "nosort");
    if (rec.expected === undefined) continue;
    if (rec.expected.length === 0) {
      // locate the ---- line after the record
      let i = rec.line - 1; // 0-based index of the "query" line
      while (lines[i] !== "----") i++;
      inserts.push({ afterLine: i, rows: formatted, replace: 0 });
    } else if (check && JSON.stringify(rec.expected) !== JSON.stringify(formatted)) {
      diffs++;
      console.log(`${file}:${rec.line}: differs\n  expected(file): ${rec.expected.join(" | ")}\n  sqlite:         ${formatted.join(" | ")}`);
    }
  }
  if (inserts.length) {
    inserts.sort((a, b) => b.afterLine - a.afterLine);
    for (const ins of inserts) lines.splice(ins.afterLine + 1, 0, ...ins.rows);
    writeFileSync(file, lines.join("\n"));
    console.log(`${file}: filled ${inserts.length} result sections`);
  }
  if (check) console.log(`${file}: ${diffs} differences`);
  sq.close();
}
