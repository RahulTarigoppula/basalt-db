/**
 * Hash keys for joins, grouping, DISTINCT and set operations. Values are normalised so SQL-equal values hash equal:
 * booleans become 0/1, integral REALs hash like the INTEGER of the same value (`5 = 5.0`), text and blobs by content.
 */
import type { Row, Value } from "../core/types.js";

/** Appends the key of one value to a string builder. */
export function appendValueKey(v: Value): string {
  if (v === null) return "n";
  switch (typeof v) {
    case "bigint": return `i${v}\u0001`;
    case "number": return Number.isInteger(v) && Math.abs(v) < 9007199254740992 ? `i${v}\u0001` : `r${v}\u0001`;
    case "boolean": return v ? "i1\u0001" : "i0\u0001";
    case "string": return `s${v}\u0001`;
    default: { let s = "b"; for (let i = 0; i < v.length; i++) s += v[i]!.toString(16).padStart(2, "0"); return s + "\u0001"; }
  }
}

/** Key of a whole row (NULLs are equal to each other - grouping / DISTINCT semantics). */
export function rowKey(row: Row, count = row.length): string {
  let s = "";
  for (let i = 0; i < count; i++) s += appendValueKey(row[i] ?? null);
  return s;
}

/** Key of selected values; returns null when any value is NULL (join semantics: NULL never matches). */
export function joinKey(values: Value[]): string | null {
  let s = "";
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? null;
    if (v === null) return null;
    s += appendValueKey(v);
  }
  return s;
}
