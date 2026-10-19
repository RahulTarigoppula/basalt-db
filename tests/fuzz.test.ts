/** Small differential fuzz run against SQLite (the long run lives in scripts/fuzz.ts). */
import { describe, expect, it } from "vitest";
import { runFuzz } from "../scripts/fuzz.js";

describe("differential fuzz vs node:sqlite", () => {
  it("agrees with SQLite on 300 random queries", async () => {
    const r = await runFuzz(300, 7);
    const basaltErrors = r.errors.filter((e) => e.message.startsWith("basalt"));
    const report = [...r.mismatches.map((m) => `MISMATCH ${m.sql}\n  basalt: ${m.basalt.join(" ; ")}\n  sqlite: ${m.sqlite.join(" ; ")}`), ...basaltErrors.map((e) => `${e.message}\n  ${e.sql}`)].join("\n");
    expect(report).toBe("");
    expect(r.ok).toBeGreaterThan(250);
  });
});
