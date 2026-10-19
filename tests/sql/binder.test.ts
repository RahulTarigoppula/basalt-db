import { describe, expect, it } from "vitest";
import { parseOne } from "../../src/sql/parser.js";
import { bind } from "../../src/sql/binder.js";
import { MemorySchemaProvider } from "../../src/sql/schema-provider.js";
import { builtinFunctions } from "../../src/exec/functions.js";
import { BindError } from "../../src/core/errors.js";
import type {
  BoundColumnRef, BoundCreateIndex, BoundCreateTable, BoundExpr, BoundInsert, BoundSelect, BoundSelectCore, BoundSelectStatement, BoundStatement, BoundUpdate,
} from "../../src/sql/bound.js";
import { affinityOf, mapColumnRefs, walkBoundExpr } from "../../src/sql/bound.js";

function schema(): MemorySchemaProvider {
  const s = new MemorySchemaProvider();
  s.addTable({
    name: "users", rowidColumn: 0,
    columns: [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true, unique: true },
      { name: "name", type: "TEXT", notNull: true, primaryKey: false, unique: false },
      { name: "age", type: "INTEGER", notNull: false, primaryKey: false, unique: false, defaultSql: "18" },
    ],
  });
  s.addTable({
    name: "orders", rowidColumn: -1,
    columns: [
      { name: "id", type: "INTEGER", notNull: false, primaryKey: false, unique: false },
      { name: "user_id", type: "INTEGER", notNull: false, primaryKey: false, unique: false },
      { name: "total", type: "REAL", notNull: false, primaryKey: false, unique: false },
    ],
  });
  s.addTable({ name: "t1", rowidColumn: -1, columns: [{ name: "a", type: "INTEGER", notNull: false, primaryKey: false, unique: false }, { name: "b", type: "TEXT", notNull: false, primaryKey: false, unique: false }] });
  s.addTable({ name: "t2", rowidColumn: -1, columns: [{ name: "a", type: "INTEGER", notNull: false, primaryKey: false, unique: false }, { name: "c", type: "TEXT", notNull: false, primaryKey: false, unique: false }] });
  s.addIndex({ name: "idx_orders_user", table: "orders", columns: [1], unique: false });
  s.addView({ name: "adults", sql: "SELECT id, name FROM users WHERE age >= 18" });
  return s;
}

const S = schema();
function b(sql: string, s: MemorySchemaProvider = S): BoundStatement {
  return bind(parseOne(sql), s, builtinFunctions, { sql });
}
function sel(sql: string, s: MemorySchemaProvider = S): BoundSelect { return (b(sql, s) as BoundSelectStatement).select; }
function core(sql: string, s: MemorySchemaProvider = S): BoundSelectCore { return sel(sql, s).body as BoundSelectCore; }
function err(sql: string): string {
  try { b(sql); } catch (e) { expect(e).toBeInstanceOf(BindError); return (e as Error).message; }
  throw new Error(`expected BindError for ${sql}`);
}
const colRef = (e: BoundExpr): BoundColumnRef => { expect(e.kind).toBe("column"); return e as BoundColumnRef; };

describe("binder: column resolution", () => {
  it("resolves unqualified and qualified columns to (relation, column)", () => {
    const c = core("SELECT name, users.age, o.total FROM users, orders AS o");
    expect(c.relations.map((r) => r.alias)).toEqual(["users", "o"]);
    expect(colRef(c.projections[0]!.expr)).toMatchObject({ depth: 0, relation: 0, rel: 0, column: 1, name: "name", dataType: "TEXT" });
    expect(colRef(c.projections[1]!.expr)).toMatchObject({ relation: 0, column: 2, dataType: "INTEGER" });
    expect(colRef(c.projections[2]!.expr)).toMatchObject({ relation: 1, rel: 1, column: 2, dataType: "REAL" });
    expect(sel("SELECT name, users.age, o.total FROM users, orders AS o").columns.map((x) => x.name)).toEqual(["name", "age", "total"]);
  });

  it("is case-insensitive for table and column names", () => {
    const c = core("SELECT NAME, USERS.Age FROM Users");
    expect(colRef(c.projections[0]!.expr).column).toBe(1);
    expect(colRef(c.projections[1]!.expr).column).toBe(2);
  });

  it("reports unknown tables and columns", () => {
    expect(err("SELECT * FROM nope")).toMatch(/no such table: nope at 1:15/);
    expect(err("SELECT nope FROM users")).toMatch(/no such column: nope at 1:8/);
    expect(err("SELECT x.id FROM users")).toMatch(/no such column: x.id/);
    expect(err("SELECT users.nope FROM users")).toMatch(/no such column: users.nope/);
    expect(err("SELECT *")).toMatch(/no tables specified/);
    expect(err("SELECT x.* FROM users")).toMatch(/no such table: x/);
  });

  it("detects ambiguous columns and duplicate aliases", () => {
    expect(err("SELECT id FROM users, orders")).toMatch(/ambiguous column name: id/);
    expect(err("SELECT a FROM t1, t2")).toMatch(/ambiguous column name: a/);
    expect(() => b("SELECT t1.a, t2.a FROM t1, t2")).not.toThrow();
    expect(err("SELECT * FROM users, users")).toMatch(/ambiguous table name or alias: users/);
    expect(err("SELECT * FROM users u, orders u")).toMatch(/ambiguous table name or alias: u/);
  });

  it("expands * and t.* in FROM order", () => {
    const s = sel("SELECT * FROM users JOIN orders ON users.id = orders.user_id");
    expect(s.columns.map((c) => c.name)).toEqual(["id", "name", "age", "id", "user_id", "total"]);
    expect(s.columns.map((c) => c.type)).toEqual(["INTEGER", "TEXT", "INTEGER", "INTEGER", "INTEGER", "REAL"]);
    const c = sel("SELECT orders.*, users.name FROM users, orders").body as BoundSelectCore;
    expect(c.projections.map((p) => p.name)).toEqual(["id", "user_id", "total", "name"]);
    expect(colRef(c.projections[0]!.expr)).toMatchObject({ relation: 1, column: 0 });
  });

  it("names result columns from alias, column name or source text", () => {
    const s = sel("SELECT id AS ident, name, age + 1, count(*), 'x' FROM users");
    expect(s.columns.map((c) => c.name)).toEqual(["ident", "name", "age + 1", "count(*)", "'x'"]);
  });

  it("resolves rowid aliases", () => {
    const c = core("SELECT rowid, _rowid_, oid FROM users");
    // users has INTEGER PRIMARY KEY -> rowid is column 0
    expect(colRef(c.projections[0]!.expr).column).toBe(0);
    const c2 = core("SELECT rowid FROM orders");
    expect(c2.projections[0]!.expr.kind).toBe("rowid");
    expect(c2.projections[0]!.expr).toMatchObject({ relation: 0, rel: 0, dataType: "INTEGER" });
  });

  it("binds parameters with SQLite numbering", () => {
    const st = b("SELECT ?, ?, :a, ?5, :a, @b, $c FROM users WHERE id = ?") as BoundSelectStatement;
    const idx = (st.select.body as BoundSelectCore).projections.map((p) => (p.expr as { index: number }).index);
    expect(idx).toEqual([0, 1, 2, 4, 2, 5, 6]);
    expect(st.parameters.count).toBe(8); // ?5 sets the high-water mark; trailing ? is slot 8
    expect(st.parameters.names[2]).toBe(":a");
    expect(st.parameters.names[5]).toBe("@b");
    expect(st.parameters.names[6]).toBe("$c");
    expect(st.parameters.names[0]).toBeUndefined();
    const where = (st.select.body as BoundSelectCore).where as { right: { index: number } };
    expect(where.right.index).toBe(7);
  });
});

