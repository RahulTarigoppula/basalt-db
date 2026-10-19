/**
 * Renders bound expressions back to SQL-ish text. Used for EXPLAIN output, constraint error messages and
 * structural expression keys in the planner. The output is not guaranteed to re-parse (it is for humans).
 */
import type { Value } from "../core/types.js";
import type { BoundExpr, BoundFrameBound, BoundOrderBy } from "./bound.js";

function hex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s.toUpperCase();
}

/** SQL literal text of a value. */
export function valueToSql(v: Value): string {
  if (v === null) return "NULL";
  switch (typeof v) {
    case "bigint": return v.toString();
    case "number": return Number.isFinite(v) ? (Number.isInteger(v) ? v.toFixed(1) : String(v)) : v > 0 ? "9.0e+999" : v < 0 ? "-9.0e+999" : "NULL";
    case "boolean": return v ? "TRUE" : "FALSE";
    case "string": return `'${v.replace(/'/g, "''")}'`;
    default: return `X'${hex(v)}'`;
  }
}

function orderByToSql(o: BoundOrderBy): string {
  return `${exprToSql(o.expr)}${o.desc ? " DESC" : ""}${o.nullsFirst !== !o.desc ? (o.nullsFirst ? " NULLS FIRST" : " NULLS LAST") : ""}`;
}

function boundToSql(b: BoundFrameBound): string {
  switch (b.kind) {
    case "unboundedPreceding": return "UNBOUNDED PRECEDING";
    case "unboundedFollowing": return "UNBOUNDED FOLLOWING";
    case "currentRow": return "CURRENT ROW";
    case "preceding": return `${exprToSql(b.offset)} PRECEDING`;
    case "following": return `${exprToSql(b.offset)} FOLLOWING`;
  }
}

/** Human-readable SQL text for a bound expression. Column refs print as `table.name` (or `name`). */
export function exprToSql(e: BoundExpr): string {
  switch (e.kind) {
    case "literal": return valueToSql(e.value);
    case "column": return e.table !== undefined ? `${e.table}.${e.name}` : e.name;
    case "rowid": return "rowid";
    case "param": return e.name ?? `?${e.index + 1}`;
    case "unary": return e.op === "NOT" ? `NOT ${exprToSql(e.operand)}` : `${e.op}${exprToSql(e.operand)}`;
    case "binary": return `(${exprToSql(e.left)} ${e.op} ${exprToSql(e.right)})`;
    case "like": return `(${exprToSql(e.left)} ${e.not ? "NOT " : ""}${e.op} ${exprToSql(e.right)}${e.escape ? ` ESCAPE ${exprToSql(e.escape)}` : ""})`;
    case "between": return `(${exprToSql(e.expr)} ${e.not ? "NOT " : ""}BETWEEN ${exprToSql(e.low)} AND ${exprToSql(e.high)})`;
    case "in": return `(${exprToSql(e.expr)} ${e.not ? "NOT " : ""}IN ${e.list ? `(${e.list.map(exprToSql).join(", ")})` : "(subquery)"})`;
    case "isnull": return `(${exprToSql(e.expr)} IS ${e.not ? "NOT " : ""}NULL)`;
    case "case": {
      let s = "CASE";
      if (e.operand) s += ` ${exprToSql(e.operand)}`;
      for (const w of e.whens) s += ` WHEN ${exprToSql(w.when)} THEN ${exprToSql(w.then)}`;
      if (e.else) s += ` ELSE ${exprToSql(e.else)}`;
      return s + " END";
    }
    case "cast": return `CAST(${exprToSql(e.expr)} AS ${e.target})`;
    case "function": return `${e.name}(${e.args.map(exprToSql).join(", ")})`;
    case "aggregate": {
      const args = e.star ? "*" : `${e.distinct ? "DISTINCT " : ""}${e.args.map(exprToSql).join(", ")}`;
      return `${e.name}(${args})${e.filter ? ` FILTER (WHERE ${exprToSql(e.filter)})` : ""}`;
    }
    case "window": {
      const parts: string[] = [];
      if (e.spec.partitionBy.length) parts.push(`PARTITION BY ${e.spec.partitionBy.map(exprToSql).join(", ")}`);
      if (e.spec.orderBy.length) parts.push(`ORDER BY ${e.spec.orderBy.map(orderByToSql).join(", ")}`);
      if (e.spec.frame) {
        const f = e.spec.frame;
        parts.push(`${f.unit} BETWEEN ${boundToSql(f.start)} AND ${boundToSql(f.end)}${f.exclude !== "NO OTHERS" ? ` EXCLUDE ${f.exclude}` : ""}`);
      }
      return `${e.name}(${e.distinct ? "DISTINCT " : ""}${e.args.map(exprToSql).join(", ")}) OVER (${parts.join(" ")})`;
    }
    case "exists": return `${e.not ? "NOT " : ""}EXISTS (subquery)`;
    case "subquery": return "(subquery)";
    case "resultColumn": return `#${e.index + 1}`;
  }
}
