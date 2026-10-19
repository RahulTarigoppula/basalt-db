/**
 * Expression compiler: turns bound expressions into closures `(rows, ctx) => Value` once per plan, so no AST is
 * walked per row. Implements SQLite's three-valued logic, numeric promotion (INTEGER op INTEGER -> bigint, overflow ->
 * REAL, division by zero -> NULL), `||`, comparisons via `compareValues`, LIKE/GLOB, BETWEEN, CASE, CAST, IN.
 *
 * Row layout: `rows[i]` is the current row of relation `i` in the expression's scope; outer-scope rows follow
 * (see `sql/bound.ts`). Subqueries are delegated to `EvalContext.evalSubquery`.
 */
import { BasaltError } from "../core/errors.js";
import { compareValues, type Row, type Value } from "../core/types.js";
import type {
  BoundAggregate, BoundBinary, BoundExpr, BoundResultColumnRef, BoundRowid, BoundSubquery, BoundWindow,
} from "../sql/bound.js";
import {
  INT64_MAX, INT64_MIN, builtinFunctions, castValue, compileGlob, compileLike, doubleToInt64, normalize, sqlGlob, sqlLike,
  toInt64, toNumeric, toText, truthy, type FunctionRegistry,
} from "./functions.js";

/** Runtime services the executor provides to compiled expressions. */
export interface EvalContext {
  /** Statement parameters (`?` / `:name` slots, 0-based as in `BoundParameter.index`). */
  readonly params: readonly Value[];
  /**
   * Evaluate a subquery for the given outer rows and return ALL of its result rows. `rows` is exactly the array the
   * enclosing expression was evaluated with; the executor must evaluate the subquery's own expressions against
   * `[...subqueryRelationRows, ...rows]`. The compiler derives scalar (first row/col), EXISTS and IN semantics.
   */
  evalSubquery(subquery: BoundSubquery, rows: Row[]): readonly Row[];
  /** Uniform random in [0, 1); defaults to Math.random (make it seedable for tests). */
  random?(): number;
  /** Current time in epoch milliseconds for CURRENT_TIMESTAMP & co; defaults to Date.now(). */
  now?(): number;
}

/** A compiled expression. */
export type CompiledExpr = (rows: Row[], ctx: EvalContext) => Value;

/** Hooks for nodes that only make sense after planning. */
export interface CompileOptions {
  /** Supplies the value of an aggregate (e.g. a column of the Aggregate operator's output row). */
  aggregate?(node: BoundAggregate): CompiledExpr;
  /** Supplies the value of a window function call. */
  window?(node: BoundWindow): CompiledExpr;
  /** Supplies the rowid of a relation. */
  rowid?(node: BoundRowid): CompiledExpr;
  /** Supplies the i-th result column (ORDER BY on compound selects). */
  resultColumn?(node: BoundResultColumnRef): CompiledExpr;
  /** Function registry (defaults to the builtins). */
  functions?: FunctionRegistry;
  /** Fold constant sub-expressions at compile time (default true). */
  constantFolding?: boolean;
}

/** A context usable for evaluating constant expressions (no params, no subqueries). */
export const CONSTANT_CONTEXT: EvalContext = {
  params: [],
  evalSubquery(): readonly Row[] { throw new BasaltError("subqueries cannot be evaluated in a constant context", "ERROR"); },
};

// ───────────────────────────────── arithmetic ─────────────────────────────────

function inRange(b: bigint): boolean { return b >= INT64_MIN && b <= INT64_MAX; }

/** `a + b` with SQLite semantics. */
export function sqlAdd(a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  if (typeof a === "bigint" && typeof b === "bigint") { const r = a + b; return inRange(r) ? r : Number(a) + Number(b); }
  const x = toNumeric(a), y = toNumeric(b);
  if (typeof x === "bigint" && typeof y === "bigint") { const r = x + y; return inRange(r) ? r : Number(x) + Number(y); }
  return Number(x) + Number(y);
}