describe("binder: joins", () => {
  it("binds ON conditions against both sides", () => {
    const c = core("SELECT 1 FROM users u JOIN orders o ON u.id = o.user_id AND o.total > 10");
    expect(c.from!.kind).toBe("join");
    const j = c.from as Extract<typeof c.from, { kind: "join" }>;
    expect(j.joinType).toBe("INNER");
    expect(j.condition).toMatchObject({ kind: "binary", op: "AND" });
    expect(j.using).toEqual([]);
  });

  it("USING dedupes the join column in * and resolves bare names to the left copy", () => {
    const s = sel("SELECT * FROM t1 JOIN t2 USING (a)");
    expect(s.columns.map((c) => c.name)).toEqual(["a", "b", "c"]);
    const c = s.body as BoundSelectCore;
    const j = c.from as Extract<typeof c.from, { kind: "join" }>;
    expect(j.using).toHaveLength(1);
    expect(j.using[0]).toMatchObject({ name: "a", left: { relation: 0, column: 0 }, right: { relation: 1, column: 0 } });
    expect(j.condition).toMatchObject({ kind: "binary", op: "=" });
    expect(c.relations[1]!.columns[0]!.hidden).toBe(true);
    // bare `a` -> left side; qualified t2.a still works
    const c2 = core("SELECT a, t2.a FROM t1 JOIN t2 USING (a)");
    expect(colRef(c2.projections[0]!.expr)).toMatchObject({ relation: 0, column: 0 });
    expect(colRef(c2.projections[1]!.expr)).toMatchObject({ relation: 1, column: 0 });
  });

  it("NATURAL JOIN derives the common columns", () => {
    const s = sel("SELECT * FROM t1 NATURAL JOIN t2");
    expect(s.columns.map((c) => c.name)).toEqual(["a", "b", "c"]);
    const j = (s.body as BoundSelectCore).from as Extract<BoundSelectCore["from"], { kind: "join" }>;
    expect(j.using.map((u) => u.name)).toEqual(["a"]);
  });

  it("RIGHT JOIN USING keeps the right-hand copy", () => {
    const c = core("SELECT * FROM t1 RIGHT JOIN t2 USING (a)");
    expect(c.relations[0]!.columns[0]!.hidden).toBe(true);
    expect(c.relations[1]!.columns[0]!.hidden).toBe(false);
    expect(c.projections.map((p) => p.name)).toEqual(["b", "a", "c"]);
  });

  it("rejects USING columns missing on one side", () => {
    expect(err("SELECT * FROM t1 JOIN t2 USING (b)")).toMatch(/cannot join using column b/);
  });

  it("chains USING across three tables", () => {
    const s = sel("SELECT * FROM t1 JOIN t2 USING (a) JOIN t1 AS t3 USING (a)");
    expect(s.columns.map((c) => c.name)).toEqual(["a", "b", "c", "b"]);
  });

  it("binds derived tables and references their columns", () => {
    const c = core("SELECT sub.n, total FROM (SELECT name AS n, age FROM users) AS sub, orders");
    expect(c.relations[0]).toMatchObject({ kind: "subquery", alias: "sub" });
    expect(c.relations[0]!.columns.map((x) => x.name)).toEqual(["n", "age"]);
    expect(colRef(c.projections[0]!.expr)).toMatchObject({ relation: 0, column: 0, dataType: "TEXT" });
    expect(colRef(c.projections[1]!.expr)).toMatchObject({ relation: 1, column: 2 });
    expect(err("SELECT sub.x FROM (SELECT 1 AS n) sub")).toMatch(/no such column: sub.x/);
  });

  it("binds VALUES as a derived table", () => {
    const c = core("SELECT column1, v.column2 FROM (VALUES (1, 'a'), (2, 'b')) AS v");
    expect(c.relations[0]!.columns.map((x) => [x.name, x.type])).toEqual([["column1", "INTEGER"], ["column2", "TEXT"]]);
  });

  it("expands views by binding their definition", () => {
    const c = core("SELECT name FROM adults WHERE id > 3");
    expect(c.relations[0]).toMatchObject({ kind: "view", name: "adults" });
    expect(c.relations[0]!.columns.map((x) => x.name)).toEqual(["id", "name"]);
    const inner = (c.relations[0] as { select: BoundSelect }).select.body as BoundSelectCore;
    expect(inner.where).toBeDefined();
  });

  it("validates INDEXED BY", () => {
    expect(() => b("SELECT * FROM orders INDEXED BY idx_orders_user")).not.toThrow();
    expect(err("SELECT * FROM orders INDEXED BY nope")).toMatch(/no such index: nope/);
  });
});

