/**
 * Physical plan -> operator tree. This is where bound expressions are re-laid out against the layout stack of the
 * operator that evaluates them (`planner/layout.ts`) and compiled once per plan, and where the subqueries they contain
 * are planned and registered on the shared execution state.
 */
import { BasaltError } from "../core/errors.js";
import { Layout, allRefsAtDepth, columnKey, exprKey, rewriteExpr, rowidKey, type SubqueryUse } from "../planner/layout.js";
import type { PhysicalNode } from "../planner/physical.js";
import { planSelect, type PlanContext } from "../planner/physical.js";
import type { BoundExpr, BoundFrameBound, BoundSubquery, BoundWindow } from "../sql/bound.js";
import { EMPTY_ROW, SubqueryRunner, type Operator, type SharedExec } from "./context.js";
import { Insert, Update, Delete, tableLayout, type InsertPlan } from "./dml.js";
import { Alter, Analyze, CreateIndex, CreateTable, CreateView, Drop, Pragma } from "./ddl.js";
import { compileExpr, compilePredicate, type CompiledExpr } from "./expr.js";
import { builtinFunctions } from "./functions.js";
import { HashAggregate, SortedAggregate, Window, type CompiledAgg, type CompiledFrameBound, type CompiledWindow } from "./operators/aggregate.js";
import { TimedOperator } from "./operators/base.js";
import { Distinct, Filter, Limit, Project, Sort, TopK, Truncate, type CompiledSortKey, type Predicate } from "./operators/basic.js";
import { HashJoin, MergeJoin, NestedLoopJoin } from "./operators/join.js";
import { CteScan, IndexScan, Materialize, RowidLookup, SeqScan, SubqueryScan, Values, WorkingTable, type ScanBound } from "./operators/scan.js";
import { RecursiveCte, SetOp } from "./operators/setop.js";

export class OperatorBuilder {
  /** Operators per physical node (for EXPLAIN ANALYZE statistics). */
  readonly built = new Map<PhysicalNode, Operator>();

  constructor(private readonly shared: SharedExec, private readonly planCtx: PlanContext, private readonly analyze = false, private readonly sortSpillThreshold?: number) {}

  // ----- expressions -----

  compile(expr: BoundExpr, stack: Layout[]): CompiledExpr {
    const uses: SubqueryUse[] = [];
    const rewritten = rewriteExpr(expr, stack, uses);
    for (const u of uses) this.registerSubquery(u.subquery, u.stack);
    return compileExpr(rewritten, { functions: builtinFunctions });
  }

  predicate(expr: BoundExpr, stack: Layout[]): Predicate {
    const uses: SubqueryUse[] = [];
    const rewritten = rewriteExpr(expr, stack, uses);
    for (const u of uses) this.registerSubquery(u.subquery, u.stack);
    return compilePredicate(rewritten, { functions: builtinFunctions });
  }

  private registerSubquery(sub: BoundSubquery, stack: Layout[]): void {
    if (this.shared.subplans.has(sub)) return;
    const plan = planSelect(sub.select, this.planCtx);
    // placeholder first so recursive registration terminates
    const correlated: { depth: number; slot: number }[] = [];
    const wrapper: BoundExpr = { kind: "exists", not: false, subquery: sub, dataType: "INTEGER", loc: sub.select.loc };
    for (let d = 1; d <= stack.length; d++) {
      const L = stack[d - 1]!;
      const seen = new Set<number>();
      for (const r of allRefsAtDepth(wrapper, d - 1)) {
        const slot = L.find(r.kind === "rowid" ? rowidKey(r.relation) : columnKey(r.relation, r.column));
        if (seen.has(slot)) continue;
        seen.add(slot);
        correlated.push({ depth: d, slot });
      }
    }
    const op = this.build(plan, stack);
    this.shared.subplans.set(sub, new SubqueryRunner(op, correlated));
  }