/** `a - b`. */
export function sqlSub(a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  if (typeof a === "bigint" && typeof b === "bigint") { const r = a - b; return inRange(r) ? r : Number(a) - Number(b); }
  const x = toNumeric(a), y = toNumeric(b);
  if (typeof x === "bigint" && typeof y === "bigint") { const r = x - y; return inRange(r) ? r : Number(x) - Number(y); }
  return Number(x) - Number(y);
}

/** `a * b`. */
export function sqlMul(a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  if (typeof a === "bigint" && typeof b === "bigint") { const r = a * b; return inRange(r) ? r : Number(a) * Number(b); }
  const x = toNumeric(a), y = toNumeric(b);
  if (typeof x === "bigint" && typeof y === "bigint") { const r = x * y; return inRange(r) ? r : Number(x) * Number(y); }
  return Number(x) * Number(y);
}

/** `a / b`: integer division truncates toward zero; division by zero -> NULL. */
export function sqlDiv(a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  const x = toNumeric(a), y = toNumeric(b);
  if (typeof x === "bigint" && typeof y === "bigint") {
    if (y === 0n) return null;
    if (x === INT64_MIN && y === -1n) return -Number(x);
    return x / y;
  }
  const d = Number(y);
  if (d === 0) return null;
  return Number(x) / d;
}

/** `a % b`: both operands are converted to integers; modulo by zero -> NULL; REAL operand -> REAL result. */
export function sqlMod(a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  const x = toNumeric(a), y = toNumeric(b);
  if (typeof x === "bigint" && typeof y === "bigint") {
    if (y === 0n) return null;
    if (y === -1n) return 0n;
    return x % y;
  }
  const ix = typeof x === "bigint" ? x : doubleToInt64(x);
  const iy = typeof y === "bigint" ? y : doubleToInt64(y);
  if (iy === 0n) return null;
  return iy === -1n ? 0 : Number(ix % iy);
}

/** `a << b` (negative shifts reverse direction; shifts ≥ 64 saturate like SQLite). */
export function sqlShiftLeft(a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  const x = toInt64(a), n = toInt64(b);
  return shl(x, n);
}

/** `a >> b`. */
export function sqlShiftRight(a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  const x = toInt64(a), n = toInt64(b);
  return shl(x, -n);
}

function shl(x: bigint, n: bigint): bigint {
  if (n >= 64n) return 0n;
  if (n <= -64n) return x < 0n ? -1n : 0n;
  if (n >= 0n) return BigInt.asIntN(64, x << n);
  return x >> -n; // arithmetic shift
}

/** Unary minus. */
export function sqlNegate(a: Value): Value {
  if (a === null) return null;
  const x = toNumeric(a);
  if (typeof x === "bigint") return x === INT64_MIN ? -Number(x) : -x;
  return -x;
}

/** `a || b`: NULL if either side is NULL. */
export function sqlConcat(a: Value, b: Value): Value {
  if (a === null || b === null) return null;
  return toText(a) + toText(b);
}

// ───────────────────────────────── comparisons ─────────────────────────────────

/** Three-valued comparison: returns the sign (-1/0/1) or null when either side is NULL. */
export function sqlCompare(a: Value, b: Value): number | null {
  if (a === null || b === null) return null;
  return compareValues(normalize(a), normalize(b));
}

/** `a IS b`: NULL-safe equality (never NULL). */
export function sqlIs(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  return compareValues(normalize(a), normalize(b)) === 0;
}

function bool(b: boolean): Value { return b ? 1n : 0n; }

/** `needle IN (values...)` with SQL NULL semantics. */
export function sqlIn(needle: Value, values: readonly Value[]): Value {
  if (values.length === 0) return 0n;
  if (needle === null) return null;
  const n = normalize(needle);
  let sawNull = false;
  for (const v of values) {
    if (v === null) { sawNull = true; continue; }
    if (compareValues(n, normalize(v)) === 0) return 1n;
  }
  return sawNull ? null : 0n;
}

