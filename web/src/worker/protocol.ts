/**
 * Message protocol between the page and the database worker. Every request carries an id; the worker answers with
 * exactly one response of the same id. Values cross the boundary in a JSON-safe form: INTEGER (bigint) becomes
 * `{ t: "int", v: "123" }`, BLOB becomes `{ t: "blob", v: "<hex>" }`, everything else is passed as is.
 */
import type { BTreeStats, DatabaseStats, PageDetail, PageInfo, PlanNode, ResultColumn } from "../../../src/index.js";

export type WireCell = string | number | boolean | null | { t: "int"; v: string } | { t: "blob"; v: string };
export type WireRow = WireCell[];

export interface WireResult {
  columns: ResultColumn[];
  rows: WireRow[];
  rowsAffected: number;
  lastRowid?: string;
  /** Wall-clock milliseconds spent inside the engine for this statement. */
  ms: number;
}

export interface WireError { name: string; message: string; line?: number; col?: number }

export type BackendKind = "opfs" | "indexeddb" | "memory";

export type DatasetName = "tpch_mini" | "orders_50k" | "world";

export interface WirePageDetail extends Omit<PageDetail, "cells"> {
  cells: { index: number; key: string; keyBytes: number; child?: number; value?: string; valueBytes?: number; overflowPage?: number }[];
}

export interface TableTreeStats extends BTreeStats { name: string; objectType: "table" | "index" }

export interface Methods {
  open: { args: []; result: { backend: BackendKind; name: string; log: string[] } };
  /** Runs every statement of `sql`; returns one result per statement. */
  exec: { args: [sql: string]; result: WireResult[] };
  /** Runs one statement. */
  query: { args: [sql: string]; result: WireResult };
  explain: { args: [sql: string, analyze: boolean]; result: { plan: PlanNode; text: string[]; ms: number } };
  pageMap: { args: []; result: PageInfo[] };
  describePage: { args: [pageId: number]; result: WirePageDetail };
  btreeStats: { args: []; result: TableTreeStats[] };
  stats: { args: []; result: DatabaseStats & { tables: string[] } };
  loadDataset: { args: [name: DatasetName]; result: { ms: number; rows: number; tables: string[] } };
  export: { args: []; result: Uint8Array };
  reset: { args: []; result: { backend: BackendKind } };
}

export type MethodName = keyof Methods;

export interface Request<M extends MethodName = MethodName> { id: number; method: M; args: Methods[M]["args"] }
export type Response<M extends MethodName = MethodName> =
  | { id: number; ok: true; result: Methods[M]["result"] }
  | { id: number; ok: false; error: WireError };
