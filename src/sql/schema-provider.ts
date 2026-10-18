/**
 * Read-only view of the catalog consumed by the binder. The engine's `Catalog` implements this;
 * tests use an in-memory implementation.
 */
import type { IndexSchema, TableSchema } from "../core/types.js";

/** A stored view: its name and the `CREATE VIEW` SELECT text (the binder re-parses it). */
export interface ViewSchema {
  name: string;
  /** The SELECT statement text (without the CREATE VIEW prefix). */
  sql: string;
  /** Optional explicit column names from `CREATE VIEW v(a, b)`. */
  columns?: string[];
}

/** Catalog lookups required to bind a statement. All name lookups are case-insensitive. */
export interface SchemaProvider {
  getTable(name: string): TableSchema | undefined;
  getView(name: string): ViewSchema | undefined;
  /** Index lookup by index name (needed for DROP INDEX / duplicate detection). */
  getIndex(name: string): IndexSchema | undefined;
  listIndexes(table: string): IndexSchema[];
  /** True when a table OR a view with this name exists. */
  tableExists(name: string): boolean;
}

/** Simple `SchemaProvider` backed by Maps; handy for tests and for binding against a schema under construction. */
export class MemorySchemaProvider implements SchemaProvider {
  private readonly tables = new Map<string, TableSchema>();
  private readonly views = new Map<string, ViewSchema>();
  private readonly indexes = new Map<string, IndexSchema[]>();

  addTable(table: TableSchema): this { this.tables.set(table.name.toLowerCase(), table); return this; }
  addView(view: ViewSchema): this { this.views.set(view.name.toLowerCase(), view); return this; }
  addIndex(index: IndexSchema): this {
    const key = index.table.toLowerCase();
    const list = this.indexes.get(key) ?? [];
    list.push(index);
    this.indexes.set(key, list);
    return this;
  }
  removeTable(name: string): void { this.tables.delete(name.toLowerCase()); this.indexes.delete(name.toLowerCase()); }
  removeView(name: string): void { this.views.delete(name.toLowerCase()); }

  getTable(name: string): TableSchema | undefined { return this.tables.get(name.toLowerCase()); }
  getView(name: string): ViewSchema | undefined { return this.views.get(name.toLowerCase()); }
  getIndex(name: string): IndexSchema | undefined {
    for (const list of this.indexes.values()) for (const i of list) if (i.name.toLowerCase() === name.toLowerCase()) return i;
    return undefined;
  }
  listIndexes(table: string): IndexSchema[] { return this.indexes.get(table.toLowerCase()) ?? []; }
  tableExists(name: string): boolean { const k = name.toLowerCase(); return this.tables.has(k) || this.views.has(k); }
}
