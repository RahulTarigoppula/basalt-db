/**
 * The catalog: `basalt_master(type, name, tbl_name, rootpage, sql)` stored in a B+tree whose root is the meta page's
 * `masterRoot`, plus `basalt_stats` (written by ANALYZE). Rows of both are ordinary table records keyed by rowid, so
 * `SELECT * FROM basalt_master` works through the normal scan path.
 *
 * - `Catalog.forSnapshot(snapshot)` returns an immutable `SchemaSet` (cached per committed txn id) rebuilt by parsing
 *   every `sql` with the real parser and binder.
 * - `Catalog.beginWrite(txn)` returns a `WritableCatalog`: a copy-on-modify `SchemaSet` plus the bookkeeping a write
 *   transaction needs - the current root page of every table/index (roots move under copy-on-write; executors read
 *   `tree.root` back after writing and call `setRoot`), hidden-rowid allocation, and the pending master-row writes that
 *   `flush()` persists into the master tree (then `txn.masterRoot` is updated). `saveState()/restoreState()` back
 *   savepoints and statement-level rollback.
 *
 * UNIQUE and non-rowid PRIMARY KEY constraints are enforced through automatic unique indexes named
 * `basalt_autoindex_<table>_<n>` (their `sql` is a synthetic CREATE UNIQUE INDEX statement, unlike SQLite's NULL).
 */
import { decodeKey, decodeRecord, encodeKey, encodeRecord } from "../core/encoding.js";
import { BasaltError } from "../core/errors.js";
import type { ColumnDef, IndexSchema, TableSchema, Value } from "../core/types.js";
import { builtinFunctions } from "../exec/functions.js";
import { evaluateConstant, isConstantExpr } from "../exec/expr.js";
import { bind, bindExpression } from "../sql/binder.js";
import type { BoundCreateIndex, BoundCreateTable, BoundExpr } from "../sql/bound.js";
import { tokenize } from "../sql/lexer.js";
import { parseExpression, parseOne } from "../sql/parser.js";
import { exprToSql } from "../sql/print.js";
import { MemorySchemaProvider, type SchemaProvider, type ViewSchema } from "../sql/schema-provider.js";
import { BTree } from "../storage/btree.js";
import type { Pager } from "../storage/pager.js";
import type { Snapshot, WriteTxn } from "../txn/transaction.js";

// ----- types -----

export type MasterType = "table" | "index" | "view";

/** One row of `basalt_master`. */
export interface MasterEntry {
  rowid: bigint;
  type: MasterType;
  name: string;
  tblName: string;
  rootpage: number;
  sql: string | null;
}

export interface TableInfo {
  kind: "table";
  entry: MasterEntry;
  schema: TableSchema;
  root: number;
  /** CHECK constraints bound against `rows[0]` = candidate row. */
  checks: BoundExpr[];
  checkText: string[];
  /** Constant default per column (null when none or non-constant); used to pad rows stored before ALTER TABLE ADD COLUMN. */
  padDefaults: Value[];
  /** True for the engine's own tables (`basalt_master`, `basalt_stats`). */
  internal: boolean;
}

export interface IndexInfo {
  kind: "index";
  entry: MasterEntry;
  schema: IndexSchema;
  root: number;
  /** Partial-index predicate bound against `rows[0]` = table row. */
  where?: BoundExpr;
  /** Automatic index backing a UNIQUE / PRIMARY KEY constraint. */
  auto: boolean;
}

export interface ViewInfo {
  kind: "view";
  entry: MasterEntry;
  view: ViewSchema;
}

/** Column statistics gathered by ANALYZE. */
export interface ColumnStats {
  nDistinct: number;
  nullFrac: number;
  min: Value;
  max: Value;
  /** Equi-height histogram boundaries (ascending, `buckets + 1` values) or undefined. */
  histogram?: Value[];
}

export interface TableStats {
  nRows: number;
  columns: Map<number, ColumnStats>;
}

export const MASTER_TABLE = "basalt_master";
export const STATS_TABLE = "basalt_stats";
const AUTOINDEX_PREFIX = "basalt_autoindex_";

function col(name: string, type: ColumnDef["type"], notNull = false): ColumnDef {
  return { name, type, notNull, primaryKey: false, unique: false };
}

