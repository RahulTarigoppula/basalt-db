/**
 * The `Database` facade: parse, bind, plan and execute SQL against a backend; transactions (auto-commit, explicit
 * BEGIN / COMMIT / ROLLBACK, SAVEPOINT / RELEASE / ROLLBACK TO, statement-level atomicity inside a transaction);
 * EXPLAIN [ANALYZE], ANALYZE, VACUUM, PRAGMA; events; storage introspection.
 *
 * Several `Database` handles may be opened over the same `Backend` object: they share one pager, transaction manager
 * and catalog (a per-backend engine registry) but have independent transaction state, so one handle can hold a read
 * snapshot while another commits (the MVCC tests rely on this).
 *
 * Transactions: a statement outside BEGIN runs in its own read snapshot (read-only statements) or write transaction
 * (committed when it succeeds, rolled back when it throws). `BEGIN` is deferred: the first statement decides whether the
 * transaction is a reader or the writer; a reader is upgraded to the writer on its first write only when nothing was
 * committed meanwhile (otherwise `TransactionError`, snapshot isolation would be violated). `BEGIN IMMEDIATE` takes the
 * writer at once. Inside a transaction every write statement runs under a savepoint so a failing statement leaves the
 * transaction intact.
 */
import { Catalog, type SchemaSet, type WritableCatalog, type CatalogState } from "../catalog/catalog.js";
import { encodeKey, encodeRecord } from "../core/encoding.js";
import { BasaltError, TransactionError } from "../core/errors.js";
import type { QueryResult, ResultColumn, Row, Value } from "../core/types.js";
import { OperatorBuilder } from "../exec/build.js";
import { ExecContext, SharedExec, type Operator, type StorageAccess } from "../exec/context.js";
import { pragmaColumns } from "../exec/ddl.js";
import { builtinFunctions } from "../exec/functions.js";
import { EXPLAIN_COLUMNS, formatPlan, toPlanNode, type NodeStats, type PlanNode } from "../planner/explain.js";
import { Layout } from "../planner/layout.js";
import {
  explainNode, planCreateTable, planDelete, planInsert, planSelect, planUpdate, simpleNode, vacuumNode, type PhysicalNode, type PlanContext,
} from "../planner/physical.js";
import type { StatsSource } from "../planner/stats.js";
import type { Statement as AstStatement } from "../sql/ast.js";
import { bind } from "../sql/binder.js";
import type { BoundStatement } from "../sql/bound.js";
import { parse } from "../sql/parser.js";
import { MemoryBackend, type Backend } from "../storage/backend.js";
import { BTree } from "../storage/btree.js";
import { PAGE_SIZE } from "../storage/page.js";
import { Pager } from "../storage/pager.js";
import { TransactionManager, type SavepointToken, type Snapshot, type WriteTxn } from "../txn/transaction.js";
import { btreeStats, describePage, pageMap, type BTreeStats, type PageDetail, type PageInfo } from "./inspect.js";
import { columnsOfLayout, makeResult } from "./result.js";
import { Statement } from "./statement.js";

export type OpenOptions =
  | { backend: Backend; poolPages?: number }
  | { memory: true; poolPages?: number }
  | { file: string; poolPages?: number }
  | { opfs: string; poolPages?: number };

export interface DatabaseStats { pageCount: number; freePages: number; cacheHits: number; cacheMisses: number; txnId: number }

export type DatabaseEvent = "commit" | "statement";
export interface CommitEvent { txnId: number }
export interface StatementEvent { sql: string; ms: number; rowsAffected: number; rows: number }
type Listener = ((e: CommitEvent) => void) | ((e: StatementEvent) => void);

/** Named or positional parameters. */
export type Params = readonly Value[] | Record<string, Value>;

/** Storage shared by every handle over one backend. */
class Engine {
  pager: Pager;
  tm: TransactionManager;
  catalog: Catalog;
  refs = 0;
  readonly commitListeners = new Set<(e: CommitEvent) => void>();
  constructor(readonly backend: Backend, readonly poolPages: number) {
    this.pager = new Pager(backend, poolPages);
    this.tm = new TransactionManager(this.pager);
    this.catalog = new Catalog(this.pager);
  }
}

