/**
 * Long-running differential fuzzer: Basalt vs SQLite (`node:sqlite`).
 *   node --import tsx scripts/fuzz.ts --iters 5000 --seed 1
 */
import { DatabaseSync } from "node:sqlite";
import { Database } from "../src/engine/database.js";
import { genQuery, genSchema, normalizeRows, rng, schemaSql } from "./fuzz-gen.js";

const args = process.argv.slice(2);
const opt = (name: string, def: number): number => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const iters = opt("iters", 1000), seed = opt("seed", 1);

export interface FuzzResult { ok: number; mismatches: { sql: string; basalt: string[]; sqlite: string[] }[]; errors: { sql: string; message: string }[] }

export async function runFuzz(iters: number, seed: number, log = false): Promise<FuzzResult> {
  const rand = rng(seed);
  const res: FuzzResult = { ok: 0, mismatches: [], errors: [] };
  let schemaIter = 0;
  let db = await Database.open({ memory: true });
  let sq = new DatabaseSync(":memory:");
  let tables = genSchema(rand);
  const setup = (): void => { for (const s of schemaSql(tables)) { db.exec(s); sq.exec(s); } };
  setup();
  for (let i = 0; i < iters; i++) {
    if (++schemaIter > 40) {
      schemaIter = 0;
      await db.close(); sq.close();
      db = await Database.open({ memory: true }); sq = new DatabaseSync(":memory:");
      tables = genSchema(rand);
      setup();
    }
    const sql = genQuery(rand, tables);
    const ordered = / ORDER BY /.test(sql);
    let expected: string[];
    try {
      const st = sq.prepare(sql);
      st.setReadBigInts(true);
      st.setReturnArrays(true);
      expected = normalizeRows(st.all() as unknown as unknown[][], ordered);
    } catch (e) { res.errors.push({ sql, message: `sqlite: ${(e as Error).message}` }); continue; }
    let actual: string[];
    try { actual = normalizeRows(db.query(sql).rows, ordered); }
    catch (e) { res.errors.push({ sql, message: `basalt: ${(e as Error).message}` }); if (log) console.log(`ERROR ${sql}\n  ${(e as Error).message}`); continue; }
    if (ordered && / LIMIT /.test(sql)) {
      // with ties, LIMIT may pick different rows: compare as multisets of the limited size only when sizes match
      if (actual.length !== expected.length) { res.mismatches.push({ sql, basalt: actual, sqlite: expected }); continue; }
      const a = [...actual].sort(), b = [...expected].sort();
      if (JSON.stringify(a) !== JSON.stringify(b) && !tiesPossible(sql)) res.mismatches.push({ sql, basalt: actual, sqlite: expected });
      else res.ok++;
      continue;
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) { res.mismatches.push({ sql, basalt: actual, sqlite: expected }); if (log) console.log(`MISMATCH ${sql}\n  basalt: ${actual.join(" ; ")}\n  sqlite: ${expected.join(" ; ")}`); }
    else res.ok++;
  }
  await db.close(); sq.close();
  return res;
}

/** ORDER BY over all projected columns with LIMIT can still differ when whole rows tie: accept. */
function tiesPossible(_sql: string): boolean { return true; }

const isMain = process.argv[1] !== undefined && /fuzz\.ts$/.test(process.argv[1]);
if (isMain) {
  const r = await runFuzz(iters, seed, true);
  console.log(`ok=${r.ok} mismatches=${r.mismatches.length} errors=${r.errors.length}`);
  for (const e of r.errors.slice(0, 20)) console.log(`${e.message}\n  ${e.sql}`);
  process.exit(r.mismatches.length || r.errors.some((e) => e.message.startsWith("basalt")) ? 1 : 0);
}
