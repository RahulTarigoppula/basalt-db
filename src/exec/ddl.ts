/**
 * DDL and maintenance operators: CREATE TABLE [AS SELECT], CREATE INDEX (with backfill and uniqueness check),
 * CREATE VIEW, DROP, ALTER TABLE, ANALYZE (row counts, distinct counts, null fractions, min/max and 32-bucket
 * equi-height histograms into `basalt_stats`) and PRAGMA. VACUUM and EXPLAIN are handled by the engine.
 */
import { STATS_TABLE, histogramToJson, isAutoIndex, type TableInfo } from "../catalog/catalog.js";
import { decodeKey, encodeKey, encodeRecord } from "../core/encoding.js";
import { BasaltError, ConstraintError } from "../core/errors.js";
import { compareValues, type Row, type Value } from "../core/types.js";
import { HISTOGRAM_BUCKETS } from "../planner/stats.js";
import type { Layout } from "../planner/layout.js";
import type { BoundAlterTable, BoundCreateIndex, BoundCreateTable, BoundCreateView, BoundDrop, BoundPragma } from "../sql/bound.js";
import type { Operator } from "./context.js";
import { TableWriter } from "./dml.js";
import type { CompiledExpr } from "./expr.js";
import { normalize } from "./functions.js";
import { appendValueKey } from "./hash.js";
import { OpBase } from "./operators/base.js";
import type { Predicate } from "./operators/basic.js";
import { EMPTY_VALUE, decodeTableRow, indexKey, indexPrefix, startsWith } from "./rows.js";

/** An operator that performs its work in `open()` and yields buffered rows. */
abstract class Action extends OpBase {
  protected out: Row[] = [];
  private pos = 0;
  protected onOpen(): void { this.out = []; this.pos = 0; this.run(); }
  protected abstract run(): void;
  next(): Row | null { if (this.pos >= this.out.length) return null; this.stats.rows++; return this.out[this.pos++]!; }
}

export class CreateTable extends Action {
  constructor(layout: Layout, private readonly stmt: BoundCreateTable, private readonly source: Operator | undefined, private readonly checks: Predicate[], private readonly checkExprs: CompiledExpr[]) { super(layout); }
  protected run(): void {
    const shared = this.ctx.shared;
    const w = shared.writable;
    if (this.stmt.exists || w.tableExists(this.stmt.table.name)) {
      if (this.stmt.ifNotExists) return;
      throw new BasaltError(`table ${this.stmt.table.name} already exists`);
    }
    const info = w.createTable(this.stmt);
    if (this.source) {
      const writer = new TableWriter(shared, info, this.checks, new Map(), [], this.ctx);
      writer.setCheckExprs(this.checkExprs);
      const n = info.schema.columns.length;
      this.source.open(this.ctx.child([]));
      try {
        for (let r = this.source.next(); r !== null; r = this.source.next()) {
          const row = new Array<Value>(n + 1);
          for (let i = 0; i < n; i++) row[i] = r[i] ?? null;
          const rowid = writer.resolveRowid(row);
          row[n] = rowid;
          writer.store(row, rowid);
          shared.rowsAffected++;
        }
      } finally { this.source.close(); writer.finish(); }
    }
  }
}

export class CreateIndex extends Action {
  constructor(layout: Layout, private readonly stmt: BoundCreateIndex, private readonly where: Predicate | undefined) { super(layout); }
  protected run(): void {
    const shared = this.ctx.shared;
    const w = shared.writable;
    const name = this.stmt.index.name;
    if (w.index(name) || w.tableExists(name)) {
      if (this.stmt.ifNotExists) return;
      throw new BasaltError(`index ${name} already exists`);
    }
    const table = shared.table(this.stmt.index.table);
    const info = w.createIndex(this.stmt.index, this.stmt.sql, this.stmt.where);
    const tree = shared.writeTree(name);
    const src = shared.readTree(table.schema.name);
    const c = src.cursor();
    const rows: Row[] = [this.rows[0]!];
    const n = table.schema.columns.length;
    for (c.seekFirst(); c.valid(); c.next()) {
      const row = decodeTableRow(table, c.key(), c.value());
      if (this.where) { rows[0] = row; if (!this.where(rows, this.ctx)) continue; }
      const rowid = row[n] as bigint;
      if (info.schema.unique && info.schema.columns.every((col) => row[col] !== null)) {
        const prefix = indexPrefix(info, row);
        const probe = tree.cursor();
        probe.seek(prefix);
        if (probe.valid() && startsWith(probe.key(), prefix)) {
          throw new ConstraintError(`UNIQUE constraint failed: ${info.schema.columns.map((i) => `${table.schema.name}.${table.schema.columns[i]!.name}`).join(", ")}`);
        }
      }
      tree.insert(indexKey(info, row, rowid), EMPTY_VALUE);
    }
    w.setRoot(name, tree.root);
  }
}

