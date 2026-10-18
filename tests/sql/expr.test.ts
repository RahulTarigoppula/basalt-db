import { describe, expect, it } from "vitest";
import { parseExpression, parseOne } from "../../src/sql/parser.js";
import { bind, bindExpression } from "../../src/sql/binder.js";
import { MemorySchemaProvider } from "../../src/sql/schema-provider.js";
import { builtinFunctions, formatReal, parseNumericPrefix, toNumeric, truthy } from "../../src/exec/functions.js";
import {
  CONSTANT_CONTEXT, compileExpr, compilePredicate, evaluateConstant, isConstantExpr, sqlAdd, sqlCompare, sqlDiv, sqlIn, sqlIs, sqlMod, sqlMul, sqlShiftLeft, sqlSub,
  type EvalContext,
} from "../../src/exec/expr.js";
import type { BoundSelectCore, BoundSelectStatement, BoundSubquery } from "../../src/sql/bound.js";
import type { Row, Value } from "../../src/core/types.js";
import { BasaltError } from "../../src/core/errors.js";
import { GOLDEN } from "./expr-golden.js";

const schema = new MemorySchemaProvider();
schema.addTable({
  name: "t", rowidColumn: -1,
  columns: [
    { name: "i", type: "INTEGER", notNull: false, primaryKey: false, unique: false },
    { name: "r", type: "REAL", notNull: false, primaryKey: false, unique: false },
    { name: "s", type: "TEXT", notNull: false, primaryKey: false, unique: false },
    { name: "n", type: "INTEGER", notNull: false, primaryKey: false, unique: false },
  ],
});
schema.addTable({ name: "u", rowidColumn: -1, columns: [{ name: "v", type: "INTEGER", notNull: false, primaryKey: false, unique: false }] });

/** Evaluate a constant expression end-to-end. */
function ev(sql: string): Value {
  return compileExpr(bindExpression(parseExpression(sql), schema, builtinFunctions))([], CONSTANT_CONTEXT);
}

/** Compile the first projection of `SELECT <expr> FROM t` and evaluate it against a row of t. */
function evRow(sql: string, row: Row, ctx: EvalContext = CONSTANT_CONTEXT): Value {
  const st = bind(parseOne(`SELECT ${sql} FROM t`), schema, builtinFunctions) as BoundSelectStatement;
  const core = st.select.body as BoundSelectCore;
  return compileExpr(core.projections[0]!.expr)([row], ctx);
}

function same(actual: Value, expected: Value): void {
  if (expected instanceof Uint8Array) {
    expect(actual).toBeInstanceOf(Uint8Array);
    expect(Array.from(actual as Uint8Array)).toEqual(Array.from(expected));
  } else if (typeof expected === "number" && Number.isNaN(expected)) expect(Number.isNaN(actual)).toBe(true);
  else expect(actual).toBe(expected);
}

describe("expression evaluator matches SQLite goldens", () => {
  for (const [group, cases] of Object.entries(GOLDEN)) {
    describe(group, () => {
      for (const [sql, expected] of cases) {
        it(sql, () => same(ev(sql), expected));
      }
    });
  }
});