const engines = new WeakMap<Backend, Engine>();

interface Session {
  explicit: boolean;
  snapshot: Snapshot | null;
  txn: WriteTxn | null;
  wcat: WritableCatalog | null;
  savepoints: { name: string; token: SavepointToken; state: CatalogState }[];
}

/** A statement prepared for execution: bound once per schema version, planned once. */
export interface Prepared {
  sql: string;
  ast: AstStatement;
  bound: BoundStatement;
  plan: PhysicalNode | null;
  schemaKey: string;
  columns: ResultColumn[];
  shared: SharedExec | null;
  root: Operator | null;
  builder: OperatorBuilder | null;
}

/** Statement classes that modify the database (need the writer). */
function isWriteStatement(ast: AstStatement): boolean {
  switch (ast.type) {
    case "insert": case "update": case "delete": case "createTable": case "createIndex": case "createView": case "drop": case "alterTable": case "analyze": case "vacuum": return true;
    case "explain": return ast.analyze && isWriteStatement(ast.statement);
    default: return false;
  }
}

export class Database {
  private readonly engine: Engine;
  private readonly session: Session = { explicit: false, snapshot: null, txn: null, wcat: null, savepoints: [] };
  private readonly statementListeners = new Set<(e: StatementEvent) => void>();
  private readonly planCache = new Map<string, Prepared>();
  private closed = false;
  /** Seed for `random()`; undefined = nondeterministic. */
  randomSeed: number | undefined;
  /** Sort spill threshold override (rows). */
  sortSpillThreshold: number | undefined;

  private constructor(engine: Engine) { this.engine = engine; engine.refs++; }

  static async open(opts: OpenOptions): Promise<Database> {
    let backend: Backend;
    const poolPages = opts.poolPages ?? 2048;
    if ("backend" in opts) backend = opts.backend;
    else if ("memory" in opts) backend = new MemoryBackend();
    else if ("file" in opts) {
      if (typeof process === "undefined" || !process.versions?.node) throw new BasaltError("file-backed databases need Node");
      const mod = await import("../storage/node-backend.js");
      backend = mod.NodeFileBackend.open(opts.file);
    } else {
      const mod = await import("../storage/opfs-backend.js");
      backend = await mod.OpfsBackend.open(opts.opfs);
    }
    let engine = engines.get(backend);
    if (!engine) { engine = new Engine(backend, poolPages); engines.set(backend, engine); }
    return new Database(engine);
  }

  get backend(): Backend { return this.engine.backend; }
  get inTransaction(): boolean { return this.session.explicit; }

  // ----- public API -----

  /** Runs every statement of `sql`; returns one result per statement. */
  exec(sql: string): QueryResult[] {
    this.assertOpen();
    const out: QueryResult[] = [];
    for (const ast of parse(sql)) out.push(this.runAst(ast, sql.slice(ast.loc.offset, ast.loc.end), []));
    return out;
  }

  /** Runs exactly one statement with parameters (`?`, `?NNN`, `:name`). */
  query(sql: string, params: Params = []): QueryResult {
    this.assertOpen();
    const stmts = parse(sql);
    if (stmts.length !== 1) throw new BasaltError(`query() expects exactly one statement, got ${stmts.length}`);
    return this.runAst(stmts[0]!, sql, params);
  }

  prepare(sql: string): Statement {
    this.assertOpen();
    const stmts = parse(sql);
    if (stmts.length !== 1) throw new BasaltError(`prepare() expects exactly one statement, got ${stmts.length}`);
    return new Statement(this, sql, stmts[0]!);
  }

  /** BEGIN; fn(); COMMIT (ROLLBACK when fn throws). */
  transaction<T>(fn: (db: Database) => T): T {
    this.exec("BEGIN");
    let result: T;
    try { result = fn(this); } catch (e) { if (this.session.explicit) this.exec("ROLLBACK"); throw e; }
    this.exec("COMMIT");
    return result;
  }

  explain(sql: string, analyze = false): PlanNode {
    this.assertOpen();
    const stmts = parse(sql);
    if (stmts.length !== 1) throw new BasaltError(`explain() expects exactly one statement`);
    const inner = stmts[0]!;
    const ast: AstStatement = inner.type === "explain" ? inner : { type: "explain", analyze, queryPlan: false, statement: inner, loc: inner.loc };
    let plan: PlanNode | undefined;
    this.runAst(ast, sql, [], (p) => { plan = p; });
    return plan!;
  }