export const MASTER_SCHEMA: TableSchema = {
  name: MASTER_TABLE, rowidColumn: -1,
  columns: [col("type", "TEXT"), col("name", "TEXT"), col("tbl_name", "TEXT"), col("rootpage", "INTEGER"), col("sql", "TEXT")],
};

export const STATS_SCHEMA: TableSchema = {
  name: STATS_TABLE, rowidColumn: -1,
  columns: [
    col("tbl", "TEXT"), col("col", "TEXT"), col("n_rows", "INTEGER"), col("n_distinct", "INTEGER"), col("null_frac", "REAL"),
    col("min_key", "BLOB"), col("max_key", "BLOB"), col("histogram_json", "TEXT"),
  ],
};
const STATS_SQL = `CREATE TABLE ${STATS_TABLE}(tbl TEXT, col TEXT, n_rows INTEGER, n_distinct INTEGER, null_frac REAL, min_key, max_key, histogram_json TEXT)`;

function lower(s: string): string { return s.toLowerCase(); }

export function quoteIdent(name: string): string { return `"${name.replace(/"/g, "\"\"")}"`; }

export function isAutoIndex(name: string): boolean { return name.toLowerCase().startsWith(AUTOINDEX_PREFIX); }

// ----- JSON helpers for stats -----

function valueToJson(v: Value): unknown {
  if (v === null) return null;
  switch (typeof v) {
    case "bigint": return { i: v.toString() };
    case "number": return Number.isFinite(v) ? v : { r: String(v) };
    case "boolean": return v ? { i: "1" } : { i: "0" };
    case "string": return v;
    default: { let s = ""; for (let i = 0; i < v.length; i++) s += v[i]!.toString(16).padStart(2, "0"); return { b: s }; }
  }
}