describe("binder: subqueries and correlation", () => {
  it("marks uncorrelated subqueries", () => {
    const c = core("SELECT (SELECT max(total) FROM orders) FROM users");
    const sq = c.projections[0]!.expr as Extract<BoundExpr, { kind: "subquery" }>;
    expect(sq.subquery.correlated).toBe(false);
    expect(sq.subquery.outerRefs).toEqual([]);
    expect(c.outerRefs).toEqual([]);
  });

  it("detects correlated references with depth and flat rel index", () => {
    const c = core("SELECT name FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)");
    const ex = c.where as Extract<BoundExpr, { kind: "exists" }>;
    expect(ex.subquery.correlated).toBe(true);
    expect(ex.subquery.outerRefs).toHaveLength(1);
    // inside the subquery: relation 0 = orders; the outer users row sits at rows[1]
    expect(ex.subquery.outerRefs[0]).toMatchObject({ depth: 1, relation: 0, rel: 1, column: 0, name: "id", table: "u" });
    const innerCore = ex.subquery.select.body as BoundSelectCore;
    expect(innerCore.outerRefs).toHaveLength(1);
    const cmp = innerCore.where as Extract<BoundExpr, { kind: "binary" }>;
    expect(colRef(cmp.left)).toMatchObject({ depth: 0, rel: 0, column: 1 });
    expect(colRef(cmp.right)).toMatchObject({ depth: 1, rel: 1, column: 0 });
    expect(c.outerRefs).toEqual([]); // the outer query itself is not correlated
  });

  it("tracks two levels of correlation", () => {
    const c = core("SELECT 1 FROM users u WHERE id IN (SELECT user_id FROM orders o WHERE total > (SELECT max(a) FROM t1 WHERE t1.a = u.id AND t1.b = o.id))");
    const inq = c.where as Extract<BoundExpr, { kind: "in" }>;
    const mid = inq.subquery!.select.body as BoundSelectCore;
    // middle level has two relations' worth of outer context: its own 'o' plus 'u' from the outermost
    expect(inq.subquery!.outerRefs.map((r) => [r.depth, r.rel, r.name])).toEqual([[1, 1, "id"]]);
    const innerScalar = (mid.where as Extract<BoundExpr, { kind: "binary" }>).right as Extract<BoundExpr, { kind: "subquery" }>;
    const refs = innerScalar.subquery.outerRefs.map((r) => [r.depth, r.rel, r.table, r.name]);
    // from the innermost scope: t1 is rows[0]; o (middle) is rows[1]; u (outermost) is rows[2]
    expect(refs).toEqual(expect.arrayContaining([[2, 2, "u", "id"], [1, 1, "o", "id"]]));
  });

  it("validates subquery column counts", () => {
    expect(err("SELECT (SELECT id, name FROM users)")).toMatch(/sub-select returns 2 columns - expected 1/);
    expect(err("SELECT 1 WHERE 1 IN (SELECT id, name FROM users)")).toMatch(/sub-select returns 2 columns/);
  });

  it("binds IN tablename as IN (SELECT * FROM tablename)", () => {
    const c = core("SELECT 1 WHERE 5 IN (SELECT a FROM t1)");
    expect((c.where as { subquery: unknown }).subquery).toBeDefined();
    expect(err("SELECT 1 WHERE 5 IN t1")).toMatch(/sub-select returns 2 columns/);
  });

  it("binds derived tables that reference an outer query scope", () => {
    const c = core("SELECT 1 FROM users u WHERE EXISTS (SELECT 1 FROM (SELECT u.id AS x) d WHERE d.x > 0)");
    const ex = c.where as Extract<BoundExpr, { kind: "exists" }>;
    expect(ex.subquery.correlated).toBe(true);
  });
});

describe("binder: aggregates, GROUP BY, HAVING, ORDER BY", () => {
  it("collects aggregates and allows bare columns (SQLite-lenient)", () => {
    const c = core("SELECT name, count(*), sum(age), max(age) - min(age) FROM users GROUP BY name HAVING count(*) > 1");
    expect(c.aggregates.map((a) => a.name)).toEqual(["count", "sum", "max", "min", "count"]);
    expect(c.aggregates[0]).toMatchObject({ star: true, index: 0, dataType: "INTEGER" });
    expect(c.aggregates[1]).toMatchObject({ dataType: "INTEGER" });
    expect(c.groupBy).toHaveLength(1);
    expect(c.having).toMatchObject({ kind: "binary", left: { kind: "aggregate", index: 4 } });
    expect(c.projections[1]!.expr).toMatchObject({ kind: "aggregate", index: 0 });
    expect(() => b("SELECT name, count(*) FROM users")).not.toThrow(); // bare column with aggregate
  });

  it("binds DISTINCT and FILTER aggregates and arity", () => {
    const c = core("SELECT count(DISTINCT name), sum(age) FILTER (WHERE age > 10), group_concat(name, ';') FROM users");
    expect(c.aggregates[0]).toMatchObject({ distinct: true });
    expect(c.aggregates[1]!.filter).toBeDefined();
    expect(c.aggregates[2]!.args).toHaveLength(2);
    expect(err("SELECT count(1, 2) FROM users")).toMatch(/wrong number of arguments to function count/);
    expect(err("SELECT sum() FROM users")).toMatch(/wrong number of arguments to function sum/);
    expect(err("SELECT sum(*) FROM users")).toMatch(/sum\(\*\) is not valid/);
    expect(err("SELECT count(DISTINCT id, name) FROM users")).toMatch(/DISTINCT aggregates must have exactly one argument/);
  });

  it("distinguishes scalar min/max from aggregate min/max by arity", () => {
    const c = core("SELECT min(age), max(age, 1, 2) FROM users");
    expect(c.projections[0]!.expr.kind).toBe("aggregate");
    expect(c.projections[1]!.expr.kind).toBe("function");
    expect(c.aggregates).toHaveLength(1);
  });

  it("rejects misplaced and nested aggregates", () => {
    expect(err("SELECT 1 FROM users WHERE count(*) > 1")).toMatch(/misuse of aggregate function count/);
    expect(err("SELECT 1 FROM users GROUP BY count(*)")).toMatch(/misuse of aggregate function count/);
    expect(err("SELECT sum(count(*)) FROM users")).toMatch(/misuse of aggregate function count/);
    expect(err("SELECT 1 FROM users u JOIN orders o ON sum(u.id) = 1")).toMatch(/misuse of aggregate/);
    expect(err("SELECT 1 FROM users HAVING 1")).toMatch(/HAVING clause on a non-aggregate query/);
    expect(() => b("SELECT 1 FROM users HAVING count(*) > 0")).not.toThrow();
  });

  it("resolves GROUP BY / ORDER BY ordinals and aliases", () => {
    const s = sel("SELECT name AS n, count(*) AS c FROM users GROUP BY 1 ORDER BY c DESC, 1");
    const c = s.body as BoundSelectCore;
    expect(colRef(c.groupBy[0]!)).toMatchObject({ column: 1 });
    expect(s.orderBy[0]).toMatchObject({ desc: true, nullsFirst: false, projectionIndex: 1 });
    expect(s.orderBy[0]!.expr).toMatchObject({ kind: "aggregate", index: 0 });
    expect(s.orderBy[1]).toMatchObject({ projectionIndex: 0, nullsFirst: true });
    expect(err("SELECT name FROM users ORDER BY 3")).toMatch(/ORDER BY term out of range - should be between 1 and 1/);
    expect(err("SELECT name FROM users GROUP BY 2")).toMatch(/GROUP BY term out of range/);
    const s2 = sel("SELECT name AS n FROM users GROUP BY n HAVING n <> 'x'");
    expect(colRef((s2.body as BoundSelectCore).groupBy[0]!).column).toBe(1);
  });

  it("resolves ORDER BY nulls placement defaults", () => {
    const s = sel("SELECT age FROM users ORDER BY age, age DESC, age NULLS LAST, age DESC NULLS FIRST");
    expect(s.orderBy.map((o) => [o.desc, o.nullsFirst])).toEqual([[false, true], [true, false], [false, false], [true, true]]);
  });

  it("ORDER BY on compound selects uses result column references", () => {
    const s = sel("SELECT id, name FROM users UNION ALL SELECT a, b FROM t1 ORDER BY name DESC, 1");
    expect(s.orderBy[0]!.expr).toMatchObject({ kind: "resultColumn", index: 1 });
    expect(s.orderBy[1]!.expr).toMatchObject({ kind: "resultColumn", index: 0 });
    expect(err("SELECT id FROM users UNION SELECT a FROM t1 ORDER BY nope")).toMatch(/does not match any column in the result set/);
    expect(err("SELECT id FROM users UNION SELECT a, b FROM t1")).toMatch(/do not have the same number of result columns/);
  });

  it("rejects column references in LIMIT", () => {
    expect(err("SELECT 1 FROM users LIMIT age")).toMatch(/column references are not allowed in a LIMIT clause/);
  });
});

