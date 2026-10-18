import { describe, expect, it } from "vitest";
import {
  builtinFunctions, compileGlob, compileLike, sqlGlob, sqlLike, sqlPrintf, sqlTypeName, castValue, toText, type AggregateFunction, type WindowFrameContext,
} from "../../src/exec/functions.js";
import type { Value } from "../../src/core/types.js";

/** Run an aggregate over rows of argument arrays. */
function agg(name: string, rows: Value[][]): Value {
  const fn = builtinFunctions.getAggregate(name) as AggregateFunction<unknown>;
  const state = fn.init();
  for (const r of rows) fn.step(state, r);
  return fn.final(state);
}
const col = (...vs: Value[]): Value[][] => vs.map((v) => [v]);

describe("aggregate functions", () => {
  it("count counts non-null values; count(*) counts rows", () => {
    expect(agg("count", col(1n, null, "a", 0n))).toBe(3n);
    expect(agg("count", [[], [], []])).toBe(3n); // star form: empty args
    expect(agg("count", [])).toBe(0n);
    expect(agg("count", col(null, null))).toBe(0n);
  });
  it("sum keeps bigint for integers, NULL when empty, overflows to REAL", () => {
    expect(agg("sum", col(1n, 2n, 3n))).toBe(6n);
    expect(agg("sum", col(null, null))).toBeNull();
    expect(agg("sum", [])).toBeNull();
    expect(agg("sum", col(1n, 2.5))).toBe(3.5);
    expect(agg("sum", col("3", "abc", 2.5))).toBe(5.5);
    expect(agg("sum", col("3", "4"))).toBe(7n);
    expect(agg("sum", col(9223372036854775807n, 1n))).toBe(9223372036854775808);
    expect(agg("sum", col(9223372036854775807n, 1.0))).toBe(9223372036854775808);
    expect(agg("sum", col(9223372036854775807n, 1n, -1n))).toBe(9223372036854775807); // once overflowed, stays REAL
    expect(agg("sum", col(true, true))).toBe(2n);
  });
  it("total is always REAL and 0.0 when empty", () => {
    expect(agg("total", [])).toBe(0);
    expect(agg("total", col(null))).toBe(0);
    expect(agg("total", col(1n, 2n))).toBe(3);
    expect(typeof agg("total", col(1n))).toBe("number");
  });
  it("avg is REAL, NULL when empty, ignores NULLs", () => {
    expect(agg("avg", col(1n, 2n))).toBe(1.5);
    expect(agg("avg", col(1n, null, 2n, 3n))).toBe(2);
    expect(agg("avg", col(null))).toBeNull();
    expect(agg("avg", col("abc", "3"))).toBe(1.5);
    expect(typeof agg("avg", col(4n))).toBe("number");
  });
  it("min/max use the total order and skip NULLs", () => {
    expect(agg("min", col(1n, "a", null, 0.5))).toBe(0.5);
    expect(agg("max", col(1n, "a", null, 0.5))).toBe("a");
    expect(agg("min", col(null, null))).toBeNull();
    expect(agg("max", [])).toBeNull();
    expect(agg("min", col(2n, 2.0))).toBe(2n); // ties keep the first (SQLite minmaxStep)
    expect(agg("max", col(2.0, 2n))).toBe(2.0);
    expect(agg("max", col("a", "B", "b"))).toBe("b");
    const blob = new Uint8Array([0]);
    expect(agg("max", col("zzz", blob))).toBe(blob);
  });
  it("group_concat joins text with the separator, skipping NULLs", () => {
    expect(agg("group_concat", col(1n, null, "b"))).toBe("1,b");
    expect(agg("group_concat", [[1n, "-"], [2n, "-"], [3n, "-"]])).toBe("1-2-3");
    expect(agg("group_concat", [[1n, "-"], [2n, "+"]])).toBe("1+2"); // separator of the current row
    expect(agg("group_concat", col(null))).toBeNull();
    expect(agg("group_concat", [])).toBeNull();
    expect(agg("group_concat", [[1.5, null], [2n, null]])).toBe("1.52");
    expect(agg("string_agg", [["a", ";"], ["b", ";"]])).toBe("a;b");
  });
  it("aggregate states are independent", () => {
    const fn = builtinFunctions.getAggregate("sum")!;
    const a = fn.init(), b = fn.init();
    fn.step(a, [1n]); fn.step(b, [10n]); fn.step(a, [2n]);
    expect(fn.final(a)).toBe(3n);
    expect(fn.final(b)).toBe(10n);
  });
});