function valueFromJson(j: unknown): Value {
  if (j === null || j === undefined) return null;
  if (typeof j === "number") return j;
  if (typeof j === "string") return j;
  if (typeof j === "object") {
    const o = j as { i?: string; r?: string; b?: string };
    if (o.i !== undefined) return BigInt(o.i);
    if (o.r !== undefined) return Number(o.r);
    if (o.b !== undefined) { const out = new Uint8Array(o.b.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(o.b.slice(i * 2, i * 2 + 2), 16); return out; }
  }
  return null;
}

/** Serialises a histogram for `basalt_stats.histogram_json`. */
export function histogramToJson(bounds: Value[]): string { return JSON.stringify(bounds.map(valueToJson)); }

// ----- SchemaSet -----

/**
 * The schema as of one point in time. Immutable once built for a snapshot; the `WritableCatalog` clones it and
 * replaces entries copy-on-modify so the snapshot's objects are never mutated.
 */
export class SchemaSet implements SchemaProvider {
  readonly tables = new Map<string, TableInfo>();
  readonly indexes = new Map<string, IndexInfo>();
  readonly views = new Map<string, ViewInfo>();
  /** Every master row by rowid. */
  readonly entries = new Map<bigint, MasterEntry>();
  private statsCache: Map<string, TableStats> | null = null;

  constructor(public masterRoot: number) {}

  clone(): SchemaSet {
    const s = new SchemaSet(this.masterRoot);
    for (const [k, v] of this.tables) s.tables.set(k, v);
    for (const [k, v] of this.indexes) s.indexes.set(k, v);
    for (const [k, v] of this.views) s.views.set(k, v);
    for (const [k, v] of this.entries) s.entries.set(k, v);
    s.statsCache = this.statsCache;
    return s;
  }

  // SchemaProvider
  getTable(name: string): TableSchema | undefined {
    const k = lower(name);
    if (k === MASTER_TABLE) return MASTER_SCHEMA;
    return this.tables.get(k)?.schema;
  }
  getView(name: string): ViewSchema | undefined { return this.views.get(lower(name))?.view; }
  getIndex(name: string): IndexSchema | undefined { return this.indexes.get(lower(name))?.schema; }
  listIndexes(table: string): IndexSchema[] { return this.listIndexInfos(table).map((i) => i.schema); }
  tableExists(name: string): boolean { const k = lower(name); return k === MASTER_TABLE || this.tables.has(k) || this.views.has(k); }

  /** Table info, or the synthetic entry for `basalt_master`. */
  table(name: string): TableInfo | undefined {
    const k = lower(name);
    if (k === MASTER_TABLE) return masterInfo(this.masterRoot);
    return this.tables.get(k);
  }
  index(name: string): IndexInfo | undefined { return this.indexes.get(lower(name)); }
  listIndexInfos(table: string): IndexInfo[] {
    const k = lower(table);
    const out: IndexInfo[] = [];
    for (const i of this.indexes.values()) if (lower(i.schema.table) === k) out.push(i);
    return out;
  }

  /** Current root page of a table or index. */
  rootOf(name: string): number {
    const k = lower(name);
    if (k === MASTER_TABLE) return this.masterRoot;
    const t = this.tables.get(k);
    if (t) return t.root;
    const i = this.indexes.get(k);
    if (i) return i.root;
    throw new BasaltError(`no such table or index: ${name}`);
  }

  /** Statistics gathered by ANALYZE, loaded lazily from `basalt_stats`. */
  stats(pager: Pager): Map<string, TableStats> {
    if (this.statsCache) return this.statsCache;
    const out = new Map<string, TableStats>();
    const st = this.tables.get(STATS_TABLE);
    if (st) {
      const tree = new BTree(pager, st.root);
      const c = tree.cursor();
      for (c.seekFirst(); c.valid(); c.next()) {
        const r = decodeRecord(c.value());
        const tbl = lower(String(r[0] ?? "")), colName = r[1];
        const nRows = Number(r[2] ?? 0n);
        let ts = out.get(tbl);
        if (!ts) { ts = { nRows, columns: new Map() }; out.set(tbl, ts); }
        ts.nRows = Math.max(ts.nRows, nRows);
        if (colName === null || colName === undefined) continue;
        const table = this.tables.get(tbl);
        if (!table) continue;
        const ci = table.schema.columns.findIndex((c2) => lower(c2.name) === lower(String(colName)));
        if (ci < 0) continue;
        let histogram: Value[] | undefined;
        const hj = r[7];
        if (typeof hj === "string" && hj.length > 0) {
          try { histogram = (JSON.parse(hj) as unknown[]).map(valueFromJson); } catch { histogram = undefined; }
        }
        ts.columns.set(ci, { nDistinct: Number(r[3] ?? 0n), nullFrac: Number(r[4] ?? 0), min: r[5] ?? null, max: r[6] ?? null, histogram });
      }
    }
    this.statsCache = out;
    return out;
  }

  /** @internal drop cached stats (after ANALYZE). */
  invalidateStats(): void { this.statsCache = null; }
}

function masterInfo(root: number): TableInfo {
  return {
    kind: "table", schema: MASTER_SCHEMA, root, checks: [], checkText: [], padDefaults: MASTER_SCHEMA.columns.map(() => null), internal: true,
    entry: { rowid: 0n, type: "table", name: MASTER_TABLE, tblName: MASTER_TABLE, rootpage: root, sql: null },
  };
}

// ----- building infos from SQL -----

function bindCreateTable(sql: string, provider: SchemaProvider): BoundCreateTable {
  const stmt = parseOne(sql);
  if (stmt.type !== "createTable") throw new BasaltError(`catalog: expected CREATE TABLE, got ${stmt.type}`);
  const bound = bind(stmt, provider, builtinFunctions, { sql });
  if (bound.kind !== "createTable") throw new BasaltError("catalog: internal");
  return bound;
}

function padDefaultsOf(schema: TableSchema): Value[] {
  const empty = new MemorySchemaProvider();
  return schema.columns.map((c) => {
    if (c.defaultSql === undefined) return null;
    try {
      const e = bindExpression(parseExpression(c.defaultSql), empty, builtinFunctions);
      return isConstantExpr(e) ? evaluateConstant(e) : null;
    } catch { return null; }
  });
}

function tableInfoFromEntry(entry: MasterEntry, provider: SchemaProvider): TableInfo {
  if (lower(entry.name) === STATS_TABLE) {
    return { kind: "table", entry, schema: STATS_SCHEMA, root: entry.rootpage, checks: [], checkText: [], padDefaults: STATS_SCHEMA.columns.map(() => null), internal: true };
  }
  if (entry.sql === null) throw new BasaltError(`catalog: table ${entry.name} has no SQL`);
  const bound = bindCreateTable(entry.sql, provider);
  return tableInfoFromBound(entry, bound);
}

function tableInfoFromBound(entry: MasterEntry, bound: BoundCreateTable): TableInfo {
  const schema: TableSchema = { ...bound.table, name: entry.name };
  return {
    kind: "table", entry, schema, root: entry.rootpage, checks: bound.checks, checkText: bound.checks.map(exprToSql),
    padDefaults: padDefaultsOf(schema), internal: false,
  };
}

function indexInfoFromEntry(entry: MasterEntry, provider: SchemaProvider): IndexInfo {
  if (entry.sql === null) throw new BasaltError(`catalog: index ${entry.name} has no SQL`);
  const stmt = parseOne(entry.sql);
  if (stmt.type !== "createIndex") throw new BasaltError(`catalog: expected CREATE INDEX, got ${stmt.type}`);
  const bound = bind(stmt, provider, builtinFunctions, { sql: entry.sql }) as BoundCreateIndex;
  return { kind: "index", entry, schema: { ...bound.index, name: entry.name }, root: entry.rootpage, where: bound.where, auto: isAutoIndex(entry.name) };
}

function viewInfoFromEntry(entry: MasterEntry): ViewInfo {
  if (entry.sql === null) throw new BasaltError(`catalog: view ${entry.name} has no SQL`);
  const stmt = parseOne(entry.sql);
  if (stmt.type !== "createView") throw new BasaltError(`catalog: expected CREATE VIEW, got ${stmt.type}`);
  const selectSql = entry.sql.slice(stmt.select.loc.offset - stmt.loc.offset, stmt.select.loc.end - stmt.loc.offset);
  return { kind: "view", entry, view: { name: entry.name, sql: selectSql, columns: stmt.columns } };
}

/** Rebuilds a schema set by scanning the master tree and binding every stored statement. */
export function loadSchemaSet(pager: Pager, masterRoot: number): SchemaSet {
  const set = new SchemaSet(masterRoot);
  if (masterRoot === 0) return set;
  const tree = new BTree(pager, masterRoot);
  const entries: MasterEntry[] = [];
  const c = tree.cursor();
  for (c.seekFirst(); c.valid(); c.next()) {
    const rowid = decodeKey(c.key())[0];
    const r = decodeRecord(c.value());
    entries.push({
      rowid: typeof rowid === "bigint" ? rowid : BigInt(Number(rowid)), type: String(r[0]) as MasterType, name: String(r[1]), tblName: String(r[2]),
      rootpage: Number(r[3] ?? 0n), sql: r[4] === null || r[4] === undefined ? null : String(r[4]),
    });
  }
  const provider = new MemorySchemaProvider();
  for (const e of entries) set.entries.set(e.rowid, e);
  for (const e of entries) if (e.type === "table") { const info = tableInfoFromEntry(e, provider); set.tables.set(lower(e.name), info); provider.addTable(info.schema); }
  for (const e of entries) if (e.type === "index") { const info = indexInfoFromEntry(e, provider); set.indexes.set(lower(e.name), info); provider.addIndex(info.schema); }
  for (const e of entries) if (e.type === "view") set.views.set(lower(e.name), viewInfoFromEntry(e));
  return set;
}

// ----- SQL text rewriting (ALTER TABLE) -----

/** Replaces identifier tokens equal to `oldName` (case-insensitive) with the quoted `newName`; `skip` tokens are left alone. */
function renameIdents(sql: string, oldName: string, newName: string, filter: (tokIndex: number, prevUpper: string | undefined) => boolean): string {
  const toks = tokenize(sql);
  let out = "", last = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== "ident" || typeof t.value !== "string" || lower(t.value) !== lower(oldName)) continue;
    const prev = toks[i - 1];
    if (!filter(i, prev?.upper)) continue;
    out += sql.slice(last, t.offset) + quoteIdent(newName);
    last = t.end;
  }
  return out + sql.slice(last);
}

