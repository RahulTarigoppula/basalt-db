/**
 * INSERT / UPDATE / DELETE with constraint enforcement (NOT NULL, CHECK, PRIMARY KEY / UNIQUE through the automatic and
 * user indexes), OR REPLACE / OR IGNORE, ON CONFLICT DO NOTHING / DO UPDATE, RETURNING and index maintenance.
 *
 * UPDATE and DELETE materialise their target rows before touching the tree they scanned (Halloween problem; the B+tree
 * cursor rule in `storage/btree.ts`). All writes go through `TableWriter`, which publishes the moved roots to the
 * catalog when the statement finishes.
 */
import type { IndexInfo, TableInfo } from "../catalog/catalog.js";
import { KeyReader } from "../core/encoding.js";
import { BasaltError, ConstraintError } from "../core/errors.js";
import type { Row, Value } from "../core/types.js";
import { Layout, columnKey, rowidKey } from "../planner/layout.js";
import type { ConflictAction } from "../sql/ast.js";
import type { BoundInsert, BoundUpdate, BoundUpsert } from "../sql/bound.js";
import type { BTree } from "../storage/btree.js";
import { EMPTY_ROW, type ExecContext, type Operator, type SharedExec } from "./context.js";
import type { CompiledExpr } from "./expr.js";
import { normalize } from "./functions.js";
import { OpBase } from "./operators/base.js";
import type { Predicate } from "./operators/basic.js";
import { EMPTY_VALUE, decodeTableRow, encodeTableRow, indexKey, indexPrefix, rowidKeyBytes, startsWith } from "./rows.js";

interface IndexState { info: IndexInfo; tree: BTree; where?: Predicate }

/** Layout of a full table row (columns then rowid) as relation `rel`. */
export function tableLayout(table: TableInfo, rel: number): Layout {
  return Layout.relation(rel, table.schema.columns.map((c) => ({ name: c.name, type: c.type, hidden: false })), true);
}

/** Writes rows of one table and maintains its indexes and constraints. */
export class TableWriter {
  readonly tree: BTree;
  readonly indexes: IndexState[];
  private readonly n: number;
  private readonly rowsBuf: Row[];

  constructor(private readonly shared: SharedExec, readonly table: TableInfo, private readonly checks: Predicate[], indexWhere: Map<string, Predicate>, outerRows: Row[], private readonly ctx: ExecContext) {
    this.tree = shared.writeTree(table.schema.name);
    this.indexes = shared.writable.listIndexInfos(table.schema.name).map((info) => ({ info, tree: shared.writeTree(info.schema.name), where: indexWhere.get(info.schema.name.toLowerCase()) }));
    this.n = table.schema.columns.length;
    this.rowsBuf = [EMPTY_ROW, ...outerRows];
  }

  private pred(p: Predicate, row: Row): boolean { this.rowsBuf[0] = row; return p(this.rowsBuf, this.ctx); }

  /** Resolves the rowid of a candidate row (allocating when needed); writes it into the INTEGER PRIMARY KEY column. */
  resolveRowid(row: Row): bigint {
    const t = this.table;
    if (t.schema.rowidColumn >= 0) {
      const v = row[t.schema.rowidColumn];
      if (v === null || v === undefined) {
        const id = this.shared.writable.allocateRowid(t.schema.name);
        row[t.schema.rowidColumn] = id;
        return id;
      }
      const n = normalize(v);
      let id: bigint;
      if (typeof n === "bigint") id = n;
      else if (typeof n === "number" && Number.isInteger(n) && Math.abs(n) < 9007199254740992) id = BigInt(n);
      else throw new BasaltError("datatype mismatch", "MISMATCH");
      row[t.schema.rowidColumn] = id;
      this.shared.writable.noteRowid(t.schema.name, id);
      return id;
    }
    return this.shared.writable.allocateRowid(t.schema.name);
  }