describe("three-valued logic on columns", () => {
  const row = (i: Value, r: Value, s: Value, n: Value = null): Row => [i, r, s, n];
  it("AND/OR with NULL columns", () => {
    expect(evRow("i > 0 AND n IS NULL", row(1n, 1.5, "x"))).toBe(1n);
    expect(evRow("n > 0 AND i > 0", row(1n, 1.5, "x"))).toBeNull();
    expect(evRow("n > 0 AND i < 0", row(1n, 1.5, "x"))).toBe(0n);
    expect(evRow("n > 0 OR i > 0", row(1n, 1.5, "x"))).toBe(1n);
    expect(evRow("n > 0 OR i < 0", row(1n, 1.5, "x"))).toBeNull();
    expect(evRow("NOT (n > 0)", row(1n, 1.5, "x"))).toBeNull();
    expect(evRow("n = n", row(1n, 1.5, "x"))).toBeNull();
    expect(evRow("n IS n", row(1n, 1.5, "x"))).toBe(1n);
    expect(evRow("n IS NOT i", row(1n, 1.5, "x"))).toBe(1n);
    expect(evRow("coalesce(n, i, 0)", row(7n, 1.5, "x"))).toBe(7n);
  });
  it("short-circuits AND/OR so the right side is not evaluated when unnecessary", () => {
    // i / n would be NULL (division by zero is NULL, so it would not throw anyway); use a counting ctx via a subquery hook
    let calls = 0;
    const ctx: EvalContext = { params: [], evalSubquery: () => { calls++; return [[1n]]; } };
    const st = bind(parseOne("SELECT i = 0 AND (SELECT v FROM u) = 1 FROM t"), schema, builtinFunctions) as BoundSelectStatement;
    const f = compileExpr((st.select.body as BoundSelectCore).projections[0]!.expr);
    expect(f([[1n, null, null, null]], ctx)).toBe(0n);
    expect(calls).toBe(0);
    expect(f([[0n, null, null, null]], ctx)).toBe(1n);
    expect(calls).toBe(1);
  });
  it("IN with NULL columns and lists", () => {
    expect(evRow("i IN (1, 2, n)", row(1n, 0, ""))).toBe(1n);
    expect(evRow("i IN (2, 3, n)", row(1n, 0, ""))).toBeNull();
    expect(evRow("i NOT IN (2, 3, n)", row(1n, 0, ""))).toBeNull();
    expect(evRow("n IN (1, 2)", row(1n, 0, ""))).toBeNull();
    expect(evRow("n IN ()", row(1n, 0, ""))).toBe(0n);
    expect(evRow("i IN (r, s)", row(2n, 2, "2"))).toBe(1n);
    expect(evRow("s IN (i, r)", row(2n, 2, "2"))).toBe(0n); // text never equals a number
  });
  it("BETWEEN with NULL bounds", () => {
    expect(evRow("i BETWEEN n AND 5", row(3n, 0, ""))).toBeNull();
    expect(evRow("i BETWEEN n AND 2", row(3n, 0, ""))).toBe(0n);
    expect(evRow("i NOT BETWEEN n AND 2", row(3n, 0, ""))).toBe(1n);
    expect(evRow("n BETWEEN 1 AND 2", row(3n, 0, ""))).toBeNull();
  });
  it("CASE with NULL operand and WHEN NULL never matches", () => {
    expect(evRow("CASE n WHEN NULL THEN 'a' ELSE 'b' END", row(1n, 0, ""))).toBe("b");
    expect(evRow("CASE n WHEN 1 THEN 'a' END", row(1n, 0, ""))).toBeNull();
    expect(evRow("CASE WHEN n THEN 'a' WHEN i THEN 'b' END", row(1n, 0, ""))).toBe("b");
    expect(evRow("CASE i WHEN r THEN 'eq' ELSE 'ne' END", row(2n, 2, ""))).toBe("eq");
  });
  it("comparisons across types use the total order", () => {
    expect(evRow("i < s", row(1n, 0, "a"))).toBe(1n);
    expect(evRow("r < s", row(1n, 1e300, ""))).toBe(1n);
    expect(evRow("i = r", row(3n, 3, ""))).toBe(1n);
    expect(evRow("i < r", row(3n, 3.5, ""))).toBe(1n);
    expect(evRow("s > i", row(3n, 0, "0"))).toBe(1n);
  });
  it("arithmetic and concat on columns", () => {
    expect(evRow("i + r", row(1n, 0.5, ""))).toBe(1.5);
    expect(evRow("i + i", row(9223372036854775807n, 0, ""))).toBe(18446744073709552000);
    expect(evRow("i * 2", row(4611686018427387904n, 0, ""))).toBe(9223372036854775808);
    expect(evRow("i / n", row(1n, 0, ""))).toBeNull();
    expect(evRow("i / i", row(0n, 0, ""))).toBeNull();
    expect(evRow("i % 3", row(-7n, 0, ""))).toBe(-1n);
    expect(evRow("s + i", row(1n, 0, "41"))).toBe(42n);
    expect(evRow("s * 1", row(1n, 0, "2.5"))).toBe(2.5);
    expect(evRow("s || i || r", row(1n, 2.5, "x"))).toBe("x12.5");
    expect(evRow("n || 'x'", row(1n, 2.5, "x"))).toBeNull();
    expect(evRow("-i", row(-9223372036854775808n, 0, ""))).toBe(9223372036854775808);
    expect(evRow("~i", row(0n, 0, ""))).toBe(-1n);
    expect(evRow("i << i", row(1n, 0, ""))).toBe(2n);
  });
  it("LIKE/GLOB with non-constant patterns and ESCAPE", () => {
    expect(evRow("s LIKE i || '%'", row(1n, 0, "123"))).toBe(1n);
    expect(evRow("s LIKE 'a_c'", row(1n, 0, "AXC"))).toBe(1n);
    expect(evRow("s GLOB 'a?c'", row(1n, 0, "AXC"))).toBe(0n);
    expect(evRow("s LIKE '50!%' ESCAPE '!'", row(1n, 0, "50%"))).toBe(1n);
    expect(evRow("s LIKE '50!%' ESCAPE '!'", row(1n, 0, "50x"))).toBe(0n);
    expect(evRow("s LIKE n", row(1n, 0, "a"))).toBeNull();
    expect(evRow("n LIKE 'a'", row(1n, 0, "a"))).toBeNull();
    expect(evRow("s NOT LIKE 'A%'", row(1n, 0, "abc"))).toBe(0n);
    expect(evRow("s LIKE s", row(1n, 0, "a%"))).toBe(1n);
    expect(evRow("s LIKE '%' || s || '%'", row(1n, 0, "mid"))).toBe(1n);
    expect(() => evRow("s LIKE 'a' ESCAPE 'xy'", row(1n, 0, "a"))).toThrow(/ESCAPE expression must be a single character/);
  });
  it("CAST on columns", () => {
    expect(evRow("CAST(s AS INTEGER)", row(0n, 0, " 42abc"))).toBe(42n);
    expect(evRow("CAST(r AS INTEGER)", row(0n, -3.9, ""))).toBe(-3n);
    expect(evRow("CAST(i AS TEXT)", row(12n, 0, ""))).toBe("12");
    expect(evRow("CAST(r AS TEXT)", row(0n, 2.5, ""))).toBe("2.5");
    expect(evRow("CAST(s AS REAL)", row(0n, 0, "1e2x"))).toBe(100);
    expect(evRow("CAST(n AS TEXT)", row(0n, 0, ""))).toBeNull();
    expect(evRow("typeof(CAST(s AS NUMERIC))", row(0n, 0, "12"))).toBe("integer");
    expect(evRow("typeof(CAST(s AS NUMERIC))", row(0n, 0, "12.5"))).toBe("real");
    expect(Array.from(evRow("CAST(s AS BLOB)", row(0n, 0, "AB")) as Uint8Array)).toEqual([65, 66]);
  });
  it("functions receive column values", () => {
    expect(evRow("upper(s) || length(s)", row(0n, 0, "héllo"))).toBe("HéLLO5");
    expect(evRow("substr(s, i, 2)", row(2n, 0, "hello"))).toBe("el");
    expect(evRow("round(r, i)", row(1n, 2.25, ""))).toBe(2.3);
    expect(evRow("printf('%05.1f|%s|%d', r, s, i)", row(7n, 3.14159, "x"))).toBe("003.1|x|7");
    expect(evRow("iif(i > 0, s, 'neg')", row(-1n, 0, "x"))).toBe("neg");
    expect(evRow("nullif(i, r)", row(1n, 1, "x"))).toBeNull();
    expect(evRow("max(i, r, s)", row(1n, 2, "0"))).toBe("0");
    expect(evRow("min(i, r)", row(1n, 0.5, "0"))).toBe(0.5);
    expect(evRow("abs(i)", row(-5n, 0, ""))).toBe(5n);
    expect(evRow("hex(s)", row(0n, 0, "AB"))).toBe("4142");
    expect(evRow("quote(s)", row(0n, 0, "it's"))).toBe("'it''s'");
    expect(evRow("typeof(i) || typeof(r) || typeof(s) || typeof(n)", row(1n, 1, "1"))).toBe("integerrealtextnull");
  });
  it("abs(INT64_MIN) raises integer overflow like SQLite", () => {
    expect(() => evRow("abs(i)", row(-9223372036854775808n, 0, ""))).toThrow(/integer overflow/);
  });
  it("boolean values coerce to integers", () => {
    expect(evRow("i = 1", row(true, 0, ""))).toBe(1n);
    expect(evRow("i + 1", row(true, 0, ""))).toBe(2n);
    expect(evRow("NOT i", row(false, 0, ""))).toBe(1n);
    expect(evRow("typeof(i)", row(true, 0, ""))).toBe("integer");
    expect(evRow("i || ''", row(true, 0, ""))).toBe("1");
    expect(evRow("CASE i WHEN 1 THEN 'y' END", row(true, 0, ""))).toBe("y");
  });
  it("reads missing columns as NULL and rejects missing relations", () => {
    expect(evRow("n", [1n, 2, "x"])).toBeNull();
    const st = bind(parseOne("SELECT i FROM t"), schema, builtinFunctions) as BoundSelectStatement;
    const f = compileExpr((st.select.body as BoundSelectCore).projections[0]!.expr);
    expect(() => f([], CONSTANT_CONTEXT)).toThrow(BasaltError);
  });
});