export class CreateView extends Action {
  constructor(layout: Layout, private readonly stmt: BoundCreateView) { super(layout); }
  protected run(): void {
    const w = this.ctx.shared.writable;
    if (w.tableExists(this.stmt.name)) { if (this.stmt.ifNotExists) return; throw new BasaltError(`view ${this.stmt.name} already exists`); }
    w.createView(this.stmt.name, this.stmt.sql);
  }
}

export class Drop extends Action {
  constructor(layout: Layout, private readonly stmt: BoundDrop) { super(layout); }
  protected run(): void {
    const w = this.ctx.shared.writable;
    const s = this.stmt;
    switch (s.object) {
      case "TABLE": {
        const t = w.table(s.name);
        if (!t || t.internal) { if (s.ifExists) return; throw new BasaltError(`no such table: ${s.name}`); }
        w.dropTable(s.name);
        return;
      }
      case "INDEX": {
        const i = w.index(s.name);
        if (!i) { if (s.ifExists) return; throw new BasaltError(`no such index: ${s.name}`); }
        if (i.auto || isAutoIndex(s.name)) throw new BasaltError(`index associated with UNIQUE or PRIMARY KEY constraint cannot be dropped`);
        w.dropIndex(s.name);
        return;
      }
      case "VIEW": {
        if (!w.getView(s.name)) { if (s.ifExists) return; throw new BasaltError(`no such view: ${s.name}`); }
        w.dropView(s.name);
        return;
      }
    }
  }
}

export class Alter extends Action {
  constructor(layout: Layout, private readonly stmt: BoundAlterTable) { super(layout); }
  protected run(): void {
    const w = this.ctx.shared.writable;
    const s = this.stmt;
    switch (s.action) {
      case "renameTo": w.renameTable(s.table.name, s.newName); return;
      case "renameColumn": w.renameColumn(s.table.name, s.column, s.newName); return;
      case "addColumn": w.addColumn(s.table.name, s.column); return;
      case "dropColumn": throw new BasaltError("ALTER TABLE DROP COLUMN is not supported");
    }
  }
}

// ----- ANALYZE -----

export class Analyze extends Action {
  constructor(layout: Layout, private readonly target: string | undefined) { super(layout); }
  protected run(): void {
    const shared = this.ctx.shared;
    const w = shared.writable;
    const statsInfo = w.ensureStatsTable();
    const tables: TableInfo[] = [];
    for (const t of w.set.tables.values()) {
      if (t.internal) continue;
      if (this.target && t.schema.name.toLowerCase() !== this.target.toLowerCase()) continue;
      tables.push(t);
    }
    const statsTree = shared.writeTree(STATS_TABLE);
    // drop existing rows of the analysed tables
    const names = new Set(tables.map((t) => t.schema.name.toLowerCase()));
    const toDelete: Uint8Array[] = [];
    const c = statsTree.cursor();
    for (c.seekFirst(); c.valid(); c.next()) {
      const r = decodeTableRow(statsInfo, c.key(), c.value());
      if (names.has(String(r[0]).toLowerCase())) toDelete.push(c.key());
    }
    for (const k of toDelete) statsTree.delete(k);
    for (const t of tables) {
      const rows = this.gather(t);
      for (const r of rows) statsTree.insert(encodeKey([w.allocateRowid(STATS_TABLE)]), encodeRecord(r));
    }
    w.setRoot(STATS_TABLE, statsTree.root);
    w.touched(STATS_TABLE);
    w.statsChanged();
  }

  private gather(t: TableInfo): Row[] {
    const tree = this.ctx.shared.readTree(t.schema.name);
    const n = t.schema.columns.length;
    const values: Value[][] = t.schema.columns.map(() => []);
    const distinct: Set<string>[] = t.schema.columns.map(() => new Set());
    const nulls = new Array<number>(n).fill(0);
    let count = 0;
    const c = tree.cursor();
    for (c.seekFirst(); c.valid(); c.next()) {
      const row = decodeTableRow(t, c.key(), c.value());
      count++;
      for (let i = 0; i < n; i++) {
        const v = row[i] ?? null;
        if (v === null) { nulls[i]!++; continue; }
        const nv = normalize(v);
        values[i]!.push(nv);
        if (distinct[i]!.size < 1_000_000) distinct[i]!.add(appendValueKey(nv));
      }
    }
    const out: Row[] = [];
    for (let i = 0; i < n; i++) {
      const vals = values[i]!;
      vals.sort(compareValues);
      let hist: string | null = null;
      if (vals.length >= 2) {
        const bounds: Value[] = [];
        for (let b = 0; b <= HISTOGRAM_BUCKETS; b++) bounds.push(vals[Math.min(vals.length - 1, Math.floor((b * (vals.length - 1)) / HISTOGRAM_BUCKETS))]!);
        hist = histogramToJson(bounds);
      }
      out.push([t.schema.name, t.schema.columns[i]!.name, BigInt(count), BigInt(distinct[i]!.size), count ? nulls[i]! / count : 0, vals[0] ?? null, vals[vals.length - 1] ?? null, hist]);
    }
    if (n === 0) out.push([t.schema.name, null, BigInt(count), 0n, 0, null, null, null]);
    return out;
  }
}

