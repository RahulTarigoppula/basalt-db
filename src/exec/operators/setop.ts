/** UNION / UNION ALL / INTERSECT / EXCEPT (hash based, SQLite set semantics) and recursive CTE evaluation. */
import type { Row, Value } from "../../core/types.js";
import type { Layout } from "../../planner/layout.js";
import type { CompoundOp } from "../../sql/ast.js";
import type { BoundCte } from "../../sql/bound.js";
import { EMPTY_ROW, type Operator } from "../context.js";
import type { CompiledExpr } from "../expr.js";
import { normalize, toInt64 } from "../functions.js";
import { rowKey } from "../hash.js";
import { OpBase } from "./base.js";
import { compareKeys, type CompiledSortKey } from "./basic.js";

export class SetOp extends OpBase {
  private out: Row[] = [];
  private pos = 0;
  private phase: "left" | "right" | "buffered" | "done" = "done";
  private seen = new Set<string>();

  constructor(layout: Layout, private readonly op: CompoundOp, private readonly left: Operator, private readonly right: Operator) { super(layout); }

  protected onOpen(): void {
    this.out = []; this.pos = 0; this.seen = new Set();
    switch (this.op) {
      case "UNION ALL": this.left.open(this.ctx); this.phase = "left"; return;
      case "UNION": this.left.open(this.ctx); this.phase = "left"; return;
      case "INTERSECT": case "EXCEPT": {
        // materialise the right side's distinct keys, then stream the (distinct) left
        const rightKeys = new Set<string>();
        this.right.open(this.ctx);
        try { for (let r = this.right.next(); r !== null; r = this.right.next()) rightKeys.add(rowKey(r)); } finally { this.right.close(); }
        this.left.open(this.ctx);
        try {
          for (let r = this.left.next(); r !== null; r = this.left.next()) {
            const k = rowKey(r);
            if (this.seen.has(k)) continue;
            this.seen.add(k);
            if (rightKeys.has(k) === (this.op === "INTERSECT")) this.out.push(r);
          }
        } finally { this.left.close(); }
        this.phase = "buffered";
        return;
      }
    }
  }

  next(): Row | null {
    for (;;) {
      switch (this.phase) {
        case "done": return null;
        case "buffered": if (this.pos >= this.out.length) { this.phase = "done"; return null; } this.stats.rows++; return this.out[this.pos++]!;
        case "left": {
          const r = this.left.next();
          if (r === null) { this.left.close(); this.right.open(this.ctx); this.phase = "right"; continue; }
          if (this.op === "UNION") { const k = rowKey(r); if (this.seen.has(k)) continue; this.seen.add(k); }
          this.stats.rows++;
          return r;
        }
        case "right": {
          const r = this.right.next();
          if (r === null) { this.right.close(); this.phase = "done"; return null; }
          if (this.op === "UNION") { const k = rowKey(r); if (this.seen.has(k)) continue; this.seen.add(k); }
          this.stats.rows++;
          return r;
        }
      }
    }
  }

  protected override onClose(): void {
    if (this.phase === "left") this.left.close();
    if (this.phase === "right") this.right.close();
    this.phase = "done"; this.out = []; this.seen = new Set();
  }
}

/**
 * Recursive CTE. Without ORDER BY / LIMIT: run the anchor, then repeatedly run the recursive term with the previous
 * iteration's rows as the working table until nothing new appears (breadth first). With ORDER BY or LIMIT the SQLite
 * queue semantics apply: rows are processed one at a time, picking the smallest row of the queue (ORDER BY) and stopping
 * once LIMIT rows were produced. UNION (not ALL) de-duplicates rows before they enter the queue.
 */
export class RecursiveCte extends OpBase {
  private out: Row[] = [];
  private pos = 0;
  private static readonly MAX_ITERATIONS = 10_000_000;

  constructor(layout: Layout, private readonly cte: BoundCte, private readonly anchor: Operator, private readonly recursive: Operator, private readonly unionAll: boolean,
    private readonly orderBy: CompiledSortKey[] = [], private readonly limit?: CompiledExpr, private readonly offset?: CompiledExpr) { super(layout); }

  protected onOpen(): void {
    this.out = []; this.pos = 0;
    const seen = this.unionAll ? null : new Set<string>();
    const child = this.ctx.child([]);
    const shared = this.ctx.shared;
    const fresh = (r: Row): boolean => { if (!seen) return true; const k = rowKey(r); if (seen.has(k)) return false; seen.add(k); return true; };
    const run = (op: Operator, into: Row[]): void => {
      op.open(child);
      try { for (let r = op.next(); r !== null; r = op.next()) if (fresh(r)) into.push(r); } finally { op.close(); }
    };
    const queued = this.orderBy.length > 0 || this.limit !== undefined || this.offset !== undefined;
    if (!queued) {
      let working: Row[] = [];
      run(this.anchor, working);
      this.out.push(...working);
      for (let iter = 0; working.length > 0 && iter < RecursiveCte.MAX_ITERATIONS; iter++) {
        shared.workingTables.set(this.cte, working);
        const next: Row[] = [];
        run(this.recursive, next);
        this.out.push(...next);
        working = next;
      }
      shared.workingTables.delete(this.cte);
      this.rows[0] = EMPTY_ROW;
      return;
    }
    this.rows[0] = EMPTY_ROW;
    const limV = this.limit ? this.limit(this.rows, this.ctx) : null;
    const offV = this.offset ? this.offset(this.rows, this.ctx) : null;
    const lim = limV === null ? Infinity : Number(toInt64(normalize(limV)));
    const off = offV === null ? 0 : Math.max(0, Number(toInt64(normalize(offV))));
    const budget = lim < 0 ? Infinity : lim + off;
    const queue: { row: Row; keys: Value[] }[] = [];
    const keysOf = (r: Row): Value[] => { this.rows[0] = r; const ks = new Array<Value>(this.orderBy.length); for (let i = 0; i < ks.length; i++) ks[i] = normalize(this.orderBy[i]!.expr(this.rows, this.ctx)); return ks; };
    const push = (rows: Row[]): void => { for (const r of rows) queue.push({ row: r, keys: keysOf(r) }); };
    const anchorRows: Row[] = [];
    run(this.anchor, anchorRows);
    push(anchorRows);
    let produced = 0;
    while (queue.length > 0 && produced < budget) {
      let best = 0;
      if (this.orderBy.length) for (let i = 1; i < queue.length; i++) if (compareKeys(queue[i]!.keys, queue[best]!.keys, this.orderBy) < 0) best = i;
      const [item] = queue.splice(best, 1);
      this.out.push(item!.row);
      produced++;
      if (produced >= budget) break;
      shared.workingTables.set(this.cte, [item!.row]);
      const next: Row[] = [];
      run(this.recursive, next);
      push(next);
    }
    shared.workingTables.delete(this.cte);
    if (off > 0) this.out = this.out.slice(off);
    this.rows[0] = EMPTY_ROW;
  }

  next(): Row | null { if (this.pos >= this.out.length) return null; this.stats.rows++; return this.out[this.pos++]!; }
  protected override onClose(): void { this.out = []; }
}