  private sortKeys(keys: { expr: BoundExpr; desc: boolean; nullsFirst: boolean }[], stack: Layout[]): CompiledSortKey[] {
    return keys.map((k) => ({ expr: this.compile(k.expr, stack), desc: k.desc, nullsFirst: k.nullsFirst }));
  }

  private bound(b: { expr: BoundExpr; inclusive: boolean } | undefined, stack: Layout[]): ScanBound | undefined {
    return b ? { expr: this.compile(b.expr, stack), inclusive: b.inclusive } : undefined;
  }

  // ----- operators -----

  /** Builds the operator for `node`; `outer` are the layouts of the enclosing scopes' rows (`rows[1..]`). */
  build(node: PhysicalNode, outer: Layout[]): Operator {
    const op = this.buildInner(node, outer);
    const wrapped = this.analyze ? new TimedOperator(op) : op;
    this.built.set(node, wrapped);
    return wrapped;
  }

  private buildInner(n: PhysicalNode, outer: Layout[]): Operator {
    const own = (l: Layout): Layout[] => [l, ...outer];
    switch (n.kind) {
      case "seqscan": {
        const st = own(n.layout);
        return new SeqScan(n.layout, n.table, n.filter ? this.predicate(n.filter, st) : undefined, this.bound(n.lo, st), this.bound(n.hi, st), n.direction);
      }
      case "rowidlookup": {
        const st = own(n.layout);
        return new RowidLookup(n.layout, n.table, this.compile(n.rowid, st), n.filter ? this.predicate(n.filter, st) : undefined);
      }
      case "indexscan": {
        const st = own(n.layout);
        return new IndexScan(n.layout, n.table, n.index, n.eq.map((e) => this.compile(e, st)), n.eq.map((e) => e.kind === "literal" && e.value === null),
          this.bound(n.lo, st), this.bound(n.hi, st), n.covering, n.filter ? this.predicate(n.filter, st) : undefined, n.direction);
      }
      case "subqueryscan": return new SubqueryScan(n.layout, this.build(n.plan, [Layout.empty(), ...outer]));
      case "ctescan": return new CteScan(n.layout, n.cte, this.build(n.plan, []));
      case "working": return new WorkingTable(n.layout, n.cte);
      case "values": {
        const st = own(Layout.empty());
        return new Values(n.layout, n.rows.map((r) => r.map((e) => this.compile(e, st))));
      }
      case "materialize": return new Materialize(n.layout, this.build(n.input, outer));
      case "filter": return new Filter(n.layout, this.build(n.input, outer), this.predicate(n.predicate, own(n.input.layout)));
      case "project": {
        const st = own(n.input.layout);
        return new Project(n.layout, this.build(n.input, outer), n.exprs.map((e) => this.compile(e, st)));
      }
      case "truncate": return new Truncate(n.layout, this.build(n.input, outer), n.keep);
      case "limit": {
        const st = own(Layout.empty());
        return new Limit(n.layout, this.build(n.input, outer), n.limit ? this.compile(n.limit, st) : undefined, n.offset ? this.compile(n.offset, st) : undefined);
      }
      case "distinct": return new Distinct(n.layout, this.build(n.input, outer), n.keyCount);
      case "sort": return new Sort(n.layout, this.build(n.input, outer), this.sortKeys(n.keys, own(n.input.layout)), this.sortSpillThreshold);
      case "topk": {
        const st = own(Layout.empty());
        return new TopK(n.layout, this.build(n.input, outer), this.sortKeys(n.keys, own(n.input.layout)), this.compile(n.limit, st), n.offset ? this.compile(n.offset, st) : undefined);
      }
      case "nestedloop": {
        const combined = n.left.layout.concat(n.right.layout);
        return new NestedLoopJoin(n.layout, n.type, this.build(n.left, outer), this.build(n.right, outer), n.condition ? this.predicate(n.condition, own(combined)) : undefined, n.left.layout.size, n.right.layout.size);
      }
      case "hashjoin": {
        const combined = n.left.layout.concat(n.right.layout);
        return new HashJoin(n.layout, n.type, this.build(n.left, outer), this.build(n.right, outer),
          n.leftKeys.map((e) => this.compile(e, own(n.left.layout))), n.rightKeys.map((e) => this.compile(e, own(n.right.layout))),
          n.residual ? this.predicate(n.residual, own(combined)) : undefined, n.left.layout.size, n.right.layout.size);
      }
      case "mergejoin": {
        const combined = n.left.layout.concat(n.right.layout);
        return new MergeJoin(n.layout, n.type, this.build(n.left, outer), this.build(n.right, outer),
          this.compile(n.leftKeys[0]!, own(n.left.layout)), this.compile(n.rightKeys[0]!, own(n.right.layout)),
          n.residual ? this.predicate(n.residual, own(combined)) : undefined, n.left.layout.size, n.right.layout.size);
      }
      case "hashaggregate": case "sortedaggregate": {
        const st = own(n.input.layout);
        const groupBy = n.groupBy.map((g) => this.compile(g, st));
        const aggs: CompiledAgg[] = n.aggs.map((a) => {
          const fn = builtinFunctions.getAggregate(a.name);
          if (!fn) throw new BasaltError(`no such aggregate function: ${a.name}`);
          return { fn, args: a.args.map((x) => this.compile(x, st)), star: a.star, distinct: a.distinct, filter: a.filter ? this.predicate(a.filter, st) : undefined };
        });
        const pass = n.passthrough.map((p) => n.input.layout.find(p.rowid ? rowidKey(p.relation) : columnKey(p.relation, p.column)));
        const input = this.build(n.input, outer);
        return n.kind === "hashaggregate" ? new HashAggregate(n.layout, input, groupBy, aggs, pass) : new SortedAggregate(n.layout, input, groupBy, aggs, pass);
      }
      case "window": {
        const st = own(n.input.layout);
        const windows = n.windows.map((w, i) => this.compileWindow(w, i, st));
        return new Window(n.layout, this.build(n.input, outer), windows);
      }
      case "setop": return new SetOp(n.layout, n.op, this.build(n.left, outer), this.build(n.right, outer));
      case "recursivecte": {
        const st = [n.layout];
        const lim = [Layout.empty()];
        return new RecursiveCte(n.layout, n.cte, this.build(n.anchor, []), this.build(n.recursive, []), n.unionAll,
          this.sortKeys(n.orderBy, st), n.limit ? this.compile(n.limit, lim) : undefined, n.offset ? this.compile(n.offset, lim) : undefined);
      }
      case "insert": return this.buildInsert(n);
      case "update": {
        const input = this.build(n.input, []);
        const st = [n.input.layout];
        const tl = [tableLayout(n.table, 0)];
        const where = this.indexWhere(n.table.schema.name, tl);
        return new Update(n.layout, {
          stmt: n.stmt, table: n.table, input, inputLayout: n.input.layout,
          assignments: n.stmt.assignments.map((a) => ({ column: a.column, expr: this.compile(a.expr, st) })),
          checks: n.table.checks.map((c) => this.predicate(c, tl)), checkExprs: n.table.checks.map((c) => this.compile(c, tl)), indexWhere: where,
          returning: n.stmt.returning?.map((r) => this.compile(r.expr, tl)),
        });
      }
      case "delete": {
        const input = this.build(n.input, []);
        const tl = [tableLayout(n.table, 0)];
        return new Delete(n.layout, { table: n.table, input, inputLayout: n.input.layout, indexWhere: this.indexWhere(n.table.schema.name, tl), returning: n.stmt.returning?.map((r) => this.compile(r.expr, tl)) });
      }
      case "createtable": {
        const tl = [Layout.relation(0, n.stmt.table.columns.map((c) => ({ name: c.name, type: c.type, hidden: false })), true)];
        return new CreateTable(n.layout, n.stmt, n.source ? this.build(n.source, []) : undefined, n.stmt.checks.map((c) => this.predicate(c, tl)), n.stmt.checks.map((c) => this.compile(c, tl)));
      }
      case "createindex": {
        const t = this.planCtx.schema.table(n.stmt.index.table);
        const tl = t ? [tableLayout(t, 0)] : [];
        return new CreateIndex(n.layout, n.stmt, n.stmt.where && t ? this.predicate(n.stmt.where, tl) : undefined);
      }
      case "createview": return new CreateView(n.layout, n.stmt);
      case "drop": return new Drop(n.layout, n.stmt);
      case "alter": return new Alter(n.layout, n.stmt);
      case "analyze": return new Analyze(n.layout, n.stmt.target);
      case "pragma": return new Pragma(n.layout, n.stmt);
      case "vacuum": case "explain": throw new BasaltError(`internal: ${n.kind} is executed by the engine`);
    }
  }