describe("binder: window functions", () => {
  it("binds window specs and collects window calls", () => {
    const c = core("SELECT row_number() OVER (PARTITION BY age ORDER BY name), sum(age) OVER w, lag(name, 1, 'x') OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM users WINDOW w AS (ORDER BY id DESC)");
    expect(c.windows.map((w) => w.name)).toEqual(["row_number", "sum", "lag"]);
    expect(c.windows[0]).toMatchObject({ isAggregate: false, index: 0, dataType: "INTEGER" });
    expect(c.windows[0]!.spec.partitionBy).toHaveLength(1);
    expect(c.windows[1]).toMatchObject({ isAggregate: true });
    expect(c.windows[1]!.spec.orderBy[0]).toMatchObject({ desc: true });
    expect(c.windows[2]!.spec.frame).toMatchObject({ unit: "ROWS", start: { kind: "preceding" }, end: { kind: "currentRow" } });
    expect(c.windows[2]!.dataType).toBe("TEXT");
    expect(c.aggregates).toHaveLength(0);
  });

  it("resolves named window chains", () => {
    const c = core("SELECT first_value(name) OVER (w2 ROWS UNBOUNDED PRECEDING) FROM users WINDOW w1 AS (PARTITION BY age), w2 AS (w1 ORDER BY id)");
    expect(c.windows[0]!.spec.partitionBy).toHaveLength(1);
    expect(c.windows[0]!.spec.orderBy).toHaveLength(1);
    expect(c.windows[0]!.spec.frame!.unit).toBe("ROWS");
    expect(err("SELECT sum(age) OVER nope FROM users")).toMatch(/no such window: nope/);
    expect(err("SELECT sum(age) OVER (w1 PARTITION BY id) FROM users WINDOW w1 AS (PARTITION BY age)")).toMatch(/cannot override PARTITION clause/);
  });

  it("validates window usage", () => {
    expect(err("SELECT 1 FROM users WHERE row_number() OVER () = 1")).toMatch(/misuse of window function row_number/);
    expect(err("SELECT length(name) OVER () FROM users")).toMatch(/length\(\) may not be used as a window function/);
    expect(err("SELECT row_number() FROM users")).toMatch(/row_number\(\) may only be used as a window function/);
    expect(err("SELECT lag(name, 1, 2, 3) OVER () FROM users")).toMatch(/wrong number of arguments to function lag/);
    expect(err("SELECT sum(age) OVER (ROWS BETWEEN -1 PRECEDING AND CURRENT ROW) FROM users")).toMatch(/non-negative integer/);
    expect(err("SELECT sum(age) OVER (ROWS BETWEEN age PRECEDING AND CURRENT ROW) FROM users")).toMatch(/column references are not allowed|frame offset must be a constant/);
    expect(err("SELECT sum(age) OVER (ROWS BETWEEN CURRENT ROW AND 1 PRECEDING) FROM users")).toMatch(/unsupported frame specification/);
    expect(err("SELECT sum(age) OVER (RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM users")).toMatch(/RANGE with offset/);
    expect(err("SELECT sum(sum(age) OVER ()) FROM users")).toMatch(/misuse/);
    expect(() => b("SELECT count(*) OVER (), sum(age) OVER (ORDER BY id RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM users")).not.toThrow();
  });
});