// ───────────────────────────────── compiler ─────────────────────────────────

/** Compile a bound expression into a closure. Throws on planner-only nodes unless the matching hook is given. */
export function compileExpr(expr: BoundExpr, options: CompileOptions = {}): CompiledExpr {
  return new Compiler(options).compile(expr);
}

/** Compile an expression used as a predicate: returns true only when the SQL value is TRUE (NULL -> false). */
export function compilePredicate(expr: BoundExpr, options: CompileOptions = {}): (rows: Row[], ctx: EvalContext) => boolean {
  const f = compileExpr(expr, options);
  return (rows, ctx) => truthy(f(rows, ctx)) === true;
}

/** True when the expression has no column/parameter/subquery/aggregate references and only deterministic functions. */
export function isConstantExpr(expr: BoundExpr, functions: FunctionRegistry = builtinFunctions): boolean {
  switch (expr.kind) {
    case "literal": return true;
    case "column": case "rowid": case "param": case "aggregate": case "window": case "exists": case "subquery": case "resultColumn": return false;
    case "unary": return isConstantExpr(expr.operand, functions);
    case "binary": return isConstantExpr(expr.left, functions) && isConstantExpr(expr.right, functions);
    case "like": return isConstantExpr(expr.left, functions) && isConstantExpr(expr.right, functions) && (!expr.escape || isConstantExpr(expr.escape, functions));
    case "between": return isConstantExpr(expr.expr, functions) && isConstantExpr(expr.low, functions) && isConstantExpr(expr.high, functions);
    case "in": return !!expr.list && isConstantExpr(expr.expr, functions) && expr.list.every((e) => isConstantExpr(e, functions));
    case "isnull": return isConstantExpr(expr.expr, functions);
    case "case": return (!expr.operand || isConstantExpr(expr.operand, functions)) && expr.whens.every((w) => isConstantExpr(w.when, functions) && isConstantExpr(w.then, functions)) && (!expr.else || isConstantExpr(expr.else, functions));
    case "cast": return isConstantExpr(expr.expr, functions);
    case "function": {
      const f = functions.getScalar(expr.name);
      return !!f && f.deterministic && expr.args.every((a) => isConstantExpr(a, functions));
    }
  }
}

/** Evaluate a constant expression (see `isConstantExpr`). */
export function evaluateConstant(expr: BoundExpr, functions: FunctionRegistry = builtinFunctions): Value {
  return compileExpr(expr, { functions, constantFolding: false })([], CONSTANT_CONTEXT);
}

const EMPTY_ROWS: Row[] = [];

class Compiler {
  private readonly functions: FunctionRegistry;
  private readonly fold: boolean;
  constructor(private readonly options: CompileOptions) {
    this.functions = options.functions ?? builtinFunctions;
    this.fold = options.constantFolding !== false;
  }

  compile(e: BoundExpr): CompiledExpr {
    if (this.fold && e.kind !== "literal" && isConstantExpr(e, this.functions)) {
      const v = this.compileNode(e)(EMPTY_ROWS, CONSTANT_CONTEXT);
      return () => v;
    }
    return this.compileNode(e);
  }

