/**
 * Execution context shared by every operator of one statement execution, plus the `Operator` interface.
 *
 * `ExecContext` implements the expression engine's `EvalContext`: `evalSubquery` runs the pre-planned subquery for the
 * given outer rows (materialised once when uncorrelated, otherwise through a small LRU keyed by the correlated values),
 * `random` is seedable (deterministic tests) and `now` is fixed per statement.
 *
 * Row convention (see `planner/layout.ts`): an operator evaluates expressions against `[currentRow, ...outerRows]`.
 */
import type { SchemaSet, TableInfo, WritableCatalog } from "../catalog/catalog.js";
import { BasaltError } from "../core/errors.js";
import type { ResultColumn, Row, Value } from "../core/types.js";
import type { Layout } from "../planner/layout.js";
import type { BoundCte, BoundSubquery } from "../sql/bound.js";
import { BTree } from "../storage/btree.js";
import type { Pager } from "../storage/pager.js";
import type { WriteTxn } from "../txn/transaction.js";
import type { EvalContext } from "./expr.js";

export interface OperatorStats { rows: number; ms: number; loops: number }

/** Volcano iterator. `open` may be called again after `close` (subquery re-evaluation, nested-loop rewinds). */
export interface Operator {
  open(ctx: ExecContext): void;
  next(): Row | null;
  close(): void;
  readonly schema: ResultColumn[];
  readonly stats: OperatorStats;
}

/** What the executor needs from the storage/transaction layer. */
export interface StorageAccess {
  readonly pager: Pager;
  /** The write transaction, when the statement may modify data. */
  readonly txn?: WriteTxn;
  /** Schema as of this statement (writable inside a write transaction). */
  readonly schema: SchemaSet | WritableCatalog;
  rootOf(name: string): number;
}

export function layoutSchema(layout: Layout): ResultColumn[] {
  return layout.slots.map((s) => ({ name: s.name, type: s.type }));
}

export const EMPTY_ROW: Row = [];

/** Runs one pre-planned subquery (operator tree built once, re-opened per evaluation). */
export class SubqueryRunner {
  private readonly cache = new Map<string, readonly Row[]>();
  constructor(
    readonly op: Operator,
    /** Where the correlated values live in the caller's `rows`: `rows[depth][slot]`. Empty => uncorrelated. */
    readonly correlated: { depth: number; slot: number }[],
  ) {}

  run(shared: SharedExec, rows: Row[]): readonly Row[] {
    let key = "";
    if (this.correlated.length) {
      const parts: string[] = [];
      for (const c of this.correlated) parts.push(valueKey(rows[c.depth - 1]?.[c.slot] ?? null));
      key = parts.join("\u0001");
    }
    const hit = this.cache.get(key);
    if (hit) return hit;
    const ctx = new ExecContext(shared, rows);
    const out: Row[] = [];
    this.op.open(ctx);
    try {
      for (let r = this.op.next(); r !== null; r = this.op.next()) out.push(r);
    } finally { this.op.close(); }
    if (this.cache.size >= 64) { const first = this.cache.keys().next().value; if (first !== undefined) this.cache.delete(first); }
    this.cache.set(key, out);
    return out;
  }

  reset(): void { this.cache.clear(); }
}

function valueKey(v: Value): string {
  if (v === null) return "n";
  switch (typeof v) {
    case "bigint": return `i${v}`;
    case "number": return Number.isInteger(v) && Number.isSafeInteger(v) ? `i${v}` : `r${v}`;
    case "boolean": return v ? "i1" : "i0";
    case "string": return `s${v}`;
    default: { let s = "b"; for (let i = 0; i < v.length; i++) s += v[i]!.toString(16).padStart(2, "0"); return s; }
  }
}

/** Per-statement state shared by all contexts (one per outer-row binding) of an execution. */
export class SharedExec {
  readonly subplans = new Map<BoundSubquery, SubqueryRunner>();
  /** Materialised CTE results. */
  readonly cteRows = new Map<BoundCte, Row[]>();
  /** The working table of a recursive CTE while its recursive term runs. */
  readonly workingTables = new Map<BoundCte, Row[]>();
  rowsAffected = 0;
  lastRowid: bigint | undefined;
  readonly nowMs: number;
  private rngState: number;

  constructor(public storage: StorageAccess, public params: readonly Value[], seed?: number) {
    this.nowMs = Date.now();
    this.rngState = seed === undefined ? (Math.floor(Math.random() * 0xffffffff) >>> 0) : seed >>> 0;
  }

  /** mulberry32 */
  random(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Clears per-execution caches (prepared statement re-execution). */
  resetForExecution(params: readonly Value[]): void {
    this.params = params;
    for (const r of this.subplans.values()) r.reset();
    this.cteRows.clear();
    this.workingTables.clear();
    this.rowsAffected = 0;
    this.lastRowid = undefined;
  }

  /** Read-only tree of a table or index as of this statement. */
  readTree(name: string): BTree { return new BTree(this.storage.pager, this.storage.rootOf(name)); }

  /** Writable tree; the caller must call `setRoot` with `tree.root` afterwards. */
  writeTree(name: string): BTree {
    if (!this.storage.txn) throw new BasaltError("attempt to write a read-only database", "READONLY");
    return new BTree(this.storage.pager, this.storage.rootOf(name), this.storage.txn);
  }

  get writable(): WritableCatalog {
    const s = this.storage.schema;
    if (!("txn" in s)) throw new BasaltError("attempt to write a read-only database", "READONLY");
    return s;
  }

  table(name: string): TableInfo {
    const t = this.storage.schema.table(name);
    if (!t) throw new BasaltError(`no such table: ${name}`);
    return t;
  }
}

export class ExecContext implements EvalContext {
  constructor(readonly shared: SharedExec, readonly outerRows: Row[]) {}

  get params(): readonly Value[] { return this.shared.params; }

  evalSubquery(subquery: BoundSubquery, rows: Row[]): readonly Row[] {
    const runner = this.shared.subplans.get(subquery);
    if (!runner) throw new BasaltError("internal: subquery was not planned");
    return runner.run(this.shared, rows);
  }

  random(): number { return this.shared.random(); }
  now(): number { return this.shared.nowMs; }

  /** Context for a nested scope whose depth-1 rows are `rows`. */
  child(rows: Row[]): ExecContext { return new ExecContext(this.shared, rows); }
}