  /** NOT NULL and CHECK constraints. Returns the violated constraint message, or undefined. */
  violation(row: Row): { kind: "notnull" | "check"; message: string; column?: number } | undefined {
    const cols = this.table.schema.columns;
    for (let i = 0; i < this.n; i++) {
      if (cols[i]!.notNull && (row[i] === null || row[i] === undefined)) return { kind: "notnull", message: `NOT NULL constraint failed: ${this.table.schema.name}.${cols[i]!.name}`, column: i };
    }
    for (let i = 0; i < this.checks.length; i++) {
      // a CHECK passes when it is true or NULL
      this.rowsBuf[0] = row;
      const ok = this.checks[i]!(this.rowsBuf, this.ctx);
      if (!ok && !this.checkIsNull(i, row)) return { kind: "check", message: `CHECK constraint failed: ${this.table.checkText[i] ?? "check"}` };
    }
    return undefined;
  }
  private checkExprs: CompiledExpr[] = [];
  setCheckExprs(e: CompiledExpr[]): void { this.checkExprs = e; }
  private checkIsNull(i: number, row: Row): boolean {
    const f = this.checkExprs[i];
    if (!f) return false;
    this.rowsBuf[0] = row;
    return f(this.rowsBuf, this.ctx) === null;
  }

  rowExists(rowid: bigint): boolean { return this.tree.get(rowidKeyBytes(rowid)) !== null; }

  /** Rowid of an existing row that conflicts with `row` on `index` (NULL index values never conflict). */
  uniqueConflict(index: IndexState, row: Row, excludeRowid: bigint | null): bigint | undefined {
    if (!index.info.schema.unique) return undefined;
    for (const c of index.info.schema.columns) if (row[c] === null || row[c] === undefined) return undefined;
    if (index.where && !this.pred(index.where, row)) return undefined;
    const prefix = indexPrefix(index.info, row);
    const c = index.tree.cursor();
    c.seek(prefix);
    while (c.valid()) {
      const key = c.key();
      if (!startsWith(key, prefix)) break;
      const r = new KeyReader(key, prefix.length).next();
      const rowid = typeof r === "bigint" ? r : BigInt(Number(r));
      if (excludeRowid === null || rowid !== excludeRowid) return rowid;
      c.next();
    }
    return undefined;
  }

  /** All conflicts of a candidate row: the rowid itself and every unique index. */
  conflicts(row: Row, rowid: bigint, excludeRowid: bigint | null): { index: IndexState | null; rowid: bigint }[] {
    const out: { index: IndexState | null; rowid: bigint }[] = [];
    if ((excludeRowid === null || rowid !== excludeRowid) && this.rowExists(rowid)) out.push({ index: null, rowid });
    for (const ix of this.indexes) {
      const r = this.uniqueConflict(ix, row, excludeRowid);
      if (r !== undefined && !out.some((o) => o.rowid === r)) out.push({ index: ix, rowid: r });
    }
    return out;
  }

  uniqueMessage(c: { index: IndexState | null; rowid: bigint }): string {
    const t = this.table.schema;
    if (!c.index) return `UNIQUE constraint failed: ${t.name}.${t.rowidColumn >= 0 ? t.columns[t.rowidColumn]!.name : "rowid"}`;
    return `UNIQUE constraint failed: ${c.index.info.schema.columns.map((i) => `${t.name}.${t.columns[i]!.name}`).join(", ")}`;
  }

  /** Reads a full row (columns + rowid) by rowid. */
  read(rowid: bigint): Row | null {
    const key = rowidKeyBytes(rowid);
    const v = this.tree.get(key);
    if (v === null) return null;
    return decodeTableRow(this.table, key, v);
  }

  /** Physically inserts a row that passed every check. */
  store(row: Row, rowid: bigint): void {
    this.tree.insert(rowidKeyBytes(rowid), encodeTableRow(this.table, row));
    for (const ix of this.indexes) {
      if (ix.where && !this.pred(ix.where, row)) continue;
      ix.tree.insert(indexKey(ix.info, row, rowid), EMPTY_VALUE);
    }
  }

  /** Physically deletes a row (the old row is needed for its index keys). */
  erase(row: Row, rowid: bigint): void {
    this.tree.delete(rowidKeyBytes(rowid));
    for (const ix of this.indexes) {
      if (ix.where && !this.pred(ix.where, row)) continue;
      ix.tree.delete(indexKey(ix.info, row, rowid));
    }
  }