  private compileNode(e: BoundExpr): CompiledExpr {
    switch (e.kind) {
      case "literal": { const v = e.value; return () => v; }
      case "column": {
        const rel = e.rel, col = e.column;
        return (rows) => {
          const row = rows[rel];
          if (row === undefined) throw new BasaltError(`internal: relation ${rel} not in scope`, "ERROR");
          const v = row[col];
          return v === undefined ? null : v;
        };
      }
      case "param": { const i = e.index; return (_rows, ctx) => { const v = ctx.params[i]; return v === undefined ? null : v; }; }
      case "rowid": {
        if (!this.options.rowid) throw new BasaltError("internal: rowid reference must be rewritten by the planner", "ERROR");
        return this.options.rowid(e);
      }
      case "aggregate": {
        if (!this.options.aggregate) throw new BasaltError(`internal: aggregate ${e.name}() must be rewritten by the planner`, "ERROR");
        return this.options.aggregate(e);
      }
      case "window": {
        if (!this.options.window) throw new BasaltError(`internal: window function ${e.name}() must be rewritten by the planner`, "ERROR");
        return this.options.window(e);
      }
      case "resultColumn": {
        if (!this.options.resultColumn) throw new BasaltError("internal: result column reference must be rewritten by the planner", "ERROR");
        return this.options.resultColumn(e);
      }
      case "unary": return this.compileUnary(e.op, this.compile(e.operand));
      case "binary": return this.compileBinary(e);
      case "like": return this.compileLike(e);
      case "between": {
        const x = this.compile(e.expr), lo = this.compile(e.low), hi = this.compile(e.high), not = e.not;
        return (rows, ctx) => {
          const v = x(rows, ctx);
          if (v === null) return null;
          const nv = normalize(v);
          const l = lo(rows, ctx), h = hi(rows, ctx);
          // v >= l AND v <= h with 3VL
          let ge: boolean | null = l === null ? null : compareValues(nv, normalize(l)) >= 0;
          let le: boolean | null = h === null ? null : compareValues(nv, normalize(h)) <= 0;
          if (not) { ge = ge === null ? null : !ge; le = le === null ? null : !le; return orValues(ge, le); }
          return andValues(ge, le);
        };
      }
      case "in": return this.compileIn(e);
      case "isnull": {
        const x = this.compile(e.expr);
        return e.not ? (rows, ctx) => bool(x(rows, ctx) !== null) : (rows, ctx) => bool(x(rows, ctx) === null);
      }
      case "case": return this.compileCase(e);
      case "cast": {
        const x = this.compile(e.expr), target = e.target;
        return (rows, ctx) => castValue(x(rows, ctx), target);
      }
      case "function": return this.compileFunction(e.name, e.args.map((a) => this.compile(a)));
      case "exists": {
        const sub = e.subquery, not = e.not;
        return (rows, ctx) => bool((ctx.evalSubquery(sub, rows).length > 0) !== not);
      }
      case "subquery": {
        const sub = e.subquery;
        return (rows, ctx) => { const r = ctx.evalSubquery(sub, rows); const first = r[0]; return first === undefined ? null : (first[0] ?? null); };
      }
    }
  }

  private compileUnary(op: "-" | "+" | "~" | "NOT", x: CompiledExpr): CompiledExpr {
    switch (op) {
      case "-": return (rows, ctx) => sqlNegate(x(rows, ctx));
      case "+": return x;
      case "~": return (rows, ctx) => { const v = x(rows, ctx); return v === null ? null : BigInt.asIntN(64, ~toInt64(v)); };
      case "NOT": return (rows, ctx) => { const t = truthy(x(rows, ctx)); return t === null ? null : bool(!t); };
    }
  }

