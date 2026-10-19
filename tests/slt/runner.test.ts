/**
 * sqllogictest runner. Format (one record per blank-line separated block):
 *
 *   statement ok            # SQL on the following lines
 *   statement error [regex] # must throw (message matching regex when given)
 *   query <types> [nosort|rowsort|valuesort] [label]
 *   <sql>
 *   ----
 *   <one row per line, values separated by single spaces; NULL as NULL; "" as (empty)>
 *
 * Types: I integer, R real (SQLite %.15g formatting), T text. `hash-threshold` lines are accepted and ignored.
 * Expected results were produced by SQLite (`scripts/slt-gen.ts`) and reviewed by hand.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "../../src/engine/database.js";
import type { Row } from "../../src/core/types.js";
import { formatRows, parseSlt } from "./slt-format.js";

const dir = join(__dirname);
const files = readdirSync(dir).filter((f) => f.endsWith(".slt")).sort();

describe("sqllogictest", () => {
  for (const file of files) {
    it(file, async () => {
      const db = await Database.open({ memory: true });
      const records = parseSlt(readFileSync(join(dir, file), "utf8"));
      try {
        for (const rec of records) {
          if (rec.kind === "halt") break;
          const where = `${file}:${rec.line}: ${rec.sql}`;
          if (rec.kind === "statement") {
            if (rec.ok) {
              try { db.exec(rec.sql); } catch (e) { throw new Error(`${where}\nexpected success, got: ${(e as Error).message}`); }
            } else {
              let threw = false, msg = "";
              try { db.exec(rec.sql); } catch (e) { threw = true; msg = (e as Error).message; }
              if (!threw) throw new Error(`${where}\nexpected an error`);
              if (rec.errorPattern && !new RegExp(rec.errorPattern, "i").test(msg)) throw new Error(`${where}\nerror "${msg}" does not match /${rec.errorPattern}/`);
            }
            continue;
          }
          let rows: Row[];
          try { rows = db.query(rec.sql).rows; } catch (e) { throw new Error(`${where}\nquery failed: ${(e as Error).message}`); }
          if (rec.expected === undefined) continue;
          const actual = formatRows(rows, rec.types ?? "", rec.sort ?? "nosort");
          const exp = rec.expected;
          if (exp.length === 1 && /^\d+ values hashing to/.test(exp[0]!)) continue; // hash results are not supported
          expect(actual, where).toEqual(exp);
        }
      } finally { await db.close(); }
    });
  }
});