// ----- PRAGMA -----

export const PRAGMA_COLUMNS: Record<string, { name: string; type: "INTEGER" | "TEXT" }[]> = {
  table_info: [{ name: "cid", type: "INTEGER" }, { name: "name", type: "TEXT" }, { name: "type", type: "TEXT" }, { name: "notnull", type: "INTEGER" }, { name: "dflt_value", type: "TEXT" }, { name: "pk", type: "INTEGER" }],
  index_list: [{ name: "seq", type: "INTEGER" }, { name: "name", type: "TEXT" }, { name: "unique", type: "INTEGER" }, { name: "origin", type: "TEXT" }, { name: "partial", type: "INTEGER" }],
  index_info: [{ name: "seqno", type: "INTEGER" }, { name: "cid", type: "INTEGER" }, { name: "name", type: "TEXT" }],
  table_list: [{ name: "schema", type: "TEXT" }, { name: "name", type: "TEXT" }, { name: "type", type: "TEXT" }, { name: "ncol", type: "INTEGER" }, { name: "wr", type: "INTEGER" }, { name: "strict", type: "INTEGER" }],
};

export class Pragma extends Action {
  constructor(layout: Layout, private readonly stmt: BoundPragma) { super(layout); }
  protected run(): void {
    const shared = this.ctx.shared;
    const schema = shared.storage.schema;
    const name = this.stmt.name.toLowerCase();
    const arg = this.stmt.value === undefined || this.stmt.value === null ? undefined : String(this.stmt.value);
    const pager = shared.storage.pager;
    switch (name) {
      case "table_info": case "table_xinfo": {
        if (!arg) return;
        const t = schema.table(arg);
        if (!t) return;
        t.schema.columns.forEach((c, i) => this.out.push([BigInt(i), c.name, c.type, c.notNull ? 1n : 0n, c.defaultSql ?? null, c.primaryKey ? 1n : 0n]));
        return;
      }
      case "index_list": {
        if (!arg) return;
        schema.listIndexInfos(arg).forEach((ix, i) => this.out.push([BigInt(i), ix.schema.name, ix.schema.unique ? 1n : 0n, ix.auto ? "pk" : "c", ix.where ? 1n : 0n]));
        return;
      }
      case "index_info": case "index_xinfo": {
        if (!arg) return;
        const ix = schema.index(arg);
        if (!ix) return;
        const t = schema.table(ix.schema.table);
        ix.schema.columns.forEach((c, i) => this.out.push([BigInt(i), BigInt(c), t?.schema.columns[c]?.name ?? null]));
        return;
      }
      case "table_list": {
        const set = "set" in schema ? schema.set : schema;
        for (const t of set.tables.values()) this.out.push(["main", t.schema.name, "table", BigInt(t.schema.columns.length), t.schema.rowidColumn < 0 && t.schema.columns.some((c) => c.primaryKey) ? 1n : 0n, 0n]);
        for (const v of set.views.values()) this.out.push(["main", v.view.name, "view", 0n, 0n, 0n]);
        return;
      }
      case "page_count": this.out.push([BigInt(pager.pageCount)]); return;
      case "freelist_count": this.out.push([BigInt(pager.freelist.size)]); return;
      case "page_size": this.out.push([BigInt(pager.backend.pageSize)]); return;
      case "cache_size": this.out.push([BigInt(pager.pool.capacity)]); return;
      case "user_version": case "schema_version": this.out.push([0n]); return;
      case "journal_mode": this.out.push(["cow"]); return;
      case "foreign_keys": this.out.push([0n]); return;
      case "synchronous": this.out.push([2n]); return;
      case "encoding": this.out.push(["UTF-8"]); return;
      default: return; // unknown pragmas are ignored, as in SQLite
    }
  }
}

export function pragmaColumns(name: string): { name: string; type: "INTEGER" | "TEXT" }[] {
  const n = name.toLowerCase();
  const known = PRAGMA_COLUMNS[n];
  if (known) return known;
  if (n === "journal_mode" || n === "encoding") return [{ name: n, type: "TEXT" }];
  return [{ name: n, type: "INTEGER" }];
}

export { decodeKey };