describe("binder: CTEs", () => {
  it("binds non-recursive CTEs and shadows tables", () => {
    const s = sel("WITH users(x) AS (SELECT 1) SELECT x FROM users");
    expect(s.ctes).toHaveLength(1);
    expect(s.ctes[0]!.columns.map((c) => c.name)).toEqual(["x"]);
    expect((s.body as BoundSelectCore).relations[0]).toMatchObject({ kind: "cte", name: "users", recursiveRef: false });
    expect(err("WITH c(x, y) AS (SELECT 1) SELECT * FROM c")).toMatch(/c has 2 column names but 1 values/);
    expect(err("WITH c AS (SELECT 1), c AS (SELECT 2) SELECT * FROM c")).toMatch(/duplicate WITH table name: c/);
  });

  it("CTEs can reference earlier CTEs and are visible in subqueries", () => {
    const s = sel("WITH a AS (SELECT 1 AS v), bb AS (SELECT v + 1 AS w FROM a) SELECT (SELECT w FROM bb), v FROM a");
    expect(s.ctes.map((c) => c.name)).toEqual(["a", "bb"]);
    expect(s.columns.map((c) => c.type)).toEqual(["INTEGER", "INTEGER"]);
  });

  it("binds a recursive CTE and records its shape", () => {
    const s = sel("WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 10) SELECT x FROM cnt");
    const cte = s.ctes[0]!;
    expect(cte.recursive).toBeDefined();
    expect(cte.recursive!.unionAll).toBe(true);
    expect(cte.recursive!.anchor.kind).toBe("core");
    const rec = cte.recursive!.recursiveTerm as BoundSelectCore;
    expect(rec.relations[0]).toMatchObject({ kind: "cte", recursiveRef: true });
    expect(cte.columns.map((c) => [c.name, c.type])).toEqual([["x", "INTEGER"]]);
    expect(cte.select.body.kind).toBe("compound");
    // self reference works without the RECURSIVE keyword too (as in SQLite)
    expect(() => b("WITH cnt(x) AS (SELECT 1 UNION SELECT x + 1 FROM cnt WHERE x < 3) SELECT * FROM cnt")).not.toThrow();
  });

  it("validates recursive CTE shape", () => {
    expect(err("WITH RECURSIVE c(x) AS (SELECT x + 1 FROM c) SELECT * FROM c")).toMatch(/must be of the form "anchor UNION \[ALL\] recursive-term"/);
    expect(err("WITH RECURSIVE c(x) AS (SELECT 1 INTERSECT SELECT x FROM c) SELECT * FROM c")).toMatch(/must be of the form/);
    expect(err("WITH RECURSIVE c(x) AS (SELECT x FROM c UNION ALL SELECT 1) SELECT * FROM c")).toMatch(/anchor of recursive CTE c may not reference c/);
    expect(err("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT a.x FROM c a, c b2) SELECT * FROM c")).toMatch(/must reference c exactly once/);
    expect(err("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT count(*) FROM c) SELECT * FROM c")).toMatch(/may not use aggregate or window functions/);
    expect(err("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x, 2 FROM c) SELECT * FROM c")).toMatch(/do not have the same number of result columns/);
  });

  it("binds WITH on INSERT/UPDATE/DELETE", () => {
    expect(() => b("WITH src AS (SELECT 1 AS a, 'x' AS b) INSERT INTO t1 SELECT * FROM src")).not.toThrow();
    expect(() => b("WITH v AS (SELECT 1 AS n) UPDATE t1 SET a = (SELECT n FROM v)")).not.toThrow();
    expect(() => b("WITH v AS (SELECT 1 AS n) DELETE FROM t1 WHERE a IN (SELECT n FROM v)")).not.toThrow();
  });
});

describe("binder: type inference", () => {
  const types = (sql: string): string[] => sel(sql).columns.map((c) => c.type);
  it("infers literal and operator types", () => {
    expect(types("SELECT 1, 1.5, 'a', x'00', NULL, TRUE")).toEqual(["INTEGER", "REAL", "TEXT", "BLOB", "NULL", "INTEGER"]);
    expect(types("SELECT 1 + 2, 1 + 2.5, 1 / 2, 'a' || 'b', 1 < 2, 1 AND 0, NOT 1, -1, -1.5, ~1")).toEqual(["INTEGER", "REAL", "INTEGER", "TEXT", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "REAL", "INTEGER"]);
    expect(types("SELECT ?, 1 + ?, 'a' + 1")).toEqual(["ANY", "ANY", "ANY"]);
  });
  it("infers CASE, CAST and function types", () => {
    expect(types("SELECT CASE WHEN 1 THEN 1 ELSE 2 END, CASE WHEN 1 THEN 1 ELSE 'x' END, CASE WHEN 1 THEN 1 ELSE 2.0 END, CASE WHEN 1 THEN 1 END")).toEqual(["INTEGER", "ANY", "REAL", "INTEGER"]);
    expect(types("SELECT CAST(1 AS TEXT), CAST('1' AS INT), CAST(1 AS REAL), CAST(1 AS BLOB), CAST(1 AS NUMERIC), CAST('1' AS NUMERIC)")).toEqual(["TEXT", "INTEGER", "REAL", "BLOB", "INTEGER", "ANY"]);
    expect(types("SELECT length('a'), upper('a'), abs(-1), abs(-1.5), round(1), typeof(1), hex(1), coalesce(NULL, 1), coalesce(1, 'a'), min(1, 2), min(1, 'a')")).toEqual(["INTEGER", "TEXT", "INTEGER", "REAL", "REAL", "TEXT", "TEXT", "INTEGER", "ANY", "INTEGER", "ANY"]);
    expect(types("SELECT count(*), sum(age), sum(total), avg(age), total(age), min(name), group_concat(name) FROM users, orders")).toEqual(["INTEGER", "INTEGER", "REAL", "REAL", "REAL", "TEXT", "TEXT"]);
  });
  it("propagates column types through subqueries and compounds", () => {
    expect(types("SELECT * FROM (SELECT age + 1 AS n, name FROM users)")).toEqual(["INTEGER", "TEXT"]);
    expect(types("SELECT id FROM users UNION SELECT total FROM orders")).toEqual(["REAL"]);
    expect(types("SELECT id FROM users UNION SELECT name FROM users")).toEqual(["ANY"]);
    expect(types("SELECT id FROM users UNION SELECT a FROM t1")).toEqual(["INTEGER"]);
  });
  it("affinity rules follow SQLite", () => {
    expect(affinityOf("INTEGER")).toBe("INTEGER");
    expect(affinityOf("BIGINT")).toBe("INTEGER");
    expect(affinityOf("UNSIGNED BIG INT")).toBe("INTEGER");
    expect(affinityOf("VARCHAR(20)")).toBe("TEXT");
    expect(affinityOf("CLOB")).toBe("TEXT");
    expect(affinityOf("BLOB")).toBe("BLOB");
    expect(affinityOf(undefined)).toBe("BLOB");
    expect(affinityOf("DOUBLE PRECISION")).toBe("REAL");
    expect(affinityOf("FLOAT")).toBe("REAL");
    expect(affinityOf("NUMERIC(10,2)")).toBe("NUMERIC");
    expect(affinityOf("DATE")).toBe("NUMERIC");
    expect(affinityOf("BOOLEAN")).toBe("BOOLEAN");
    expect(affinityOf("CHARINT")).toBe("INTEGER"); // INT wins, like SQLite
  });
});

