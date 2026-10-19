/** QueryResult helpers: SQLite-like column naming and value formatting. */
import type { QueryResult, ResultColumn, Row, Value } from "../core/types.js";
import { formatReal } from "../exec/functions.js";
import type { Layout } from "../planner/layout.js";

export function emptyResult(columns: ResultColumn[] = []): QueryResult {
  return { columns, rows: [], rowsAffected: 0 };
}

export function columnsOfLayout(layout: Layout): ResultColumn[] {
  return layout.slots.map((s) => ({ name: s.name, type: s.type }));
}

export function makeResult(columns: ResultColumn[], rows: Row[], rowsAffected = 0, lastRowid?: bigint): QueryResult {
  const r: QueryResult = { columns, rows, rowsAffected };
  if (lastRowid !== undefined) r.lastRowid = lastRowid;
  return r;
}

/** Text form of a value for display (NULL as `NULL`, reals SQLite-style, blobs as X'..'). */
export function formatValue(v: Value): string {
  if (v === null) return "NULL";
  switch (typeof v) {
    case "bigint": return v.toString();
    case "number": return formatReal(v);
    case "boolean": return v ? "1" : "0";
    case "string": return v;
    default: { let s = "X'"; for (let i = 0; i < v.length; i++) s += v[i]!.toString(16).padStart(2, "0"); return s + "'"; }
  }
}
