/** sqllogictest parsing and value formatting shared by the runner and `scripts/slt-gen.ts` (no vitest import). */
import { formatReal } from "../../src/exec/functions.js";
import type { Row, Value } from "../../src/core/types.js";

export interface SltRecord {
  kind: "statement" | "query" | "halt";
  sql: string;
  ok?: boolean;
  errorPattern?: string;
  types?: string;
  sort?: "nosort" | "rowsort" | "valuesort";
  label?: string;
  expected?: string[];
  line: number;
}

export function parseSlt(text: string): SltRecord[] {
  const lines = text.split(/\r?\n/);
  const out: SltRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" || line.startsWith("#")) { i++; continue; }
    if (line.startsWith("hash-threshold") || line.startsWith("onlyif") || line.startsWith("skipif")) { i++; continue; }
    if (line.startsWith("halt")) { out.push({ kind: "halt", sql: "", line: i + 1 }); break; }
    const start = i + 1;
    const parts = line.trim().split(/\s+/);
    i++;
    const sqlLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && lines[i] !== "----") sqlLines.push(lines[i++]!);
    if (parts[0] === "statement") {
      out.push({ kind: "statement", ok: parts[1] === "ok", errorPattern: parts[1] === "error" ? parts.slice(2).join(" ") || undefined : undefined, sql: sqlLines.join("\n"), line: start });
    } else if (parts[0] === "query") {
      const rec: SltRecord = { kind: "query", sql: sqlLines.join("\n"), types: parts[1] ?? "", sort: "nosort", line: start };
      for (const p of parts.slice(2)) { if (p === "nosort" || p === "rowsort" || p === "valuesort") rec.sort = p; else rec.label = p; }
      if (lines[i] === "----") {
        i++;
        const exp: string[] = [];
        while (i < lines.length && lines[i]!.trim() !== "") exp.push(lines[i++]!);
        rec.expected = exp;
      }
      out.push(rec);
    } else throw new Error(`unknown record at line ${start}: ${line}`);
  }
  return out;
}

/** Formats one value as the SLT type letter prescribes. */
export function formatSlt(v: Value, type: string): string {
  if (v === null) return "NULL";
  switch (type) {
    case "I": {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "number") return Number.isFinite(v) ? String(Math.trunc(v)) : formatReal(v);
      if (typeof v === "boolean") return v ? "1" : "0";
      if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? String(Math.trunc(n)) : v; }
      return "0";
    }
    case "R": {
      if (typeof v === "number") return formatReal(v);
      if (typeof v === "bigint") return `${v}.0`;
      if (typeof v === "boolean") return v ? "1.0" : "0.0";
      if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? formatReal(n) : v; }
      return "0.0";
    }
    default: {
      if (typeof v === "string") return v === "" ? "(empty)" : v;
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "number") return formatReal(v);
      if (typeof v === "boolean") return v ? "1" : "0";
      let s = "";
      for (let i = 0; i < v.length; i++) s += v[i]!.toString(16).padStart(2, "0");
      return s;
    }
  }
}

export function formatRows(rows: Row[], types: string, sort: "nosort" | "rowsort" | "valuesort"): string[] {
  const lines = rows.map((r) => r.map((v, i) => formatSlt(v, types[i] ?? "T")).join(" "));
  if (sort === "rowsort") lines.sort();
  if (sort === "valuesort") { const vals = lines.flatMap((l) => l.split(" ")); vals.sort(); return vals; }
  return lines;
}