  private compileBinary(e: BoundBinary): CompiledExpr {
    const l = this.compile(e.left), r = this.compile(e.right);
    switch (e.op) {
      case "AND": return (rows, ctx) => {
        const a = l(rows, ctx);
        if (a !== null && !truthy(a)) return 0n;
        const b = r(rows, ctx);
        if (b !== null && !truthy(b)) return 0n;
        return a === null || b === null ? null : 1n;
      };
      case "OR": return (rows, ctx) => {
        const a = l(rows, ctx);
        if (a !== null && truthy(a)) return 1n;
        const b = r(rows, ctx);
        if (b !== null && truthy(b)) return 1n;
        return a === null || b === null ? null : 0n;
      };
      case "||": return (rows, ctx) => sqlConcat(l(rows, ctx), r(rows, ctx));
      case "+": return (rows, ctx) => sqlAdd(l(rows, ctx), r(rows, ctx));
      case "-": return (rows, ctx) => sqlSub(l(rows, ctx), r(rows, ctx));
      case "*": return (rows, ctx) => sqlMul(l(rows, ctx), r(rows, ctx));
      case "/": return (rows, ctx) => sqlDiv(l(rows, ctx), r(rows, ctx));
      case "%": return (rows, ctx) => sqlMod(l(rows, ctx), r(rows, ctx));
      case "<<": return (rows, ctx) => sqlShiftLeft(l(rows, ctx), r(rows, ctx));
      case ">>": return (rows, ctx) => sqlShiftRight(l(rows, ctx), r(rows, ctx));
      case "&": return (rows, ctx) => { const a = l(rows, ctx), b = r(rows, ctx); return a === null || b === null ? null : toInt64(a) & toInt64(b); };
      case "|": return (rows, ctx) => { const a = l(rows, ctx), b = r(rows, ctx); return a === null || b === null ? null : toInt64(a) | toInt64(b); };
      case "=": case "==": return (rows, ctx) => { const c = sqlCompare(l(rows, ctx), r(rows, ctx)); return c === null ? null : bool(c === 0); };
      case "!=": case "<>": return (rows, ctx) => { const c = sqlCompare(l(rows, ctx), r(rows, ctx)); return c === null ? null : bool(c !== 0); };
      case "<": return (rows, ctx) => { const c = sqlCompare(l(rows, ctx), r(rows, ctx)); return c === null ? null : bool(c < 0); };
      case "<=": return (rows, ctx) => { const c = sqlCompare(l(rows, ctx), r(rows, ctx)); return c === null ? null : bool(c <= 0); };
      case ">": return (rows, ctx) => { const c = sqlCompare(l(rows, ctx), r(rows, ctx)); return c === null ? null : bool(c > 0); };
      case ">=": return (rows, ctx) => { const c = sqlCompare(l(rows, ctx), r(rows, ctx)); return c === null ? null : bool(c >= 0); };
      case "IS": case "IS NOT DISTINCT FROM": return (rows, ctx) => bool(sqlIs(l(rows, ctx), r(rows, ctx)));
      case "IS NOT": case "IS DISTINCT FROM": return (rows, ctx) => bool(!sqlIs(l(rows, ctx), r(rows, ctx)));
    }
  }

  private compileLike(e: Extract<BoundExpr, { kind: "like" }>): CompiledExpr {
    const text = this.compile(e.left), pattern = this.compile(e.right), not = e.not;
    const escape = e.escape ? this.compile(e.escape) : undefined;
    const negate = (v: Value): Value => (v === null || !not ? v : v === 1n ? 0n : 1n);
    if (e.op === "GLOB") {
      if (e.right.kind === "literal" && typeof e.right.value === "string") {
        const re = compileGlob(e.right.value);
        return (rows, ctx) => { const t = text(rows, ctx); return t === null ? null : negate(bool(re.test(toText(t)))); };
      }
      return (rows, ctx) => negate(sqlGlob(pattern(rows, ctx), text(rows, ctx)));
    }
    if (e.op === "LIKE" && e.right.kind === "literal" && typeof e.right.value === "string" && (!e.escape || (e.escape.kind === "literal" && typeof e.escape.value === "string"))) {
      const re = compileLike(e.right.value, e.escape && e.escape.kind === "literal" ? String(e.escape.value) : undefined);
      return (rows, ctx) => { const t = text(rows, ctx); return t === null ? null : negate(bool(re.test(toText(t)))); };
    }
    if (escape) return (rows, ctx) => negate(sqlLike(pattern(rows, ctx), text(rows, ctx), escape(rows, ctx)));
    return (rows, ctx) => negate(sqlLike(pattern(rows, ctx), text(rows, ctx)));
  }

