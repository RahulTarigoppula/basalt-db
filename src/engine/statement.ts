/** A prepared statement: parsed once, bound and planned once per schema version, executed many times with parameters. */
import type { QueryResult, ResultColumn, Row, Value } from "../core/types.js";
import type { Statement as AstStatement } from "../sql/ast.js";
import type { Database, Params, Prepared } from "./database.js";

export class Statement {
  private readonly prepared: Prepared;

  /** @internal */
  constructor(private readonly db: Database, readonly sql: string, ast: AstStatement) {
    this.prepared = { sql, ast, bound: undefined as unknown as Prepared["bound"], plan: null, schemaKey: "", columns: [], shared: null, root: null, builder: null };
  }

  /** Executes and returns the full result. */
  run(params: Params = []): QueryResult {
    return this.db.runAst(this.prepared.ast, this.sql, params, undefined, this.prepared);
  }

  /** All rows. */
  all(params: Params = []): Row[] { return this.run(params).rows; }

  /** The first row, or undefined. */
  get(params: Params = []): Row | undefined { return this.run(params).rows[0]; }

  /** Iterates the rows (materialised: storage is synchronous and the statement's transaction ends with `run`). */
  *iterate(params: Params = []): IterableIterator<Row> {
    yield* this.run(params).rows;
  }

  /** Result columns (available after the first execution, or by executing a bind-only pass). */
  get columns(): ResultColumn[] {
    if (!this.prepared.plan) this.db.describe(this.prepared);
    return this.prepared.columns;
  }

  /** Parameter count of the statement. */
  get parameterCount(): number {
    if (!this.prepared.bound) this.columns;
    return this.prepared.bound.parameters.count;
  }
}

export type { Value };