describe("window functions", () => {
  /** Build a frame context for a partition described by argument rows and ORDER BY keys. */
  function ctxFor(args: Value[][], keys: Value[], index: number, frame?: [number, number], isExcluded?: (i: number) => boolean): WindowFrameContext {
    const size = args.length;
    let peerStart = index, peerEnd = index;
    while (peerStart > 0 && keys[peerStart - 1] === keys[index]) peerStart--;
    while (peerEnd < size - 1 && keys[peerEnd + 1] === keys[index]) peerEnd++;
    let peerGroup = 0;
    for (let i = 1; i <= peerStart; i++) if (keys[i] !== keys[i - 1]) peerGroup++;
    return { args, size, index, frameStart: frame ? frame[0] : 0, frameEnd: frame ? frame[1] : size - 1, peerStart, peerEnd, peerGroup, isExcluded };
  }
  const run = (name: string, args: Value[][], keys: Value[], frame?: (i: number) => [number, number], isExcluded?: (i: number) => boolean): Value[] => {
    const fn = builtinFunctions.getWindow(name)!;
    return args.map((_, i) => fn.compute(ctxFor(args, keys, i, frame?.(i), isExcluded)));
  };
  const keys = [10n, 20n, 20n, 30n, 30n, 30n, 40n];
  const args = keys.map((k) => [k]);

  it("row_number, rank, dense_rank, percent_rank, cume_dist", () => {
    expect(run("row_number", args, keys)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
    expect(run("rank", args, keys)).toEqual([1n, 2n, 2n, 4n, 4n, 4n, 7n]);
    expect(run("dense_rank", args, keys)).toEqual([1n, 2n, 2n, 3n, 3n, 3n, 4n]);
    expect(run("percent_rank", args, keys)).toEqual([0, 1 / 6, 1 / 6, 3 / 6, 3 / 6, 3 / 6, 1]);
    expect(run("cume_dist", args, keys)).toEqual([1 / 7, 3 / 7, 3 / 7, 6 / 7, 6 / 7, 6 / 7, 1]);
    expect(run("percent_rank", [[1n]], [1n])).toEqual([0]);
    expect(run("cume_dist", [[1n]], [1n])).toEqual([1]);
  });
  it("ntile distributes rows like SQLite", () => {
    const n = (buckets: bigint, size: number) => run("ntile", Array.from({ length: size }, () => [buckets]), Array.from({ length: size }, (_, i) => BigInt(i)));
    expect(n(2n, 7)).toEqual([1n, 1n, 1n, 1n, 2n, 2n, 2n]);
    expect(n(3n, 7)).toEqual([1n, 1n, 1n, 2n, 2n, 3n, 3n]);
    expect(n(4n, 2)).toEqual([1n, 2n]);
    expect(n(1n, 3)).toEqual([1n, 1n, 1n]);
    expect(n(3n, 9)).toEqual([1n, 1n, 1n, 2n, 2n, 2n, 3n, 3n, 3n]);
    expect(() => n(0n, 2)).toThrow(/positive integer/);
    expect(run("ntile", [[null]], [1n])).toEqual([null]);
  });
  it("lag and lead with offsets and defaults", () => {
    const vals = ["a", "b", "c", "d"].map((v, i) => [v, 1n, "dflt"] as Value[]);
    const k = [1n, 2n, 3n, 4n];
    expect(run("lag", vals, k)).toEqual(["dflt", "a", "b", "c"]);
    expect(run("lead", vals, k)).toEqual(["b", "c", "d", "dflt"]);
    const one = ["a", "b", "c"].map((v) => [v] as Value[]);
    expect(run("lag", one, [1n, 2n, 3n])).toEqual([null, "a", "b"]);
    expect(run("lead", one, [1n, 2n, 3n])).toEqual(["b", "c", null]);
    const two = ["a", "b", "c", "d"].map((v) => [v, 2n] as Value[]);
    expect(run("lag", two, k)).toEqual([null, null, "a", "b"]);
    expect(run("lead", two, k)).toEqual(["c", "d", null, null]);
    expect(run("lag", [["a", null]], [1n])).toEqual([null]);
  });
  it("first_value, last_value, nth_value honour frame bounds and EXCLUDE", () => {
    const vals = ["a", "b", "c", "d", "e"].map((v) => [v, 2n] as Value[]);
    const k = [1n, 2n, 3n, 4n, 5n];
    // running frame: UNBOUNDED PRECEDING .. CURRENT ROW
    expect(run("first_value", vals, k, (i) => [0, i])).toEqual(["a", "a", "a", "a", "a"]);
    expect(run("last_value", vals, k, (i) => [0, i])).toEqual(["a", "b", "c", "d", "e"]);
    expect(run("nth_value", vals, k, (i) => [0, i])).toEqual([null, "b", "b", "b", "b"]);
    // sliding frame 1 PRECEDING .. 1 FOLLOWING
    expect(run("last_value", vals, k, (i) => [Math.max(0, i - 1), Math.min(4, i + 1)])).toEqual(["b", "c", "d", "e", "e"]);
    // empty frame
    expect(run("first_value", vals, k, () => [3, 2])).toEqual([null, null, null, null, null]);
    // EXCLUDE CURRENT ROW
    expect(run("first_value", vals, k, () => [0, 4], (i) => i === 0)).toEqual(["b", "b", "b", "b", "b"]);
    expect(() => run("nth_value", [["a", 0n]], [1n])).toThrow(/positive integer/);
    expect(run("nth_value", [["a", null]], [1n])).toEqual([null]);
  });
});

describe("function registry", () => {
  it("looks up metadata for the binder", () => {
    const min = builtinFunctions.lookup("MIN")!;
    expect(min.scalar).toEqual({ minArgs: 2, maxArgs: -1 });
    expect(min.aggregate).toEqual({ minArgs: 1, maxArgs: 1 });
    expect(min.window).toBeUndefined();
    expect(min.returnType(["INTEGER"], "aggregate")).toBe("INTEGER");
    const count = builtinFunctions.lookup("count")!;
    expect(count.scalar).toBeUndefined();
    expect(count.returnType([], "aggregate")).toBe("INTEGER");
    const rn = builtinFunctions.lookup("row_number")!;
    expect(rn.window).toEqual({ minArgs: 0, maxArgs: 0 });
    expect(rn.scalar).toBeUndefined();
    expect(builtinFunctions.lookup("nope")).toBeUndefined();
    expect(builtinFunctions.lookup("random")!.deterministic).toBe(false);
    expect(builtinFunctions.lookup("length")!.deterministic).toBe(true);
    expect(builtinFunctions.lookup("printf")!.scalar).toEqual({ minArgs: 1, maxArgs: -1 });
  });
  it("covers every builtin named in the contract", () => {
    const scalars = ["length", "upper", "lower", "substr", "substring", "instr", "replace", "trim", "ltrim", "rtrim", "abs", "round", "floor", "ceil", "ceiling", "sqrt", "pow", "power", "mod", "min", "max", "typeof", "hex", "unhex", "random", "printf", "format", "char", "unicode", "quote", "zeroblob", "nullif", "coalesce", "iif", "sign", "exp", "ln", "log", "log10", "log2", "pi", "trunc", "sin", "cos", "tan"];
    for (const s of scalars) expect(builtinFunctions.getScalar(s), s).toBeDefined();
    for (const a of ["count", "sum", "total", "avg", "min", "max", "group_concat"]) expect(builtinFunctions.getAggregate(a), a).toBeDefined();
    for (const w of ["row_number", "rank", "dense_rank", "ntile", "lag", "lead", "first_value", "last_value", "nth_value", "percent_rank", "cume_dist"]) expect(builtinFunctions.getWindow(w), w).toBeDefined();
  });
});

describe("pattern matching helpers", () => {
  it("compileLike builds anchored ASCII-case-insensitive regexes", () => {
    expect(compileLike("a%").test("ABC")).toBe(true);
    expect(compileLike("a%").test("xabc")).toBe(false);
    expect(compileLike("a_c").test("a\u{1F600}c")).toBe(true);
    expect(compileLike("a.c").test("abc")).toBe(false);
    expect(compileLike("50!%", "!").test("50%")).toBe(true);
    expect(compileLike("50!%", "!").test("500")).toBe(false);
    expect(compileLike("a!", "!").test("a")).toBe(true); // trailing escape is dropped
    expect(() => compileLike("a", "xy")).toThrow(/single character/);
    expect(compileLike("a%")).toBe(compileLike("a%")); // cached
  });
  it("compileGlob handles classes, ranges and negation", () => {
    expect(compileGlob("a[b-d]e").test("ace")).toBe(true);
    expect(compileGlob("a[^b-d]e").test("ace")).toBe(false);
    expect(compileGlob("a[]]e").test("a]e")).toBe(true);
    expect(compileGlob("a[").test("a[")).toBe(false);
    expect(compileGlob("*.txt").test("file.txt")).toBe(true);
    expect(compileGlob("*.txt").test("file.TXT")).toBe(false);
    expect(compileGlob("?").test("\u{1F600}")).toBe(true);
  });
  it("sqlLike / sqlGlob return SQL integers or NULL", () => {
    expect(sqlLike("a%", "abc")).toBe(1n);
    expect(sqlLike("a%", null)).toBeNull();
    expect(sqlLike(null, "abc")).toBeNull();
    expect(sqlLike("a%", "abc", null)).toBeNull();
    expect(sqlLike(5n, 5n)).toBe(1n);
    expect(sqlGlob("a*", "abc")).toBe(1n);
    expect(sqlGlob("a*", "ABC")).toBe(0n);
    expect(sqlGlob(null, "x")).toBeNull();
  });
});

describe("printf and coercion helpers", () => {
  it("formats with SQLite's 16-significant-digit limit and half-up rounding", () => {
    expect(sqlPrintf("%.20f", [0.1])).toBe("0.10000000000000000000");
    expect(sqlPrintf("%!.20f", [0.1])).toBe("0.1000000000000000055");
    expect(sqlPrintf("%.2f", [2.675])).toBe("2.67");
    expect(sqlPrintf("%.2f", [0.125])).toBe("0.13");
    expect(sqlPrintf("%.0f", [0.5])).toBe("1");
    expect(sqlPrintf("%.3f", [1234567890123456789])).toBe("1234567890123457000.000");
    expect(sqlPrintf("%e", [0])).toBe("0.000000e+00");
    expect(sqlPrintf("%g", [0])).toBe("0");
    expect(sqlPrintf("%.3e", [99999])).toBe("1.000e+05");
    expect(sqlPrintf("%g", [99999.9])).toBe("99999.9");
    expect(sqlPrintf("%g", [999999.5])).toBe("1e+06");
    expect(sqlPrintf("%f", [Infinity])).toBe("Inf");
    expect(sqlPrintf("%5.1f", [-Infinity])).toBe(" -Inf");
    expect(sqlPrintf("%d", [Infinity])).toBe("9223372036854775807");
  });
  it("handles missing and extra arguments", () => {
    expect(sqlPrintf("%d %d", [1n])).toBe("1 0");
    expect(sqlPrintf("%s", [1n, 2n, 3n])).toBe("1");
    expect(sqlPrintf("%*d|%-*d|", [5n, 1n, 3n, 2n])).toBe("    1|2  |");
    expect(sqlPrintf("%.*f", [2n, 3.14159])).toBe("3.14");
  });
  it("coerces values", () => {
    expect(sqlTypeName(true)).toBe("integer");
    expect(sqlTypeName(1.5)).toBe("real");
    expect(sqlTypeName(new Uint8Array())).toBe("blob");
    expect(toText(new Uint8Array([0xc3, 0xa9]))).toBe("é");
    expect(castValue(null, "TEXT")).toBeNull();
    expect(castValue("12abc", "INTEGER")).toBe(12n);
    expect(castValue(1e30, "INTEGER")).toBe(9223372036854775807n);
    expect(castValue(-1e30, "INTEGER")).toBe(-9223372036854775808n);
    expect(castValue(NaN, "INTEGER")).toBe(0n);
    expect(castValue("0x10", "REAL")).toBe(0);
    expect(castValue(true, "REAL")).toBe(1);
    expect(castValue(true, "BOOLEAN")).toBe(1n);
    expect(castValue("1.0", "NUMERIC")).toBe(1n);
    expect(castValue("1e400", "NUMERIC")).toBe(Infinity);
    expect(castValue(2, "NULL")).toBeNull();
    expect(Array.from(castValue(1n, "BLOB") as Uint8Array)).toEqual([49]);
  });
});