  private indexWhere(table: string, tl: Layout[]): Map<string, Predicate> {
    const out = new Map<string, Predicate>();
    for (const ix of this.planCtx.schema.listIndexInfos(table)) if (ix.where) out.set(ix.schema.name.toLowerCase(), this.predicate(ix.where, tl));
    return out;
  }

  private buildInsert(n: Extract<PhysicalNode, { kind: "insert" }>): Operator {
    const t = n.table;
    const tl = [tableLayout(t, 0)];
    const both = [tableLayout(t, 0).concat(tableLayout(t, 1))];
    const plan: InsertPlan = {
      stmt: n.stmt, table: t,
      source: n.source ? this.build(n.source, []) : undefined,
      defaults: n.stmt.defaults.map((d) => (d ? this.compile(d, [Layout.empty()]) : null)),
      checks: t.checks.map((c) => this.predicate(c, tl)), checkExprs: t.checks.map((c) => this.compile(c, tl)),
      indexWhere: this.indexWhere(t.schema.name, tl),
      upsertSet: n.stmt.upsert?.set?.map((s) => ({ column: s.column, expr: this.compile(s.expr, both) })),
      upsertWhere: n.stmt.upsert?.where ? this.predicate(n.stmt.upsert.where, both) : undefined,
      returning: n.stmt.returning?.map((r) => this.compile(r.expr, tl)),
    };
    return new Insert(n.layout, plan);
  }