/** Rewrites the object name of a CREATE TABLE / CREATE INDEX ... ON statement. */
function renameTableInSql(sql: string, oldName: string, newName: string): string {
  const toks = tokenize(sql);
  // CREATE TABLE [IF NOT EXISTS] <name> | CREATE [UNIQUE] INDEX [IF NOT EXISTS] <idx> ON <name>
  let i = 0;
  const upper = (k: number): string => toks[k]?.upper ?? "";
  if (upper(1) === "TABLE" || upper(1) === "TEMP" || upper(1) === "TEMPORARY") {
    i = upper(1) === "TABLE" ? 2 : 3;
    if (upper(i) === "IF") i += 3;
  } else {
    while (i < toks.length && upper(i) !== "ON") i++;
    i++;
  }
  const t = toks[i];
  if (!t || t.kind !== "ident") return sql;
  return sql.slice(0, t.offset) + quoteIdent(newName) + sql.slice(t.end);
}

/** Appends a column definition to a CREATE TABLE statement (before the closing parenthesis). */
function addColumnToSql(sql: string, columnSql: string): string {
  const toks = tokenize(sql);
  let depth = 0, closeOffset = -1;
  for (const t of toks) {
    if (t.kind !== "punct") continue;
    if (t.text === "(") depth++;
    else if (t.text === ")") { depth--; if (depth === 0) { closeOffset = t.offset; break; } }
  }
  if (closeOffset < 0) throw new BasaltError("cannot add a column to this table definition");
  return `${sql.slice(0, closeOffset)}, ${columnSql}${sql.slice(closeOffset)}`;
}

