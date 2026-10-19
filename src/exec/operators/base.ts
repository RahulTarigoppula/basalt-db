/** Shared operator scaffolding. */
import type { ResultColumn, Row } from "../../core/types.js";
import type { Layout } from "../../planner/layout.js";
import { EMPTY_ROW, layoutSchema, type ExecContext, type Operator, type OperatorStats } from "../context.js";
import type { CompiledExpr } from "../expr.js";

export abstract class OpBase implements Operator {
  readonly schema: ResultColumn[];
  readonly stats: OperatorStats = { rows: 0, ms: 0, loops: 0 };
  protected ctx!: ExecContext;
  /** `[currentRow, ...outerRows]` - the array handed to compiled expressions. */
  protected rows: Row[] = [EMPTY_ROW];

  constructor(layout: Layout) { this.schema = layoutSchema(layout); }

  open(ctx: ExecContext): void {
    this.ctx = ctx;
    this.rows = [EMPTY_ROW, ...ctx.outerRows];
    this.onOpen();
  }

  abstract next(): Row | null;
  close(): void { this.onClose(); }

  protected abstract onOpen(): void;
  protected onClose(): void { /* default: nothing */ }

  /** Evaluates `f` against `row` as the current row. */
  protected eval(f: CompiledExpr, row: Row): import("../../core/types.js").Value {
    this.rows[0] = row;
    return f(this.rows, this.ctx);
  }
}

/** Wraps an operator to record rows, loops and elapsed time (EXPLAIN ANALYZE). */
export class TimedOperator implements Operator {
  readonly stats: OperatorStats = { rows: 0, ms: 0, loops: 0 };
  constructor(private readonly inner: Operator) {}
  get schema(): ResultColumn[] { return this.inner.schema; }
  open(ctx: ExecContext): void {
    this.stats.loops++;
    const t = performance.now();
    this.inner.open(ctx);
    this.stats.ms += performance.now() - t;
  }
  next(): Row | null {
    const t = performance.now();
    const r = this.inner.next();
    this.stats.ms += performance.now() - t;
    if (r !== null) this.stats.rows++;
    return r;
  }
  close(): void {
    const t = performance.now();
    this.inner.close();
    this.stats.ms += performance.now() - t;
  }
}

/** Collects every row of an operator (opens and closes it). */
export function collectAll(op: Operator, ctx: ExecContext): Row[] {
  const out: Row[] = [];
  op.open(ctx);
  try { for (let r = op.next(); r !== null; r = op.next()) out.push(r); } finally { op.close(); }
  return out;
}