describe("binder: functions", () => {
  it("checks arity and existence of scalar functions", () => {
    expect(err("SELECT nope(1)")).toMatch(/no such function: nope/);
    expect(err("SELECT length()")).toMatch(/wrong number of arguments to function length/);
    expect(err("SELECT length(1, 2)")).toMatch(/wrong number of arguments to function length/);
    expect(err("SELECT substr('a')")).toMatch(/wrong number of arguments to function substr/);
    expect(err("SELECT coalesce(1)")).toMatch(/wrong number of arguments to function coalesce/);
    expect(err("SELECT length(DISTINCT 'a')")).toMatch(/DISTINCT is only valid for aggregate functions/);
    expect(() => b("SELECT printf('%d %d %d', 1, 2, 3), coalesce(1, 2, 3, 4), LENGTH('x'), Upper('x')")).not.toThrow();
  });
  it("rejects REGEXP/MATCH and RAISE outside triggers", () => {
    expect(err("SELECT 'a' REGEXP 'b'")).toMatch(/no such function: REGEXP/);
    expect(err("SELECT RAISE(ABORT, 'x')")).toMatch(/RAISE\(\) may only be used within a trigger-program/);
  });
  it("ignores COLLATE (binary collation only)", () => {
    const c = core("SELECT name COLLATE NOCASE FROM users");
    expect(c.projections[0]!.expr.kind).toBe("column");
  });
});

describe("binder: INSERT / UPDATE / DELETE", () => {
  it("binds INSERT ... VALUES with explicit columns and defaults", () => {
    const i = b("INSERT INTO users (name, id) VALUES ('a', 1), ('b', ?)") as BoundInsert;
    expect(i.columns).toEqual([1, 0]);
    expect(i.source.kind).toBe("values");
    expect((i.source as { rows: BoundExpr[][] }).rows).toHaveLength(2);
    expect(i.defaults[0]).toBeNull();
    expect(i.defaults[1]).toBeNull();
    expect(i.defaults[2]).toMatchObject({ kind: "literal", value: 18n });
    expect(i.parameters.count).toBe(1);
  });
  it("binds INSERT ... SELECT, DEFAULT VALUES and OR clauses", () => {
    const i = b("INSERT OR REPLACE INTO t1 SELECT id, name FROM users") as BoundInsert;
    expect(i.or).toBe("REPLACE");
    expect(i.source.kind).toBe("select");
    expect(i.columns).toEqual([0, 1]);
    expect((b("INSERT INTO t1 DEFAULT VALUES") as BoundInsert).source.kind).toBe("defaults");
  });
  it("validates INSERT column counts and names", () => {
    expect(err("INSERT INTO t1 VALUES (1)")).toMatch(/table t1 has 2 columns but 1 values were supplied/);
    expect(err("INSERT INTO t1 (a) VALUES (1, 2)")).toMatch(/table t1 has 1 columns specified but 2 values were supplied/);
    expect(err("INSERT INTO t1 SELECT 1, 2, 3")).toMatch(/3 values were supplied/);
    expect(err("INSERT INTO t1 (a, a) VALUES (1, 2)")).toMatch(/column a specified more than once/);
    expect(err("INSERT INTO t1 (zz) VALUES (1)")).toMatch(/table t1 has no column named zz/);
    expect(err("INSERT INTO nope VALUES (1)")).toMatch(/no such table: nope/);
    expect(err("INSERT INTO adults VALUES (1, 'x')")).toMatch(/cannot modify adults because it is a view/);
    expect(err("INSERT INTO t1 VALUES (a, 1)")).toMatch(/no such column: a/);
  });
  it("binds upserts and RETURNING", () => {
    const i = b("INSERT INTO users AS u (id, name) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET name = excluded.name || u.name WHERE u.age > 1 RETURNING id, name AS n, *") as BoundInsert;
    expect(i.upsert!.target).toEqual([0]);
    expect(i.upsert!.set![0]!.column).toBe(1);
    const concat = i.upsert!.set![0]!.expr as Extract<BoundExpr, { kind: "binary" }>;
    expect(colRef(concat.left)).toMatchObject({ rel: 1, column: 1, table: "excluded" }); // excluded row is rows[1]
    expect(colRef(concat.right)).toMatchObject({ rel: 0, column: 1, table: "u" });
    expect(i.upsert!.where).toBeDefined();
    expect(i.returning!.map((r) => r.name)).toEqual(["id", "n", "id", "name", "age"]);
    expect(err("INSERT INTO users (id) VALUES (1) ON CONFLICT (nope) DO NOTHING")).toMatch(/no column named nope/);
  });
  it("binds UPDATE assignments and WHERE", () => {
    const u = b("UPDATE users AS u SET age = age + 1, name = upper(name) WHERE u.id = :id RETURNING age") as BoundUpdate;
    expect(u.assignments.map((a) => a.column)).toEqual([2, 1]);
    expect(u.relations).toHaveLength(1);
    expect(u.where).toBeDefined();
    expect(u.parameters.names[0]).toBe(":id");
    expect(u.returning).toHaveLength(1);
    expect(err("UPDATE users SET age = 1, age = 2")).toMatch(/column age assigned more than once/);
    expect(err("UPDATE users SET nope = 1")).toMatch(/no column named nope/);
    expect(err("UPDATE adults SET name = 'x'")).toMatch(/cannot modify adults because it is a view/);
    // `(a, b) = (1, 2)` is expanded by the parser into per-column assignments
    const rv = b("UPDATE t1 SET (a, b) = (1, 'x')") as BoundUpdate;
    expect(rv.assignments.map((a) => [a.column, (a.expr as { value: unknown }).value])).toEqual([[0, 1n], [1, "x"]]);
  });
  it("binds UPDATE ... FROM with extra relations", () => {
    const u = b("UPDATE orders SET total = total * users.age FROM users WHERE users.id = orders.user_id") as BoundUpdate;
    expect(u.relations.map((r) => r.alias)).toEqual(["orders", "users"]);
    expect(u.from).toMatchObject({ kind: "relation", index: 1 });
    const mul = u.assignments[0]!.expr as Extract<BoundExpr, { kind: "binary" }>;
    expect(colRef(mul.right)).toMatchObject({ rel: 1, column: 2 });
  });
  it("binds DELETE", () => {
    const d = b("DELETE FROM users WHERE age < 18 AND name LIKE 'a%'");
    expect(d.kind).toBe("delete");
    expect((d as { where?: BoundExpr }).where).toBeDefined();
    expect(err("DELETE FROM nope")).toMatch(/no such table: nope/);
  });
});

