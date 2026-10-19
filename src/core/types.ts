/**
 * Shared value and schema types. Every layer (storage, SQL, planner, executor) imports from here.
 * Keep this file dependency-free.
 */

/** Logical column types. INTEGER is a 64-bit signed integer (bigint at rest, number when safe). */
export type DataType = "INTEGER" | "REAL" | "TEXT" | "BLOB" | "BOOLEAN" | "NULL";

/**
 * Runtime value. INTEGER values are represented as `bigint` so the full 64-bit range round-trips through storage.
 * REAL as number, TEXT as string, BLOB as Uint8Array, BOOLEAN as boolean, NULL as null.
 */
export type Value = bigint | number | string | Uint8Array | boolean | null;

export type Row = Value[];

export interface ColumnDef {
  name: string;
  type: DataType;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  /** Serialized default expression (SQL source) or undefined. */
  defaultSql?: string;
}

export interface TableSchema {
  name: string;
  columns: ColumnDef[];
  /** Index of the INTEGER PRIMARY KEY column that doubles as rowid, or -1 if the table uses a hidden rowid. */
  rowidColumn: number;
}

export interface IndexSchema {
  name: string;
  table: string;
  /** Column indexes (into TableSchema.columns) in key order. */
  columns: number[];
  unique: boolean;
}

/** Column metadata returned with query results. `"ANY"` when the type depends on runtime values (parameters, mixed CASE arms). */
export interface ResultColumn {
  name: string;
  type: DataType | "ANY";
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: Row[];
  /** Rows affected by INSERT/UPDATE/DELETE; 0 for queries. */
  rowsAffected: number;
  /** Last inserted rowid, when applicable. */
  lastRowid?: bigint;
}

/** Total order over Values used by indexes, ORDER BY and comparisons. NULL < BOOLEAN < numbers < TEXT < BLOB. */
export function typeRank(v: Value): number {
  if (v === null) return 0;
  switch (typeof v) {
    case "boolean": return 1;
    case "bigint": return 2;
    case "number": return 2;
    case "string": return 3;
    default: return 4; // Uint8Array
  }
}

export function compareValues(a: Value, b: Value): number {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  switch (ra) {
    case 0: return 0;
    case 1: return (a === b) ? 0 : (a ? 1 : -1);
    case 2: {
      // mixed bigint/number comparison without precision loss where possible
      if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
      const na = typeof a === "bigint" ? Number(a) : (a as number);
      const nb = typeof b === "bigint" ? Number(b) : (b as number);
      if (Number.isNaN(na) || Number.isNaN(nb)) return Number.isNaN(na) ? (Number.isNaN(nb) ? 0 : -1) : 1;
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    case 3: return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
    default: {
      const x = a as Uint8Array, y = b as Uint8Array;
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) { const d = x[i]! - y[i]!; if (d !== 0) return d < 0 ? -1 : 1; }
      return x.length < y.length ? -1 : x.length > y.length ? 1 : 0;
    }
  }
}

export function valuesEqual(a: Value, b: Value): boolean {
  return compareValues(a, b) === 0;
}

export function typeOfValue(v: Value): DataType {
  if (v === null) return "NULL";
  switch (typeof v) {
    case "bigint": return "INTEGER";
    case "number": return Number.isInteger(v) && Number.isSafeInteger(v) ? "INTEGER" : "REAL";
    case "string": return "TEXT";
    case "boolean": return "BOOLEAN";
    default: return "BLOB";
  }
}