function columnDefSql(c: ColumnDef): string {
  let s = `${quoteIdent(c.name)} ${c.type}`;
  if (c.notNull) s += " NOT NULL";
  if (c.defaultSql !== undefined) s += ` DEFAULT (${c.defaultSql})`;
  return s;
}

// ----- Catalog -----

export interface CatalogState {
  set: SchemaSet;
  pending: Map<bigint, MasterEntry | null>;
  nextRowid: Map<string, bigint>;
  countCache: Map<string, number>;
  version: number;
}

export class Catalog {
  private readonly cache = new Map<number, SchemaSet>();
  /** Bumped on every committed DDL; prepared statements re-bind when it changes. */
  version = 0;

  constructor(readonly pager: Pager) {}

  /** The committed schema as of `snapshot` (cached per txn id). */
  forSnapshot(snapshot: Snapshot): SchemaSet {
    let set = this.cache.get(snapshot.txnId);
    if (!set) {
      set = loadSchemaSet(this.pager, snapshot.masterRoot);
      this.cache.set(snapshot.txnId, set);
      if (this.cache.size > 8) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) this.cache.delete(oldest); }
    }
    return set;
  }

  /** Starts catalog bookkeeping for a write transaction. */
  beginWrite(txn: WriteTxn): WritableCatalog {
    const base = this.forSnapshot({ txnId: txn.txnId - 1, masterRoot: txn.masterRoot, freelistHead: txn.freelistHead });
    return new WritableCatalog(this, txn, base);
  }

  /** Records the committed schema of a just-committed write transaction. */
  committed(w: WritableCatalog): void {
    if (w.ddlCount > 0) this.version++;
    const set = w.set;
    set.masterRoot = w.txn.masterRoot;
    this.cache.set(w.txn.txnId, set);
    if (this.cache.size > 8) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) this.cache.delete(oldest); }
  }
}

/** Catalog view of one write transaction (see module docs). */
export class WritableCatalog implements SchemaProvider {
  set: SchemaSet;
  private pending = new Map<bigint, MasterEntry | null>();
  private nextRowid = new Map<string, bigint>();
  private countCache = new Map<string, number>();
  /** Number of DDL operations performed in this transaction. */
  ddlCount = 0;
  /** Schema version within the transaction (base version + DDL count). */
  get version(): number { return this.catalog.version * 1000 + this.ddlCount; }

  constructor(readonly catalog: Catalog, readonly txn: WriteTxn, base: SchemaSet) {
    this.set = base.clone();
    this.set.masterRoot = txn.masterRoot;
  }

  private get pager(): Pager { return this.catalog.pager; }