describe("parameters, subqueries and context hooks", () => {
  it("reads parameters by slot", () => {
    const st = bind(parseOne("SELECT ? + :x, ?1 FROM t"), schema, builtinFunctions) as BoundSelectStatement;
    const core = st.select.body as BoundSelectCore;
    const ctx: EvalContext = { params: [10n, 5n], evalSubquery: () => [] };
    expect(compileExpr(core.projections[0]!.expr)([[null, null, null, null]], ctx)).toBe(15n);
    expect(compileExpr(core.projections[1]!.expr)([[]], ctx)).toBe(10n);
    expect(compileExpr(core.projections[0]!.expr)([[]], { params: [], evalSubquery: () => [] })).toBeNull();
  });
  it("delegates subqueries to the context with the outer rows", () => {
    const st = bind(parseOne("SELECT (SELECT v FROM u WHERE v > t.i), EXISTS (SELECT 1 FROM u), i IN (SELECT v FROM u), i NOT IN (SELECT v FROM u) FROM t"), schema, builtinFunctions) as BoundSelectStatement;
    const core = st.select.body as BoundSelectCore;
    const seen: { sub: BoundSubquery; rows: Row[] }[] = [];
    const data: Row[] = [[1n], [null], [3n]];
    const ctx: EvalContext = { params: [], evalSubquery: (sub, rows) => { seen.push({ sub, rows }); return data; } };
    const outer: Row[] = [[2n, 0, "x", null]];
    expect(compileExpr(core.projections[0]!.expr)(outer, ctx)).toBe(1n); // first row, first column
    expect(seen[0]!.rows).toBe(outer);
    expect(seen[0]!.sub.correlated).toBe(true);
    expect(compileExpr(core.projections[1]!.expr)(outer, ctx)).toBe(1n);
    expect(compileExpr(core.projections[2]!.expr)(outer, ctx)).toBeNull(); // 2 not found, NULL present
    expect(compileExpr(core.projections[2]!.expr)([[3n, 0, "x", null]], ctx)).toBe(1n);
    expect(compileExpr(core.projections[3]!.expr)([[3n, 0, "x", null]], ctx)).toBe(0n);
    expect(compileExpr(core.projections[3]!.expr)(outer, ctx)).toBeNull();
    const empty: EvalContext = { params: [], evalSubquery: () => [] };
    expect(compileExpr(core.projections[0]!.expr)(outer, empty)).toBeNull();
    expect(compileExpr(core.projections[1]!.expr)(outer, empty)).toBe(0n);
    expect(compileExpr(core.projections[2]!.expr)(outer, empty)).toBe(0n);
    expect(compileExpr(core.projections[3]!.expr)(outer, empty)).toBe(1n);
    expect(compileExpr(core.projections[2]!.expr)([[null, 0, "x", null]], empty)).toBe(0n); // NULL IN (empty) is false
  });
  it("uses the seeded random and clock hooks", () => {
    const ctx: EvalContext = { params: [], evalSubquery: () => [], random: () => 0.5, now: () => Date.UTC(2024, 0, 2, 3, 4, 5) };
    const f = compileExpr(bindExpression(parseExpression("random()"), schema, builtinFunctions));
    expect(f([], ctx)).toBe(f([], ctx)); // deterministic with a fixed generator
    expect(typeof f([], ctx)).toBe("bigint");
    expect(compileExpr(bindExpression(parseExpression("current_timestamp"), schema, builtinFunctions))([], ctx)).toBe("2024-01-02 03:04:05");
    expect(compileExpr(bindExpression(parseExpression("current_date"), schema, builtinFunctions))([], ctx)).toBe("2024-01-02");
    expect(compileExpr(bindExpression(parseExpression("current_time"), schema, builtinFunctions))([], ctx)).toBe("03:04:05");
  });
  it("throws for planner-only nodes unless hooks are provided", () => {
    const st = bind(parseOne("SELECT count(*), rowid FROM t"), schema, builtinFunctions) as BoundSelectStatement;
    const core = st.select.body as BoundSelectCore;
    expect(() => compileExpr(core.projections[0]!.expr)).toThrow(/must be rewritten by the planner/);
    expect(() => compileExpr(core.projections[1]!.expr)).toThrow(/rowid reference must be rewritten/);
    const f = compileExpr(core.projections[0]!.expr, { aggregate: (node) => () => BigInt(node.index + 41) });
    expect(f([], CONSTANT_CONTEXT)).toBe(41n);
    const g = compileExpr(core.projections[1]!.expr, { rowid: () => () => 99n });
    expect(g([], CONSTANT_CONTEXT)).toBe(99n);
  });
});