  stats(): DatabaseStats {
    const s = this.engine.pager.stats();
    return { pageCount: s.pageCount, freePages: s.freePages, cacheHits: s.cacheHits, cacheMisses: s.cacheMisses, txnId: s.txnId };
  }

  on(event: "commit", cb: (e: CommitEvent) => void): void;
  on(event: "statement", cb: (e: StatementEvent) => void): void;
  on(event: DatabaseEvent, cb: Listener): void {
    if (event === "commit") this.engine.commitListeners.add(cb as (e: CommitEvent) => void);
    else this.statementListeners.add(cb as (e: StatementEvent) => void);
  }

  off(event: DatabaseEvent, cb: Listener): void {
    if (event === "commit") this.engine.commitListeners.delete(cb as (e: CommitEvent) => void);
    else this.statementListeners.delete(cb as (e: StatementEvent) => void);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.session.explicit) this.rollbackSession();
    this.closed = true;
    this.engine.refs--;
    if (this.engine.refs === 0) {
      engines.delete(this.engine.backend);
      await this.engine.pager.close();
    }
  }

  // ----- introspection -----

  /** Every page of the file with its type, owner and fill factor. */
  pageMap(): PageInfo[] { return this.withSchema((set) => pageMap(this.engine.pager, set)); }
  describePage(pageId: number): PageDetail { return this.withSchema((set) => describePage(this.engine.pager, set, pageId)); }
  btreeStats(name: string): BTreeStats { return this.withSchema((set) => btreeStats(this.engine.pager, set.rootOf(name))); }
  /** Names of user tables. */
  tables(): string[] { return this.withSchema((set) => [...set.tables.values()].filter((t) => !t.internal).map((t) => t.schema.name)); }
  /** `CREATE` statements of every object (tables, indexes, views). */
  schemaSql(name?: string): string[] {
    return this.withSchema((set) => {
      const out: string[] = [];
      for (const e of set.entries.values()) {
        if (!e.sql) continue;
        if (name !== undefined && e.name.toLowerCase() !== name.toLowerCase() && e.tblName.toLowerCase() !== name.toLowerCase()) continue;
        if (e.name.toLowerCase().startsWith("basalt_")) continue;
        out.push(e.sql);
      }
      return out;
    });
  }

  private withSchema<T>(fn: (set: SchemaSet) => T): T {
    this.assertOpen();
    const s = this.session;
    if (s.wcat) return fn(s.wcat.set);
    if (s.snapshot) return fn(this.engine.catalog.forSnapshot(s.snapshot));
    const snap = this.engine.tm.beginRead();
    try { return fn(this.engine.catalog.forSnapshot(snap)); } finally { this.engine.tm.endRead(snap); }
  }

  // ----- execution core -----

  private assertOpen(): void { if (this.closed) throw new BasaltError("database is closed"); }

  /** @internal used by Statement */
  runAst(ast: AstStatement, sql: string, params: Params, onPlan?: (p: PlanNode) => void, prepared?: Prepared): QueryResult {
    const t0 = performance.now();
    let result: QueryResult;
    switch (ast.type) {
      case "begin": result = this.begin(ast.mode); break;
      case "commit": result = this.commit(); break;
      case "rollback": result = ast.savepoint !== undefined ? this.rollbackTo(ast.savepoint) : this.rollback(); break;
      case "savepoint": result = this.savepoint(ast.name); break;
      case "release": result = this.release(ast.name); break;
      case "vacuum": result = this.vacuum(); break;
      default: result = this.runRegular(ast, sql, params, onPlan, prepared);
    }
    if (this.statementListeners.size) {
      const ev: StatementEvent = { sql, ms: performance.now() - t0, rowsAffected: result.rowsAffected, rows: result.rows.length };
      for (const l of this.statementListeners) l(ev);
    }
    return result;
  }

  private runRegular(ast: AstStatement, sql: string, params: Params, onPlan: ((p: PlanNode) => void) | undefined, prepared: Prepared | undefined): QueryResult {
    const write = isWriteStatement(ast);
    const s = this.session;
    const engine = this.engine;
    // acquire
    let snapshot: Snapshot | null = null, txn: WriteTxn | null = null, wcat: WritableCatalog | null = null;
    let autocommit = false;
    if (s.explicit) {
      if (write && !s.txn) this.upgradeToWriter();
      if (!write && !s.txn && !s.snapshot) s.snapshot = engine.tm.beginRead();
      txn = s.txn; wcat = s.wcat; snapshot = s.snapshot;
    } else {
      autocommit = true;
      if (write) { txn = engine.tm.beginWrite(); wcat = engine.catalog.beginWrite(txn); }
      else snapshot = engine.tm.beginRead();
    }
    const schema: SchemaSet | WritableCatalog = wcat ?? engine.catalog.forSnapshot(snapshot!);
    let sp: { token: SavepointToken; state: CatalogState } | null = null;
    try {
      if (txn && wcat && !autocommit) { wcat.flush(); sp = { token: txn.savepoint(), state: wcat.saveState() }; }
      const result = this.execute(ast, sql, params, schema, txn, onPlan, prepared);
      if (autocommit) {
        if (txn && wcat) { this.commitWrite(txn, wcat); } else if (snapshot) engine.tm.endRead(snapshot);
      } else if (sp && txn) txn.release(sp.token);
      return result;
    } catch (e) {
      if (autocommit) {
        if (txn) { engine.tm.rollback(txn); } else if (snapshot) engine.tm.endRead(snapshot);
      } else if (sp && txn && wcat && txn.state === "active") {
        txn.rollbackTo(sp.token);
        wcat.restoreState(sp.state);
        txn.release(sp.token);
      }
      throw e;
    }
  }

  private schemaKey(schema: SchemaSet | WritableCatalog): string {
    const v = this.engine.catalog.version;
    return "txn" in schema ? `${v}:${schema.ddlCount}:w` : `${v}:r`;
  }

  /** Binds, plans and runs one statement under an already acquired transaction. */
  private execute(ast: AstStatement, sql: string, params: Params, schema: SchemaSet | WritableCatalog, txn: WriteTxn | null, onPlan: ((p: PlanNode) => void) | undefined, prepared: Prepared | undefined): QueryResult {
    const key = this.schemaKey(schema);
    let p = prepared ?? this.planCache.get(sql);
    if (!p || p.schemaKey !== key) {
      const bound = bind(ast, schema, builtinFunctions, { sql });
      p = { sql, ast, bound, plan: null, schemaKey: key, columns: [], shared: null, root: null, builder: null };
      if (prepared) Object.assign(prepared, p); else this.cachePlan(sql, p);
    }
    const bound = p.bound;
    const paramValues = this.bindParams(bound, params);
    const storage: StorageAccess = { pager: this.engine.pager, txn: txn ?? undefined, schema, rootOf: (name) => schema.rootOf(name) };
    const planCtx: PlanContext = { schema, stats: this.statsSource(schema), cteCache: new Map() };
    if (bound.kind === "explain") return this.runExplain(bound, storage, planCtx, paramValues, onPlan);
    if (!p.plan) {
      p.plan = this.planStatement(bound, planCtx);
      p.columns = this.columnsFor(bound, p.plan);
      p.shared = new SharedExec(storage, paramValues, this.randomSeed);
      p.builder = new OperatorBuilder(p.shared, planCtx, false, this.sortSpillThreshold);
      p.root = p.builder.build(p.plan, []);
    } else {
      p.shared!.resetForExecution(paramValues);
    }
    const shared = p.shared!;
    shared.storage = storage;
    const rows = this.runOperator(p.root!, shared);
    return makeResult(p.columns, rows, shared.rowsAffected, shared.lastRowid);
  }

  private cachePlan(sql: string, p: Prepared): void {
    if (this.planCache.size >= 256) { const k = this.planCache.keys().next().value; if (k !== undefined) this.planCache.delete(k); }
    this.planCache.set(sql, p);
  }

  private runOperator(root: Operator, shared: SharedExec): Row[] {
    const ctx = new ExecContext(shared, []);
    const rows: Row[] = [];
    root.open(ctx);
    try { for (let r = root.next(); r !== null; r = root.next()) rows.push(r); } finally { root.close(); }
    return rows;
  }

  private statsSource(schema: SchemaSet | WritableCatalog): StatsSource {
    const pager = this.engine.pager;
    const counts = new Map<string, number>();
    return {
      tableStats: (name) => ("txn" in schema ? schema.set : schema).stats(pager).get(name.toLowerCase()),
      rowCount: (name) => {
        if ("txn" in schema) return schema.rowCount(name);
        const k = name.toLowerCase();
        let n = counts.get(k);
        if (n === undefined) { n = new BTree(pager, schema.rootOf(name)).count(); counts.set(k, n); }
        return n;
      },
    };
  }

  private planStatement(bound: BoundStatement, ctx: PlanContext): PhysicalNode {
    switch (bound.kind) {
      case "select": return planSelect(bound.select, ctx);
      case "insert": return planInsert(bound, ctx);
      case "update": return planUpdate(bound, ctx);
      case "delete": return planDelete(bound, ctx);
      case "createTable": return planCreateTable(bound, ctx);
      case "createIndex": return simpleNode("createindex", bound);
      case "createView": return simpleNode("createview", bound);
      case "drop": return simpleNode("drop", bound);
      case "alterTable": return simpleNode("alter", bound);
      case "analyze": return simpleNode("analyze", bound);
      case "pragma": return simpleNode("pragma", bound);
      case "vacuum": return vacuumNode();
      case "explain": return explainNode(this.planStatement(bound.statement, ctx), bound.analyze);
      default: throw new BasaltError(`internal: ${bound.kind} is not a plannable statement`);
    }
  }

  private columnsFor(bound: BoundStatement, plan: PhysicalNode): ResultColumn[] {
    switch (bound.kind) {
      case "select": return bound.select.columns.map((c) => ({ name: c.name, type: c.type }));
      case "insert": case "update": case "delete": return bound.returning ? columnsOfLayout(plan.layout) : [];
      case "pragma": return pragmaColumns(bound.name);
      default: return [];
    }
  }

  private runExplain(bound: Extract<BoundStatement, { kind: "explain" }>, storage: StorageAccess, planCtx: PlanContext, params: readonly Value[], onPlan?: (p: PlanNode) => void): QueryResult {
    const inner = bound.statement;
    if (inner.kind === "vacuum" || inner.kind === "begin" || inner.kind === "commit" || inner.kind === "rollback" || inner.kind === "savepoint" || inner.kind === "release") {
      throw new BasaltError(`cannot EXPLAIN ${inner.kind.toUpperCase()}`);
    }
    const plan = this.planStatement(inner, planCtx);
    let statsFor: ((n: PhysicalNode) => NodeStats | undefined) | undefined;
    if (bound.analyze) {
      const shared = new SharedExec(storage, params, this.randomSeed);
      const builder = new OperatorBuilder(shared, planCtx, true, this.sortSpillThreshold);
      const root = builder.build(plan, []);
      this.runOperator(root, shared);
      statsFor = (n) => { const op = builder.built.get(n); return op ? { rows: op.stats.rows, loops: op.stats.loops, ms: op.stats.ms } : undefined; };
    }
    const node = toPlanNode(plan, statsFor);
    onPlan?.(node);
    return makeResult(EXPLAIN_COLUMNS, formatPlan(node).map((l) => [l]));
  }

  private bindParams(bound: BoundStatement, params: Params): Value[] {
    const info = bound.parameters;
    const out: Value[] = new Array<Value>(info.count).fill(null);
    if (Array.isArray(params)) {
      for (let i = 0; i < info.count; i++) out[i] = (params as readonly Value[])[i] ?? null;
      return out;
    }
    const rec = params as Record<string, Value>;
    for (let i = 0; i < info.count; i++) {
      const name = info.names[i];
      if (name === undefined) { const v = rec[String(i + 1)]; out[i] = v === undefined ? null : v; continue; }
      const v = rec[name] ?? rec[name.slice(1)] ?? rec[`:${name}`];
      out[i] = v === undefined ? null : v;
    }
    return out;
  }

  // ----- transactions -----

  private begin(mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE" | undefined): QueryResult {
    const s = this.session;
    if (s.explicit) throw new TransactionError("cannot start a transaction within a transaction");
    s.explicit = true;
    s.savepoints = [];
    if (mode === "IMMEDIATE" || mode === "EXCLUSIVE") {
      s.txn = this.engine.tm.beginWrite();
      s.wcat = this.engine.catalog.beginWrite(s.txn);
    }
    return makeResult([], []);
  }

  private upgradeToWriter(): void {
    const s = this.session;
    const engine = this.engine;
    if (engine.tm.activeWriter) throw new TransactionError("database is locked: another connection holds the write transaction");
    if (s.snapshot && engine.tm.committed.txnId !== s.snapshot.txnId) throw new TransactionError("cannot upgrade to a write transaction: the database changed since this transaction's snapshot (retry)");
    s.txn = engine.tm.beginWrite();
    s.wcat = engine.catalog.beginWrite(s.txn);
    if (s.snapshot) { engine.tm.endRead(s.snapshot); s.snapshot = null; }
    // savepoints opened while reading become real savepoints now
    s.savepoints = s.savepoints.map((sp) => ({ name: sp.name, token: s.txn!.savepoint(), state: s.wcat!.saveState() }));
  }

  private commitWrite(txn: WriteTxn, wcat: WritableCatalog): void {
    wcat.flush();
    this.engine.tm.commit(txn);
    this.engine.catalog.committed(wcat);
    if (wcat.ddlCount > 0) this.planCache.clear();
    for (const l of this.engine.commitListeners) l({ txnId: txn.txnId });
  }

  private commit(): QueryResult {
    const s = this.session;
    if (!s.explicit) throw new TransactionError("cannot commit: no transaction is active");
    try {
      if (s.txn && s.wcat) this.commitWrite(s.txn, s.wcat);
      else if (s.snapshot) this.engine.tm.endRead(s.snapshot);
    } finally { this.resetSession(); }
    return makeResult([], []);
  }

  private rollback(): QueryResult {
    if (!this.session.explicit) throw new TransactionError("cannot rollback: no transaction is active");
    this.rollbackSession();
    return makeResult([], []);
  }

  private rollbackSession(): void {
    const s = this.session;
    try {
      if (s.txn && s.txn.state === "active") this.engine.tm.rollback(s.txn);
      else if (s.snapshot) this.engine.tm.endRead(s.snapshot);
    } finally { this.resetSession(); }
  }

  private resetSession(): void {
    const s = this.session;
    s.explicit = false; s.txn = null; s.wcat = null; s.snapshot = null; s.savepoints = [];
    this.startedBySavepoint = false;
  }

  private savepoint(name: string): QueryResult {
    const s = this.session;
    if (!s.explicit) {
      // SAVEPOINT outside a transaction starts one (SQLite semantics); releasing it commits
      this.begin(undefined);
      this.startedBySavepoint = true;
    }
    if (s.txn && s.wcat) { s.wcat.flush(); s.savepoints.push({ name, token: s.txn.savepoint(), state: s.wcat.saveState() }); }
    else s.savepoints.push({ name, token: { epoch: -1, masterRoot: 0, freedLogLength: 0, pageCount: 0 }, state: undefined as unknown as CatalogState });
    return makeResult([], []);
  }

  private findSavepoint(name: string): number {
    const sps = this.session.savepoints;
    for (let i = sps.length - 1; i >= 0; i--) if (sps[i]!.name.toLowerCase() === name.toLowerCase()) return i;
    throw new TransactionError(`no such savepoint: ${name}`);
  }

  private release(name: string): QueryResult {
    const s = this.session;
    if (!s.explicit) throw new TransactionError(`no such savepoint: ${name}`);
    const i = this.findSavepoint(name);
    const sp = s.savepoints[i]!;
    if (s.txn && sp.token.epoch >= 0) s.txn.release(sp.token);
    s.savepoints.length = i;
    if (s.savepoints.length === 0 && this.startedBySavepoint) { this.startedBySavepoint = false; this.commit(); }
    return makeResult([], []);
  }
  private startedBySavepoint = false;

  /** @internal binds and plans a prepared statement without executing it (for `Statement.columns`). */
  describe(prepared: Prepared): void {
    const s = this.session;
    const engine = this.engine;
    let snap: Snapshot | null = null;
    let schema: SchemaSet | WritableCatalog;
    if (s.wcat) schema = s.wcat;
    else if (s.snapshot) schema = engine.catalog.forSnapshot(s.snapshot);
    else { snap = engine.tm.beginRead(); schema = engine.catalog.forSnapshot(snap); }
    try {
      const bound = bind(prepared.ast, schema, builtinFunctions, { sql: prepared.sql });
      prepared.bound = bound;
      prepared.schemaKey = "";
      const planCtx: PlanContext = { schema, stats: this.statsSource(schema), cteCache: new Map() };
      const plan = bound.kind === "explain" ? explainNode(this.planStatement(bound.statement, planCtx), bound.analyze) : this.planStatement(bound, planCtx);
      prepared.columns = bound.kind === "explain" ? EXPLAIN_COLUMNS : this.columnsFor(bound, plan);
    } finally {
      if (snap) engine.tm.endRead(snap);
    }
  }

  private rollbackTo(name: string): QueryResult {
    const s = this.session;
    if (!s.explicit) throw new TransactionError(`no such savepoint: ${name}`);
    const i = this.findSavepoint(name);
    const sp = s.savepoints[i]!;
    if (s.txn && s.wcat && sp.token.epoch >= 0) {
      s.txn.rollbackTo(sp.token);
      s.wcat.restoreState(sp.state);
    }
    s.savepoints.length = i + 1; // the savepoint itself stays open
    return makeResult([], []);
  }

  // ----- VACUUM -----

  /**
   * Rewrites the whole file compactly: every table/index tree is copied into a fresh in-memory image, which then
   * replaces the backend's contents page by page. Not crash-safe while the pages are being written (documented).
   */
  private vacuum(): QueryResult {
    const s = this.session;
    if (s.explicit) throw new TransactionError("cannot VACUUM from within a transaction");
    const engine = this.engine;
    if (engine.tm.activeWriter || engine.tm.readerCount > 0) throw new TransactionError("cannot VACUUM while other transactions are active");
    const snap = engine.tm.beginRead();
    const image = new MemoryBackend();
    try {
      const set = engine.catalog.forSnapshot(snap);
      const pager2 = new Pager(image, 256);
      const tm2 = new TransactionManager(pager2);
      const txn2 = tm2.beginWrite();
      if (set.masterRoot !== 0) {
        const master = BTree.create(pager2, txn2);
        const entries = [...set.entries.values()].sort((a, b) => (a.rowid < b.rowid ? -1 : a.rowid > b.rowid ? 1 : 0));
        for (const e of entries) {
          let root = 0;
          if (e.type !== "view" && e.rootpage >= 2) {
            const src = new BTree(engine.pager, e.rootpage);
            const dst = BTree.create(pager2, txn2);
            const c = src.cursor();
            for (c.seekFirst(); c.valid(); c.next()) dst.insert(c.key(), c.value());
            root = dst.root;
          }
          master.insert(encodeKey([e.rowid]), encodeRecord([e.type, e.name, e.tblName, BigInt(root), e.sql]));
        }
        txn2.masterRoot = master.root;
      }
      tm2.commit(txn2);
    } finally { engine.tm.endRead(snap); }
    // swap the image into the live backend
    const bytes = image.toBytes();
    const pages = bytes.length / PAGE_SIZE;
    const backend = engine.backend;
    engine.pager.pool.clear();
    backend.extendSync(pages);
    for (let p = 2; p < pages; p++) backend.writeSync(p, bytes.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE));
    backend.writeSync(0, bytes.subarray(0, PAGE_SIZE));
    backend.writeSync(1, bytes.subarray(PAGE_SIZE, 2 * PAGE_SIZE));
    backend.syncSync();
    const version = engine.catalog.version + 1;
    engine.pager = new Pager(backend, engine.poolPages);
    engine.tm = new TransactionManager(engine.pager);
    engine.catalog = new Catalog(engine.pager);
    engine.catalog.version = version;
    this.planCache.clear();
    for (const l of engine.commitListeners) l({ txnId: engine.pager.readMeta().txnId });
    return makeResult([], []);
  }
}

export { Layout };