  // SchemaProvider (delegates)
  getTable(name: string): TableSchema | undefined { return this.set.getTable(name); }
  getView(name: string): ViewSchema | undefined { return this.set.getView(name); }
  getIndex(name: string): IndexSchema | undefined { return this.set.getIndex(name); }
  listIndexes(table: string): IndexSchema[] { return this.set.listIndexes(table); }
  tableExists(name: string): boolean { return this.set.tableExists(name); }

  table(name: string): TableInfo | undefined { return this.set.table(name); }
  index(name: string): IndexInfo | undefined { return this.set.index(name); }
  listIndexInfos(table: string): IndexInfo[] { return this.set.listIndexInfos(table); }

  // ----- state for savepoints -----
  saveState(): CatalogState {
    return { set: this.set.clone(), pending: new Map(this.pending), nextRowid: new Map(this.nextRowid), countCache: new Map(this.countCache), version: this.ddlCount };
  }
  restoreState(s: CatalogState): void {
    this.set = s.set.clone();
    this.pending = new Map(s.pending);
    this.nextRowid = new Map(s.nextRowid);
    this.countCache = new Map(s.countCache);
    this.ddlCount = s.version;
  }

  // ----- roots -----
  rootOf(name: string): number { return this.set.rootOf(name); }

  /** Records the new root of a table or index after copy-on-write writes. */
  setRoot(name: string, root: number): void {
    const k = lower(name);
    if (k === MASTER_TABLE) { this.set.masterRoot = root; this.txn.masterRoot = root; return; }
    const t = this.set.tables.get(k);
    if (t) {
      if (t.root === root) return;
      const entry = { ...t.entry, rootpage: root };
      this.replaceTable({ ...t, root, entry });
      this.countCache.delete(k);
      return;
    }
    const i = this.set.indexes.get(k);
    if (i) {
      if (i.root === root) return;
      const entry = { ...i.entry, rootpage: root };
      this.replaceIndex({ ...i, root, entry });
      return;
    }
    throw new BasaltError(`no such table or index: ${name}`);
  }

  /** Marks a table as modified (row count cache invalidation) even when its root did not move. */
  touched(name: string): void { this.countCache.delete(lower(name)); }

  /** Cached `BTree.count()` for the planner. */
  rowCount(name: string): number {
    const k = lower(name);
    let n = this.countCache.get(k);
    if (n === undefined) { n = new BTree(this.pager, this.rootOf(name)).count(); this.countCache.set(k, n); }
    return n;
  }

  // ----- rowids -----
  /** Allocates the next hidden rowid (max + 1) for a table. */
  allocateRowid(table: string): bigint {
    const k = lower(table);
    let next = this.nextRowid.get(k);
    if (next === undefined) {
      const tree = new BTree(this.pager, this.rootOf(table));
      const c = tree.cursor();
      c.seekLast();
      next = c.valid() ? (decodeKey(c.key())[0] as bigint) + 1n : 1n;
    }
    this.nextRowid.set(k, next + 1n);
    return next;
  }
  /** Keeps the counter above explicitly supplied rowids. */
  noteRowid(table: string, rowid: bigint): void {
    const k = lower(table);
    const next = this.nextRowid.get(k);
    if (next !== undefined && rowid >= next) this.nextRowid.set(k, rowid + 1n);
  }

  // ----- DDL -----
  private nextMasterRowid(): bigint {
    let max = 0n;
    for (const r of this.set.entries.keys()) if (r > max) max = r;
    for (const r of this.pending.keys()) if (r > max) max = r;
    return max + 1n;
  }

  private putEntry(entry: MasterEntry): void { this.set.entries.set(entry.rowid, entry); this.pending.set(entry.rowid, entry); }
  private removeEntry(rowid: bigint): void { this.set.entries.delete(rowid); this.pending.set(rowid, null); }
  private replaceTable(info: TableInfo): void { this.set.tables.set(lower(info.schema.name), info); this.putEntry(info.entry); }
  private replaceIndex(info: IndexInfo): void { this.set.indexes.set(lower(info.schema.name), info); this.putEntry(info.entry); }

  private newTree(): number {
    const tree = BTree.create(this.pager, this.txn);
    return tree.root;
  }