  /** Replaces a row in place (same rowid): only indexes whose keys changed are touched. */
  replace(oldRow: Row, newRow: Row, rowid: bigint): void {
    this.tree.insert(rowidKeyBytes(rowid), encodeTableRow(this.table, newRow));
    for (const ix of this.indexes) {
      const oldIn = !ix.where || this.pred(ix.where, oldRow);
      const newIn = !ix.where || this.pred(ix.where, newRow);
      const oldKey = oldIn ? indexKey(ix.info, oldRow, rowid) : null;
      const newKey = newIn ? indexKey(ix.info, newRow, rowid) : null;
      if (oldKey && newKey && sameBytes(oldKey, newKey)) continue;
      if (oldKey) ix.tree.delete(oldKey);
      if (newKey) ix.tree.insert(newKey, EMPTY_VALUE);
    }
  }

  /** Publishes moved roots to the catalog. */
  finish(): void {
    const w = this.shared.writable;
    w.setRoot(this.table.schema.name, this.tree.root);
    w.touched(this.table.schema.name);
    for (const ix of this.indexes) w.setRoot(ix.info.schema.name, ix.tree.root);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ----- INSERT -----

export interface InsertPlan {
  stmt: BoundInsert;
  table: TableInfo;
  source: Operator | undefined;
  /** Default per column, compiled against no rows. */
  defaults: (CompiledExpr | null)[];
  checks: Predicate[];
  checkExprs: CompiledExpr[];
  indexWhere: Map<string, Predicate>;
  /** Upsert SET expressions evaluated against [existing..., excluded...] (two table relations in one row). */
  upsertSet?: { column: number; expr: CompiledExpr }[];
  upsertWhere?: Predicate;
  returning?: CompiledExpr[];
}

export class Insert extends OpBase {
  private out: Row[] = [];
  private pos = 0;

  constructor(layout: Layout, private readonly plan: InsertPlan) { super(layout); }

  protected onOpen(): void {
    this.out = []; this.pos = 0;
    const p = this.plan, t = p.table, n = t.schema.columns.length;
    const shared = this.ctx.shared;
    const w = new TableWriter(shared, t, p.checks, p.indexWhere, this.ctx.outerRows, this.ctx);
    w.setCheckExprs(p.checkExprs);
    this.rows[0] = EMPTY_ROW;
    const defaults = p.defaults.map((d) => (d ? d(this.rows, this.ctx) : null));
    const cols = p.stmt.columns;
    const or: ConflictAction = p.stmt.or ?? "ABORT";
    const upsert = p.stmt.upsert;
    const upsertTarget = upsert ? this.resolveUpsertTarget(w, upsert) : undefined;
    const emit = (row: Row): void => { this.rows[0] = row; this.out.push(p.returning!.map((f) => f(this.rows, this.ctx))); };

    const processSource = (src: Row | null): void => {
      const row = new Array<Value>(n + 1);
      for (let i = 0; i < n; i++) row[i] = defaults[i]!;
      if (src) for (let i = 0; i < cols.length; i++) row[cols[i]!] = src[i] ?? null;
      const rowid = w.resolveRowid(row);
      row[n] = rowid;
      // NOT NULL / CHECK
      const v = w.violation(row);
      if (v) {
        if (or === "IGNORE") return;
        if (or === "REPLACE" && v.kind === "notnull" && v.column !== undefined && t.schema.columns[v.column]!.defaultSql !== undefined && defaults[v.column] !== null) {
          row[v.column] = defaults[v.column]!;
          const v2 = w.violation(row);
          if (v2) throw new ConstraintError(v2.message);
        } else throw new ConstraintError(v.message);
      }
      // uniqueness
      const conflicts = w.conflicts(row, rowid, null);
      if (conflicts.length) {
        if (upsert && upsertTarget) {
          const hit = conflicts.find((c) => upsertTarget.matches(c));
          if (hit) {
            if (!p.upsertSet) return; // DO NOTHING
            this.doUpdate(w, hit.rowid, row);
            return;
          }
          // a conflict on another constraint: ordinary error
          throw new ConstraintError(w.uniqueMessage(conflicts[0]!));
        }
        if (or === "IGNORE") return;
        if (or === "REPLACE") {
          for (const c of conflicts) { const old = w.read(c.rowid); if (old) w.erase(old, c.rowid); }
        } else throw new ConstraintError(w.uniqueMessage(conflicts[0]!));
      }
      w.store(row, rowid);
      shared.rowsAffected++;
      shared.lastRowid = rowid;
      if (p.returning) emit(row);
    };

    try {
      if (!p.source) processSource(null);
      else {
        p.source.open(this.ctx);
        try { for (let r = p.source.next(); r !== null; r = p.source.next()) processSource(r); } finally { p.source.close(); }
      }
    } finally { w.finish(); }
  }

  private resolveUpsertTarget(w: TableWriter, u: BoundUpsert): { matches(c: { index: IndexState | null; rowid: bigint }): boolean } {
    const t = this.plan.table.schema;
    if (u.target.length === 0) return { matches: () => true };
    const want = [...u.target].sort((a, b) => a - b).join(",");
    const isRowid = u.target.length === 1 && u.target[0] === t.rowidColumn;
    const matching = w.indexes.filter((ix) => ix.info.schema.unique && [...ix.info.schema.columns].sort((a, b) => a - b).join(",") === want);
    if (!isRowid && matching.length === 0) throw new BasaltError("ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint");
    return { matches: (c) => (c.index === null ? isRowid : matching.includes(c.index)) };
  }

  /** ON CONFLICT DO UPDATE: `existing` is the stored row, `excluded` the rejected candidate. */
  private doUpdate(w: TableWriter, existingRowid: bigint, excluded: Row): void {
    const p = this.plan, t = p.table, n = t.schema.columns.length;
    const existing = w.read(existingRowid);
    if (!existing) return;
    const both = existing.concat(excluded);
    this.rows[0] = both;
    if (p.upsertWhere && !p.upsertWhere(this.rows, this.ctx)) return;
    const newRow = existing.slice();
    for (const a of p.upsertSet!) newRow[a.column] = a.expr(this.rows, this.ctx);
    applyUpdate(w, this.ctx.shared, existing, newRow, existingRowid, "ABORT", n);
    if (p.returning) { this.rows[0] = newRow; this.out.push(p.returning.map((f) => f(this.rows, this.ctx))); }
  }

  next(): Row | null { if (this.pos >= this.out.length) return null; this.stats.rows++; return this.out[this.pos++]!; }
  protected override onClose(): void { this.out = []; }
}

/** Shared by UPDATE and upsert: validates and writes `newRow` over `oldRow`. Returns false when skipped (OR IGNORE). */
function applyUpdate(w: TableWriter, shared: SharedExec, oldRow: Row, newRow: Row, oldRowid: bigint, or: ConflictAction, n: number): boolean {
  const t = w.table;
  let newRowid = oldRowid;
  if (t.schema.rowidColumn >= 0) {
    const v = newRow[t.schema.rowidColumn];
    if (v === null || v === undefined) throw new BasaltError("datatype mismatch", "MISMATCH");
    newRowid = w.resolveRowid(newRow);
  }
  newRow[n] = newRowid;
  const viol = w.violation(newRow);
  if (viol) { if (or === "IGNORE") return false; throw new ConstraintError(viol.message); }
  const conflicts = w.conflicts(newRow, newRowid, oldRowid);
  if (conflicts.length) {
    if (or === "IGNORE") return false;
    if (or === "REPLACE") { for (const c of conflicts) { const old = w.read(c.rowid); if (old) { w.erase(old, c.rowid); } } }
    else throw new ConstraintError(w.uniqueMessage(conflicts[0]!));
  }
  if (newRowid !== oldRowid) { w.erase(oldRow, oldRowid); w.store(newRow, newRowid); }
  else w.replace(oldRow, newRow, oldRowid);
  shared.rowsAffected++;
  return true;
}

// ----- UPDATE -----

export interface UpdatePlan {
  stmt: BoundUpdate;
  table: TableInfo;
  input: Operator;
  inputLayout: Layout;
  /** Assignments compiled against the input plan's layout. */
  assignments: { column: number; expr: CompiledExpr }[];
  checks: Predicate[];
  checkExprs: CompiledExpr[];
  indexWhere: Map<string, Predicate>;
  /** RETURNING compiled against the full table row (relation 0). */
  returning?: CompiledExpr[];
}

export class Update extends OpBase {
  private out: Row[] = [];
  private pos = 0;
  constructor(layout: Layout, private readonly plan: UpdatePlan) { super(layout); }

  protected onOpen(): void {
    this.out = []; this.pos = 0;
    const p = this.plan, t = p.table, n = t.schema.columns.length;
    const rowidSlot = p.inputLayout.find(rowidKey(0));
    const colSlots: number[] = [];
    for (let i = 0; i < n; i++) colSlots.push(p.inputLayout.find(columnKey(0, i)));
    // phase 1: materialise targets (Halloween)
    const targets: { rowid: bigint; oldRow: Row; newRow: Row }[] = [];
    const seen = new Set<bigint>();
    p.input.open(this.ctx);
    try {
      for (let r = p.input.next(); r !== null; r = p.input.next()) {
        const rowid = r[rowidSlot] as bigint;
        if (seen.has(rowid)) continue; // UPDATE ... FROM matched the same target row twice: first match wins
        seen.add(rowid);
        const oldRow = new Array<Value>(n + 1);
        for (let i = 0; i < n; i++) oldRow[i] = r[colSlots[i]!] ?? null;
        oldRow[n] = rowid;
        const newRow = oldRow.slice();
        this.rows[0] = r;
        for (const a of p.assignments) newRow[a.column] = a.expr(this.rows, this.ctx);
        targets.push({ rowid, oldRow, newRow });
      }
    } finally { p.input.close(); }
    // phase 2: apply
    const shared = this.ctx.shared;
    const w = new TableWriter(shared, t, p.checks, p.indexWhere, this.ctx.outerRows, this.ctx);
    w.setCheckExprs(p.checkExprs);
    const or: ConflictAction = p.stmt.or ?? "ABORT";
    try {
      for (const tg of targets) {
        if (!applyUpdate(w, shared, tg.oldRow, tg.newRow, tg.rowid, or, n)) continue;
        if (p.returning) { this.rows[0] = tg.newRow; this.out.push(p.returning.map((f) => f(this.rows, this.ctx))); }
      }
    } finally { w.finish(); }
  }

  next(): Row | null { if (this.pos >= this.out.length) return null; this.stats.rows++; return this.out[this.pos++]!; }
  protected override onClose(): void { this.out = []; }
}

// ----- DELETE -----

export interface DeletePlan {
  table: TableInfo;
  input: Operator;
  inputLayout: Layout;
  indexWhere: Map<string, Predicate>;
  returning?: CompiledExpr[];
}

export class Delete extends OpBase {
  private out: Row[] = [];
  private pos = 0;
  constructor(layout: Layout, private readonly plan: DeletePlan) { super(layout); }

  protected onOpen(): void {
    this.out = []; this.pos = 0;
    const p = this.plan, t = p.table, n = t.schema.columns.length;
    const rowidSlot = p.inputLayout.find(rowidKey(0));
    const colSlots: number[] = [];
    for (let i = 0; i < n; i++) colSlots.push(p.inputLayout.find(columnKey(0, i)));
    const targets: Row[] = [];
    p.input.open(this.ctx);
    try {
      for (let r = p.input.next(); r !== null; r = p.input.next()) {
        const row = new Array<Value>(n + 1);
        for (let i = 0; i < n; i++) row[i] = r[colSlots[i]!] ?? null;
        row[n] = r[rowidSlot] ?? null;
        targets.push(row);
      }
    } finally { p.input.close(); }
    const shared = this.ctx.shared;
    const w = new TableWriter(shared, t, [], p.indexWhere, this.ctx.outerRows, this.ctx);
    try {
      for (const row of targets) {
        w.erase(row, row[n] as bigint);
        shared.rowsAffected++;
        if (p.returning) { this.rows[0] = row; this.out.push(p.returning.map((f) => f(this.rows, this.ctx))); }
      }
    } finally { w.finish(); }
  }

  next(): Row | null { if (this.pos >= this.out.length) return null; this.stats.rows++; return this.out[this.pos++]!; }
  protected override onClose(): void { this.out = []; }
}
