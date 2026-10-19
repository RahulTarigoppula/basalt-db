/** Row ⇄ storage helpers shared by scans and DML: table records keyed by rowid, index entries keyed by (columns, rowid). */
import type { IndexInfo, TableInfo } from "../catalog/catalog.js";
import { KeyReader, decodeRecord, encodeKey, encodeRecord } from "../core/encoding.js";
import type { Row, Value } from "../core/types.js";
import { normalize } from "./functions.js";

/** Decodes the rowid from a table key. */
export function rowidOfKey(key: Uint8Array): bigint {
  const v = new KeyReader(key).next();
  return typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v)));
}

export function rowidKeyBytes(rowid: bigint): Uint8Array { return encodeKey([rowid]); }

/**
 * Decodes a stored record into a row of `columns + 1` values: the table's columns (padded with the constant defaults of
 * columns added later by ALTER TABLE) followed by the rowid.
 */
export function decodeTableRow(table: TableInfo, key: Uint8Array, value: Uint8Array): Row {
  const n = table.schema.columns.length;
  const rec = decodeRecord(value);
  const row = new Array<Value>(n + 1);
  const m = Math.min(n, rec.length);
  for (let i = 0; i < m; i++) row[i] = rec[i]!;
  for (let i = m; i < n; i++) row[i] = table.padDefaults[i] ?? null;
  row[n] = rowidOfKey(key);
  return row;
}

/** Encodes the first `columns` values of a row (the rowid slot is not stored). */
export function encodeTableRow(table: TableInfo, row: Row): Uint8Array {
  const n = table.schema.columns.length;
  return encodeRecord(row.length === n ? row : row.slice(0, n));
}

/** Index key `[...normalised index columns, rowid]`. */
export function indexKey(index: IndexInfo, row: Row, rowid: bigint): Uint8Array {
  const vals = new Array<Value>(index.schema.columns.length + 1);
  index.schema.columns.forEach((c, i) => { vals[i] = normalize(row[c] ?? null); });
  vals[index.schema.columns.length] = rowid;
  return encodeKey(vals);
}

/** Key prefix of the index columns only (for uniqueness checks and seeks). */
export function indexPrefix(index: IndexInfo, row: Row): Uint8Array {
  const vals = index.schema.columns.map((c) => normalize(row[c] ?? null));
  return encodeKey(vals);
}

export function startsWith(key: Uint8Array, prefix: Uint8Array): boolean {
  if (key.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (key[i] !== prefix[i]) return false;
  return true;
}

export const EMPTY_VALUE = new Uint8Array(0);