  private compileIn(e: Extract<BoundExpr, { kind: "in" }>): CompiledExpr {
    const x = this.compile(e.expr), not = e.not;
    const negate = (v: Value): Value => (v === null || !not ? v : v === 1n ? 0n : 1n);
    if (e.list) {
      const items = e.list.map((i) => this.compile(i));
      const constant = e.list.every((i) => isConstantExpr(i, this.functions));
      if (constant) {
        const values = items.map((f) => f(EMPTY_ROWS, CONSTANT_CONTEXT));
        if (values.length === 0) return () => negate(0n);
        return (rows, ctx) => negate(sqlIn(x(rows, ctx), values));
      }
      const buf: Value[] = new Array<Value>(items.length);
      return (rows, ctx) => {
        for (let i = 0; i < items.length; i++) buf[i] = items[i]!(rows, ctx);
        return negate(sqlIn(x(rows, ctx), buf));
      };
    }
    const sub = e.subquery!;
    return (rows, ctx) => {
      const needle = x(rows, ctx);
      const result = ctx.evalSubquery(sub, rows);
      if (result.length === 0) return negate(0n);
      if (needle === null) return null;
      const n = normalize(needle);
      let sawNull = false;
      for (const row of result) {
        const v = row[0] ?? null;
        if (v === null) { sawNull = true; continue; }
        if (compareValues(n, normalize(v)) === 0) return negate(1n);
      }
      return sawNull ? null : negate(0n);
    };
  }

  private compileCase(e: Extract<BoundExpr, { kind: "case" }>): CompiledExpr {
    const whens = e.whens.map((w) => this.compile(w.when));
    const thens = e.whens.map((w) => this.compile(w.then));
    const elseF = e.else ? this.compile(e.else) : undefined;
    const n = whens.length;
    if (e.operand) {
      const op = this.compile(e.operand);
      return (rows, ctx) => {
        const v = op(rows, ctx);
        if (v !== null) {
          const nv = normalize(v);
          for (let i = 0; i < n; i++) {
            const w = whens[i]!(rows, ctx);
            if (w !== null && compareValues(nv, normalize(w)) === 0) return thens[i]!(rows, ctx);
          }
        }
        return elseF ? elseF(rows, ctx) : null;
      };
    }
    return (rows, ctx) => {
      for (let i = 0; i < n; i++) if (truthy(whens[i]!(rows, ctx)) === true) return thens[i]!(rows, ctx);
      return elseF ? elseF(rows, ctx) : null;
    };
  }

  private compileFunction(name: string, args: CompiledExpr[]): CompiledExpr {
    const fn = this.functions.getScalar(name);
    if (!fn) throw new BasaltError(`no such function: ${name}`, "ERROR");
    const call = fn.call;
    switch (args.length) {
      case 0: { const buf: Value[] = []; return (_rows, ctx) => call(buf, ctx); }
      case 1: { const a0 = args[0]!; const buf: Value[] = [null]; return (rows, ctx) => { buf[0] = a0(rows, ctx); return call(buf, ctx); }; }
      case 2: { const a0 = args[0]!, a1 = args[1]!; const buf: Value[] = [null, null]; return (rows, ctx) => { buf[0] = a0(rows, ctx); buf[1] = a1(rows, ctx); return call(buf, ctx); }; }
      case 3: {
        const a0 = args[0]!, a1 = args[1]!, a2 = args[2]!; const buf: Value[] = [null, null, null];
        return (rows, ctx) => { buf[0] = a0(rows, ctx); buf[1] = a1(rows, ctx); buf[2] = a2(rows, ctx); return call(buf, ctx); };
      }
      default: {
        const n = args.length; const buf: Value[] = new Array<Value>(n).fill(null);
        return (rows, ctx) => { for (let i = 0; i < n; i++) buf[i] = args[i]!(rows, ctx); return call(buf, ctx); };
      }
    }
  }
}

function andValues(a: boolean | null, b: boolean | null): Value {
  if (a === false || b === false) return 0n;
  if (a === null || b === null) return null;
  return 1n;
}
function orValues(a: boolean | null, b: boolean | null): Value {
  if (a === true || b === true) return 1n;
  if (a === null || b === null) return null;
  return 0n;
}