  /** Creates a table (and the automatic unique indexes for its UNIQUE / non-rowid PRIMARY KEY constraints). */
  createTable(bound: BoundCreateTable): TableInfo {
    this.ddlCount++;
    const name = bound.table.name;
    const entry: MasterEntry = { rowid: this.nextMasterRowid(), type: "table", name, tblName: name, rootpage: this.newTree(), sql: bound.sql };
    const info = tableInfoFromBound(entry, bound);
    this.replaceTable(info);
    const uniques: number[][] = [];
    if (bound.primaryKey) uniques.push(bound.primaryKey);
    for (const u of bound.uniques) if (!uniques.some((x) => x.length === u.length && x.every((c, i) => c === u[i]))) uniques.push(u);
    uniques.forEach((cols, n) => {
      const idxName = `${AUTOINDEX_PREFIX}${name}_${n + 1}`;
      const sql = `CREATE UNIQUE INDEX ${quoteIdent(idxName)} ON ${quoteIdent(name)}(${cols.map((c) => quoteIdent(info.schema.columns[c]!.name)).join(", ")})`;
      this.createIndex({ name: idxName, table: name, columns: cols, unique: true }, sql, undefined, true);
    });
    return info;
  }

  /** Creates the internal stats table on first ANALYZE. */
  ensureStatsTable(): TableInfo {
    const existing = this.set.tables.get(STATS_TABLE);
    if (existing) return existing;
    this.ddlCount++;
    const entry: MasterEntry = { rowid: this.nextMasterRowid(), type: "table", name: STATS_TABLE, tblName: STATS_TABLE, rootpage: this.newTree(), sql: STATS_SQL };
    const info: TableInfo = { kind: "table", entry, schema: STATS_SCHEMA, root: entry.rootpage, checks: [], checkText: [], padDefaults: STATS_SCHEMA.columns.map(() => null), internal: true };
    this.replaceTable(info);
    return info;
  }

  dropTable(name: string): void {
    const k = lower(name);
    const t = this.set.tables.get(k);
    if (!t) throw new BasaltError(`no such table: ${name}`);
    this.ddlCount++;
    for (const i of this.set.listIndexInfos(name)) this.dropIndex(i.schema.name, false);
    new BTree(this.pager, t.root, this.txn).destroy();
    this.set.tables.delete(k);
    this.removeEntry(t.entry.rowid);
    this.countCache.delete(k);
    this.nextRowid.delete(k);
  }

  /** Creates an (empty) index; the executor backfills it. */
  createIndex(schema: IndexSchema, sql: string, where: BoundExpr | undefined, auto = false): IndexInfo {
    this.ddlCount++;
    const entry: MasterEntry = { rowid: this.nextMasterRowid(), type: "index", name: schema.name, tblName: schema.table, rootpage: this.newTree(), sql };
    const info: IndexInfo = { kind: "index", entry, schema, root: entry.rootpage, where, auto };
    this.replaceIndex(info);
    return info;
  }

  dropIndex(name: string, countDdl = true): void {
    const k = lower(name);
    const i = this.set.indexes.get(k);
    if (!i) throw new BasaltError(`no such index: ${name}`);
    if (countDdl) this.ddlCount++;
    new BTree(this.pager, i.root, this.txn).destroy();
    this.set.indexes.delete(k);
    this.removeEntry(i.entry.rowid);
  }

  createView(name: string, sql: string): ViewInfo {
    this.ddlCount++;
    const entry: MasterEntry = { rowid: this.nextMasterRowid(), type: "view", name, tblName: name, rootpage: 0, sql };
    const info = viewInfoFromEntry(entry);
    this.set.views.set(lower(name), info);
    this.putEntry(entry);
    return info;
  }

  dropView(name: string): void {
    const k = lower(name);
    const v = this.set.views.get(k);
    if (!v) throw new BasaltError(`no such view: ${name}`);
    this.ddlCount++;
    this.set.views.delete(k);
    this.removeEntry(v.entry.rowid);
  }