describe("binder: DDL", () => {
  it("builds a TableSchema from CREATE TABLE", () => {
    const c = b("CREATE TABLE p (id INTEGER PRIMARY KEY, name VARCHAR(20) NOT NULL DEFAULT 'anon', score DOUBLE DEFAULT (1 + 1), flag BOOLEAN, note, CHECK (score >= 0), UNIQUE (name, score))") as BoundCreateTable;
    expect(c.table.name).toBe("p");
    expect(c.table.rowidColumn).toBe(0);
    expect(c.table.columns.map((x) => [x.name, x.type, x.notNull, x.primaryKey, x.unique, x.defaultSql])).toEqual([
      ["id", "INTEGER", false, true, false, undefined],
      ["name", "TEXT", true, false, false, "'anon'"],
      ["score", "REAL", false, false, false, "1 + 1"],
      ["flag", "BOOLEAN", false, false, false, undefined],
      ["note", "BLOB", false, false, false, undefined],
    ]);
    expect(c.defaults[1]).toMatchObject({ kind: "literal", value: "anon" });
    expect(c.defaults[2]).toMatchObject({ kind: "binary", op: "+" });
    expect(c.checks).toHaveLength(1);
    expect(colRef((c.checks[0] as Extract<BoundExpr, { kind: "binary" }>).left)).toMatchObject({ rel: 0, column: 2 });
    expect(c.uniques).toEqual([[1, 2]]);
    expect(c.primaryKey).toBeUndefined(); // rowid column PK
    expect(c.exists).toBe(false);
    expect(c.sql).toMatch(/^CREATE TABLE p/);
  });
  it("handles composite and non-integer primary keys", () => {
    const c = b("CREATE TABLE p (a INT, b TEXT, PRIMARY KEY (a, b))") as BoundCreateTable;
    expect(c.table.rowidColumn).toBe(-1);
    expect(c.primaryKey).toEqual([0, 1]);
    expect(c.table.columns.every((x) => x.primaryKey)).toBe(true);
    const c2 = b("CREATE TABLE p (a INT PRIMARY KEY)") as BoundCreateTable; // INT (not INTEGER) is not the rowid
    expect(c2.table.rowidColumn).toBe(-1);
    expect(c2.primaryKey).toEqual([0]);
    const c3 = b("CREATE TABLE p (a INTEGER, PRIMARY KEY (a))") as BoundCreateTable;
    expect(c3.table.rowidColumn).toBe(0);
    const c4 = b("CREATE TABLE p (a INTEGER PRIMARY KEY) WITHOUT ROWID") as BoundCreateTable;
    expect(c4.table.rowidColumn).toBe(-1);
    expect(c4.primaryKey).toEqual([0]);
  });
  it("turns a bare-identifier DEFAULT into a string literal and keeps literal defaults", () => {
    const c = b("CREATE TABLE p (a TEXT DEFAULT foo, b INTEGER DEFAULT -5, c TEXT DEFAULT NULL, d TEXT DEFAULT CURRENT_TIMESTAMP)") as BoundCreateTable;
    expect(c.defaults[0]).toMatchObject({ kind: "literal", value: "foo" });
    expect(c.table.columns[0]!.defaultSql).toBe("'foo'");
    expect(c.defaults[1]).toMatchObject({ kind: "literal", value: -5n });
    expect(c.table.columns[1]!.defaultSql).toBe("-5");
    expect(c.defaults[2]).toMatchObject({ kind: "literal", value: null });
    expect(c.defaults[3]).toMatchObject({ kind: "function", name: "current_timestamp" });
  });
  it("validates CREATE TABLE", () => {
    expect(err("CREATE TABLE users (a)")).toMatch(/table users already exists/);
    expect(() => b("CREATE TABLE IF NOT EXISTS users (a)")).not.toThrow();
    expect((b("CREATE TABLE IF NOT EXISTS users (a)") as BoundCreateTable).exists).toBe(true);
    expect(err("CREATE TABLE p (a, a)")).toMatch(/duplicate column name: a/);
    expect(err("CREATE TABLE p (a, A)")).toMatch(/duplicate column name/);
    expect(err("CREATE TABLE p (a PRIMARY KEY, b PRIMARY KEY)")).toMatch(/more than one primary key/);
    expect(err("CREATE TABLE p (a INTEGER PRIMARY KEY, PRIMARY KEY (a))")).toMatch(/more than one primary key/);
    expect(err("CREATE TABLE p (a, PRIMARY KEY (zz))")).toMatch(/no such column: zz/);
    expect(err("CREATE TABLE p (a, CHECK (zz > 0))")).toMatch(/no such column: zz/);
    expect(err("CREATE TABLE p (a, CHECK ((SELECT 1) > 0))")).toMatch(/subqueries are not allowed/);
    expect(err("CREATE TABLE p (a TEXT PRIMARY KEY AUTOINCREMENT)")).toMatch(/AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY/);
    expect(err("CREATE TABLE p (a) WITHOUT ROWID")).toMatch(/PRIMARY KEY missing/);
    expect(err("CREATE TABLE basalt_x (a)")).toMatch(/reserved for internal use/);
    expect(err("CREATE TABLE p (a INTEGER GENERATED ALWAYS AS (1))")).toMatch(/generated columns are not supported/);
    expect(err("CREATE TABLE p (a TEXT DEFAULT (b))")).toMatch(/column references are not allowed/);
  });
  it("binds CREATE TABLE AS SELECT", () => {
    const c = b("CREATE TABLE p AS SELECT id, name, age + 1 AS older, ? AS q FROM users") as BoundCreateTable;
    expect(c.asSelect).toBeDefined();
    expect(c.table.columns.map((x) => [x.name, x.type])).toEqual([["id", "INTEGER"], ["name", "TEXT"], ["older", "INTEGER"], ["q", "BLOB"]]);
  });
  it("binds CREATE INDEX", () => {
    const i = b("CREATE UNIQUE INDEX IF NOT EXISTS ix ON orders (user_id, total DESC) WHERE total > 0") as BoundCreateIndex;
    expect(i.index).toEqual({ name: "ix", table: "orders", columns: [1, 2], unique: true });
    expect(i.where).toBeDefined();
    expect(i.exists).toBe(false);
    expect((b("CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (id)") as BoundCreateIndex).exists).toBe(true);
    expect(err("CREATE INDEX idx_orders_user ON orders (id)")).toMatch(/index idx_orders_user already exists/);
    expect(err("CREATE INDEX ix ON nope (a)")).toMatch(/no such table: nope/);
    expect(err("CREATE INDEX ix ON orders (nope)")).toMatch(/no column named nope/);
    expect(err("CREATE INDEX ix ON orders (lower(id))")).toMatch(/expression indexes are not supported/);
    expect(err("CREATE INDEX ix ON orders (id, id)")).toMatch(/duplicate column in index/);
    expect(err("CREATE INDEX ix ON adults (id)")).toMatch(/views may not be indexed/);
  });
  it("binds CREATE VIEW and DROP", () => {
    const v = b("CREATE VIEW v (x, y) AS SELECT id, name FROM users WHERE age > 1");
    expect(v).toMatchObject({ kind: "createView", name: "v", exists: false });
    expect((v as { columns: { name: string }[] }).columns.map((c) => c.name)).toEqual(["x", "y"]);
    expect((v as { selectSql: string }).selectSql).toBe("SELECT id, name FROM users WHERE age > 1");
    expect(err("CREATE VIEW users AS SELECT 1")).toMatch(/view users already exists/);
    expect(err("CREATE VIEW v (x) AS SELECT 1, 2")).toMatch(/v has 1 column names but 2 values/);
    expect(err("CREATE VIEW v AS SELECT nope FROM users")).toMatch(/no such column: nope/);
    expect(b("DROP TABLE users")).toMatchObject({ kind: "drop", object: "TABLE", exists: true });
    expect(b("DROP TABLE IF EXISTS nope")).toMatchObject({ kind: "drop", exists: false, ifExists: true });
    expect(err("DROP TABLE nope")).toMatch(/no such table: nope/);
    expect(err("DROP INDEX nope")).toMatch(/no such index: nope/);
    expect(b("DROP INDEX idx_orders_user")).toMatchObject({ exists: true });
    expect(b("DROP VIEW adults")).toMatchObject({ exists: true });
    expect(err("DROP VIEW users")).toMatch(/no such view: users/);
  });
  it("binds ALTER TABLE", () => {
    expect(b("ALTER TABLE users RENAME TO people")).toMatchObject({ kind: "alterTable", action: "renameTo", newName: "people" });
    expect(err("ALTER TABLE users RENAME TO orders")).toMatch(/already another table/);
    expect(b("ALTER TABLE users RENAME COLUMN age TO years")).toMatchObject({ action: "renameColumn", column: 2, newName: "years" });
    expect(err("ALTER TABLE users RENAME COLUMN age TO name")).toMatch(/duplicate column name: name/);
    const add = b("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''") as Extract<BoundStatement, { kind: "alterTable" }> & { action: "addColumn" };
    expect(add.action).toBe("addColumn");
    expect(add.column).toMatchObject({ name: "email", type: "TEXT", notNull: true, defaultSql: "''" });
    expect(add.default).toMatchObject({ kind: "literal", value: "" });
    expect(err("ALTER TABLE users ADD COLUMN email TEXT NOT NULL")).toMatch(/Cannot add a NOT NULL column with default value NULL/);
    expect(err("ALTER TABLE users ADD COLUMN x INTEGER PRIMARY KEY")).toMatch(/Cannot add a PRIMARY KEY column/);
    expect(err("ALTER TABLE users ADD COLUMN name TEXT")).toMatch(/duplicate column name: name/);
    expect(b("ALTER TABLE orders DROP COLUMN total")).toMatchObject({ action: "dropColumn", column: 2 });
    expect(err("ALTER TABLE orders DROP COLUMN user_id")).toMatch(/indexed/);
    expect(err("ALTER TABLE users DROP COLUMN id")).toMatch(/PRIMARY KEY or UNIQUE/);
    expect(err("ALTER TABLE nope RENAME TO x")).toMatch(/no such table: nope/);
  });
  it("binds transaction, EXPLAIN, ANALYZE, VACUUM and PRAGMA", () => {
    expect(b("BEGIN IMMEDIATE")).toMatchObject({ kind: "begin", mode: "IMMEDIATE" });
    expect(b("COMMIT").kind).toBe("commit");
    expect(b("ROLLBACK TO sp")).toMatchObject({ kind: "rollback", savepoint: "sp" });
    expect(b("SAVEPOINT sp")).toMatchObject({ kind: "savepoint", name: "sp" });
    expect(b("RELEASE sp")).toMatchObject({ kind: "release", name: "sp" });
    const ex = b("EXPLAIN ANALYZE SELECT ? FROM users");
    expect(ex).toMatchObject({ kind: "explain", analyze: true, statement: { kind: "select" } });
    expect(ex.parameters.count).toBe(1);
    expect(b("ANALYZE users")).toMatchObject({ kind: "analyze", target: "users" });
    expect(err("ANALYZE nope")).toMatch(/no such table: nope/);
    expect(b("VACUUM").kind).toBe("vacuum");
    expect(b("PRAGMA table_info(users)")).toMatchObject({ kind: "pragma", name: "table_info", value: "users", assign: false });
    expect(b("PRAGMA cache_size = -2000")).toMatchObject({ kind: "pragma", name: "cache_size", value: -2000n, assign: true });
    expect(b("PRAGMA page_count")).toMatchObject({ kind: "pragma", name: "page_count", value: undefined });
  });
});

describe("bound tree helpers", () => {
  it("mapColumnRefs rewrites refs without touching subqueries", () => {
    const c = core("SELECT a + 1, (SELECT a FROM t1) FROM t1");
    const rewritten = mapColumnRefs(c.projections[0]!.expr, (ref) => ({ ...ref, rel: 7 } as BoundExpr));
    expect(colRef((rewritten as Extract<BoundExpr, { kind: "binary" }>).left).rel).toBe(7);
    const sq = mapColumnRefs(c.projections[1]!.expr, () => { throw new Error("should not descend"); });
    expect(sq.kind).toBe("subquery");
  });
  it("walkBoundExpr visits nested nodes", () => {
    const c = core("SELECT CASE WHEN a > 1 THEN b ELSE 'x' END FROM t1");
    const kinds: string[] = [];
    walkBoundExpr(c.projections[0]!.expr, (e) => kinds.push(e.kind));
    expect(kinds).toEqual(["case", "binary", "column", "literal", "column", "literal"]);
  });
});