describe("constant folding and helpers", () => {
  it("detects constant expressions", () => {
    const c = (sql: string) => isConstantExpr(bindExpression(parseExpression(sql), schema, builtinFunctions));
    expect(c("1 + 2 * 3")).toBe(true);
    expect(c("upper('a') || length('bc')")).toBe(true);
    expect(c("random()")).toBe(false);
    expect(c("?")).toBe(false);
    expect(c("(SELECT 1)")).toBe(false);
    expect(c("CASE WHEN 1 THEN 2 END")).toBe(true);
    expect(evaluateConstant(bindExpression(parseExpression("1 + 2 * 3"), schema, builtinFunctions))).toBe(7n);
  });
  it("folds constants at compile time but keeps runtime semantics", () => {
    const st = bind(parseOne("SELECT i + (1 + 2) FROM t"), schema, builtinFunctions) as BoundSelectStatement;
    const f = compileExpr((st.select.body as BoundSelectCore).projections[0]!.expr);
    expect(f([[1n, 0, "", null]], CONSTANT_CONTEXT)).toBe(4n);
    const g = compileExpr(bindExpression(parseExpression("1 / 0"), schema, builtinFunctions), { constantFolding: false });
    expect(g([], CONSTANT_CONTEXT)).toBeNull();
  });
  it("compilePredicate treats NULL as false", () => {
    const p = compilePredicate(bindExpression(parseExpression("NULL"), schema, builtinFunctions));
    expect(p([], CONSTANT_CONTEXT)).toBe(false);
    expect(compilePredicate(bindExpression(parseExpression("'1x'"), schema, builtinFunctions))([], CONSTANT_CONTEXT)).toBe(true);
    expect(compilePredicate(bindExpression(parseExpression("0.0"), schema, builtinFunctions))([], CONSTANT_CONTEXT)).toBe(false);
  });
  it("exposes arithmetic helpers with promotion", () => {
    expect(sqlAdd(1n, 2n)).toBe(3n);
    expect(sqlAdd(9223372036854775807n, 1n)).toBe(9223372036854775808);
    expect(sqlSub(-9223372036854775808n, 1n)).toBe(-9223372036854775808 - 1);
    expect(sqlMul(2n, 1.5)).toBe(3);
    expect(sqlDiv(7n, 2n)).toBe(3n);
    expect(sqlDiv(7n, 0n)).toBeNull();
    expect(sqlDiv(7, 0)).toBeNull();
    expect(sqlDiv(-9223372036854775808n, -1n)).toBe(9223372036854775808);
    expect(sqlMod(7n, 0n)).toBeNull();
    expect(sqlMod(7.5, 2)).toBe(1);
    expect(sqlShiftLeft(1n, 70n)).toBe(0n);
    expect(sqlAdd(null, 1n)).toBeNull();
    expect(sqlCompare(1n, 1.0)).toBe(0);
    expect(sqlCompare(null, 1n)).toBeNull();
    expect(sqlCompare(true, 1n)).toBe(0);
    expect(sqlIs(null, null)).toBe(true);
    expect(sqlIs(null, 0n)).toBe(false);
    expect(sqlIn(1n, [2n, null])).toBeNull();
    expect(sqlIn(1n, [])).toBe(0n);
    expect(sqlIn(null, [])).toBe(0n);
  });
  it("coercion helpers", () => {
    expect(truthy("0.0")).toBe(false);
    expect(truthy("1e2")).toBe(true);
    expect(truthy(new Uint8Array([1]))).toBe(false);
    expect(truthy(null)).toBeNull();
    expect(toNumeric(" 12 ")).toBe(12n);
    expect(toNumeric("12.")).toBe(12);
    expect(toNumeric("-.5e1")).toBe(-5);
    expect(toNumeric("99999999999999999999")).toBe(1e20);
    expect(parseNumericPrefix("abc")).toBeNull();
    expect(parseNumericPrefix("  7x")).toEqual({ value: 7n, end: 3 });
    expect(formatReal(1)).toBe("1.0");
    expect(formatReal(1e21)).toBe("1.0e+21");
    expect(formatReal(-1.5e-10)).toBe("-1.5e-10");
    expect(formatReal(123456.789)).toBe("123456.789");
    expect(formatReal(Infinity)).toBe("Inf");
    expect(formatReal(-Infinity)).toBe("-Inf");
    expect(formatReal(-0)).toBe("0.0");
  });
});