  private compileWindow(w: BoundWindow, index: number, st: Layout[]): CompiledWindow {
    const fn = w.isAggregate ? undefined : builtinFunctions.getWindow(w.name);
    const agg = w.isAggregate ? builtinFunctions.getAggregate(w.name) : undefined;
    if (!fn && !agg) throw new BasaltError(`no such window function: ${w.name}`);
    const cb = (b: BoundFrameBound): CompiledFrameBound => (b.kind === "preceding" || b.kind === "following" ? { kind: b.kind, offset: this.compile(b.offset, [Layout.empty(), ...st.slice(1)]) } : { kind: b.kind });
    const specKey = `${w.spec.partitionBy.map((p) => exprKey(p)).join(",")}|${w.spec.orderBy.map((o) => `${exprKey(o.expr)}${o.desc ? "D" : "A"}${o.nullsFirst ? "F" : "L"}`).join(",")}|${w.spec.frame ? JSON.stringify({ u: w.spec.frame.unit, s: frameKey(w.spec.frame.start), e: frameKey(w.spec.frame.end), x: w.spec.frame.exclude }) : ""}`;
    return {
      index, fn, agg, args: w.args.map((a) => this.compile(a, st)), distinct: w.distinct, filter: w.filter ? this.predicate(w.filter, st) : undefined,
      partitionBy: w.spec.partitionBy.map((p) => this.compile(p, st)), orderBy: this.sortKeys(w.spec.orderBy, st),
      frame: w.spec.frame ? { unit: w.spec.frame.unit, start: cb(w.spec.frame.start), end: cb(w.spec.frame.end), exclude: w.spec.frame.exclude } : undefined,
      specKey,
    };
  }
}

function frameKey(b: BoundFrameBound): string {
  return b.kind === "preceding" || b.kind === "following" ? `${b.kind}:${exprKey(b.offset)}` : b.kind;
}

export { EMPTY_ROW };