  /** Rebinds a table (and its indexes) from rewritten SQL text, keeping roots. */
  private rebindTable(oldName: string, tableSql: string, newName: string, indexSqls: Map<string, string>): void {
    const k = lower(oldName);
    const t = this.set.tables.get(k);
    if (!t) throw new BasaltError(`no such table: ${oldName}`);
    const provider = new MemorySchemaProvider();
    const entry: MasterEntry = { ...t.entry, name: newName, tblName: newName, sql: tableSql };
    const bound = bindCreateTable(tableSql, provider);
    const info = tableInfoFromBound(entry, bound);
    provider.addTable(info.schema);
    const indexes = this.set.listIndexInfos(oldName);
    this.set.tables.delete(k);
    this.replaceTable(info);
    if (k !== lower(newName)) { this.countCache.delete(k); const nr = this.nextRowid.get(k); this.nextRowid.delete(k); if (nr !== undefined) this.nextRowid.set(lower(newName), nr); }
    for (const i of indexes) {
      const sql = indexSqls.get(lower(i.schema.name)) ?? i.entry.sql;
      const ie: MasterEntry = { ...i.entry, tblName: newName, sql };
      const ni = indexInfoFromEntry(ie, provider);
      provider.addIndex(ni.schema);
      this.replaceIndex(ni);
    }
  }

  renameTable(oldName: string, newName: string): void {
    const t = this.set.tables.get(lower(oldName));
    if (!t || t.internal) throw new BasaltError(`no such table: ${oldName}`);
    this.ddlCount++;
    const tableSql = renameTableInSql(t.entry.sql!, oldName, newName);
    const idx = new Map<string, string>();
    for (const i of this.set.listIndexInfos(oldName)) if (i.entry.sql) idx.set(lower(i.schema.name), renameTableInSql(i.entry.sql, oldName, newName));
    this.rebindTable(oldName, tableSql, newName, idx);
  }

  addColumn(table: string, column: ColumnDef): void {
    const t = this.set.tables.get(lower(table));
    if (!t || t.internal) throw new BasaltError(`no such table: ${table}`);
    this.ddlCount++;
    const tableSql = addColumnToSql(t.entry.sql!, columnDefSql(column));
    this.rebindTable(table, tableSql, t.schema.name, new Map());
  }

  renameColumn(table: string, columnIndex: number, newName: string): void {
    const t = this.set.tables.get(lower(table));
    if (!t || t.internal) throw new BasaltError(`no such table: ${table}`);
    this.ddlCount++;
    const oldName = t.schema.columns[columnIndex]!.name;
    // skip the table-name token (the identifier right after TABLE / IF NOT EXISTS) when the column shares its name
    const tableSql = renameIdents(t.entry.sql!, oldName, newName, (_i, prevUpper) => prevUpper !== "TABLE" && prevUpper !== "EXISTS");
    const idx = new Map<string, string>();
    for (const i of this.set.listIndexInfos(table)) if (i.entry.sql) idx.set(lower(i.schema.name), renameIdents(i.entry.sql, oldName, newName, (_i, prevUpper) => prevUpper !== "ON" && prevUpper !== "INDEX" && prevUpper !== "EXISTS"));
    this.rebindTable(table, tableSql, t.schema.name, idx);
  }

  /** Marks stats as changed (after ANALYZE wrote `basalt_stats`). */
  statsChanged(): void { this.set.invalidateStats(); }

  // ----- persistence -----
  /** Writes pending master rows into the master tree and publishes the new root on the transaction. */
  flush(): void {
    if (this.pending.size === 0) return;
    let tree: BTree;
    if (this.set.masterRoot === 0) tree = BTree.create(this.pager, this.txn);
    else tree = new BTree(this.pager, this.set.masterRoot, this.txn);
    for (const [rowid, entry] of this.pending) {
      const key = encodeKey([rowid]);
      if (entry === null) tree.delete(key);
      else tree.insert(key, encodeRecord([entry.type, entry.name, entry.tblName, BigInt(entry.rootpage), entry.sql]));
    }
    this.pending.clear();
    this.set.masterRoot = tree.root;
    this.txn.masterRoot = tree.root;
  }
}

/** Decodes a `basalt_stats` histogram column. */
export function histogramFromJson(json: string): Value[] {
  return (JSON.parse(json) as unknown[]).map(valueFromJson);
}

export { valueToJson as statsValueToJson };
