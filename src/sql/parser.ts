/**
 * Recursive-descent SQL parser with a Pratt-style expression parser using SQLite's precedence table.
 *
 * Precedence (lowest -> highest): OR < AND < NOT (prefix) < [= == != <> IS IN LIKE GLOB MATCH REGEXP BETWEEN ISNULL NOTNULL]
 * < [< <= > >=] < [& | << >>] < [+ -] < [* / %] < || < unary [- + ~] < COLLATE.
 */
import { SyntaxError_ } from "../core/errors.js";
import { tokenize } from "./lexer.js";
import { RESERVED, describeToken, type Token } from "./token.js";
import type {
  AlterTableStmt, BinaryOp, ColumnConstraint, ColumnDefinition, CommonTableExpr, CompoundOp, ConflictAction, CreateIndexStmt,
  CreateTableStmt, CreateViewStmt, DeleteStmt, Expr, FrameBound, FrameExclude, FunctionExpr, IndexedColumn, InsertStmt, JoinType,
  LikeOp, OrderingTerm, PragmaStmt, ResultColumn, SelectBody, SelectCore, SelectStmt, SourceLocation, Statement, TableConstraint,
  TableRef, UpdateStmt, UpsertClause, WindowFrame, WindowSpec, WithClause,
} from "./ast.js";

const PREC_OR = 1, PREC_AND = 2, PREC_NOT = 3, PREC_EQ = 4, PREC_CMP = 5, PREC_BIT = 6, PREC_ADD = 7, PREC_MUL = 8,
  PREC_CONCAT = 9, PREC_UNARY = 10, PREC_COLLATE = 11;

const CONSTRAINT_START = new Set(["CONSTRAINT", "PRIMARY", "NOT", "NULL", "UNIQUE", "CHECK", "DEFAULT", "COLLATE", "REFERENCES", "GENERATED", "AS"]);
const JOIN_START = new Set(["JOIN", "NATURAL", "LEFT", "RIGHT", "FULL", "INNER", "CROSS"]);

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly sql: string) {}

  // ───────── token helpers ─────────
  private peek(k = 0): Token { return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)]!; }
  private prev(): Token { return this.tokens[Math.max(this.pos - 1, 0)]!; }
  private next(): Token { const t = this.peek(); if (t.kind !== "eof") this.pos++; return t; }
  private at(kw: string, k = 0): boolean { const t = this.peek(k); return t.kind === "ident" && !t.quoted && t.upper === kw; }
  private atPunct(p: string, k = 0): boolean { const t = this.peek(k); return t.kind === "punct" && t.text === p; }
  private atAny(...kws: string[]): boolean { const t = this.peek(); return t.kind === "ident" && !t.quoted && kws.includes(t.upper); }
  private accept(kw: string): boolean { if (this.at(kw)) { this.pos++; return true; } return false; }
  private acceptPunct(p: string): boolean { if (this.atPunct(p)) { this.pos++; return true; } return false; }
  private expect(kw: string): Token { if (!this.at(kw)) this.fail(`expected ${kw}`); return this.next(); }
  private expectPunct(p: string): Token { if (!this.atPunct(p)) this.fail(`expected '${p}'`); return this.next(); }
  private fail(msg: string, tok: Token = this.peek()): never {
    throw new SyntaxError_(`${msg} near ${describeToken(tok)} at ${tok.line}:${tok.col}`, tok.line, tok.col);
  }
  private loc(start: Token): SourceLocation {
    const end = this.prev();
    return { line: start.line, col: start.col, offset: start.offset, end: Math.max(end.end, start.offset) };
  }
  private text(start: Token): string { return this.sql.slice(start.offset, this.prev().end); }

  /** Identifier: quoted, or a bare word that is not a reserved keyword. String literals are accepted too (SQLite does). */
  private isIdentifierToken(t: Token): boolean {
    return (t.kind === "ident" && (t.quoted || !RESERVED.has(t.upper))) || t.kind === "string";
  }
  private expectIdentifier(what = "identifier"): string {
    const t = this.peek();
    if (!this.isIdentifierToken(t)) this.fail(`expected ${what}`);
    this.pos++;
    return t.value as string;
  }
  /** `[schema.]name` - returns name, discarding an optional schema qualifier. */
  private expectQualifiedName(what = "name"): { schema?: string; name: string } {
    let name = this.expectIdentifier(what);
    if (this.atPunct(".") && this.isIdentifierToken(this.peek(1))) {
      this.pos++;
      const second = this.expectIdentifier(what);
      return { schema: name, name: second };
    }
    return { name };
  }
  private identifierList(): string[] {
    this.expectPunct("(");
    const out: string[] = [];
    do out.push(this.expectIdentifier("column name")); while (this.acceptPunct(","));
    this.expectPunct(")");
    return out;
  }

  /** Fails unless every token has been consumed. */
  expectEnd(): void {
    const rest = this.peek();
    if (rest.kind !== "eof") this.fail("unexpected input after expression", rest);
  }

  // ───────── statements ─────────
  parseStatements(): Statement[] {
    const out: Statement[] = [];
    for (;;) {
      while (this.acceptPunct(";")) { /* skip empty statements */ }
      if (this.peek().kind === "eof") break;
      out.push(this.parseStatement());
      if (!this.atPunct(";") && this.peek().kind !== "eof") this.fail("expected ';' or end of input");
    }
    return out;
  }

  parseStatement(): Statement {
    const t = this.peek();
    if (t.kind !== "ident" || t.quoted) {
      if (this.atPunct("(")) return this.parseSelect();
      this.fail("expected statement");
    }
    switch (t.upper) {
      case "SELECT": case "VALUES": return this.parseSelect();
      case "WITH": {
        // WITH may prefix SELECT, INSERT, UPDATE or DELETE.
        const save = this.pos;
        const w = this.parseWith();
        if (this.atAny("INSERT", "REPLACE")) return this.parseInsert(w, t);
        if (this.at("UPDATE")) return this.parseUpdate(w, t);
        if (this.at("DELETE")) return this.parseDelete(w, t);
        this.pos = save;
        return this.parseSelect();
      }
      case "INSERT": case "REPLACE": return this.parseInsert(undefined, t);
      case "UPDATE": return this.parseUpdate(undefined, t);
      case "DELETE": return this.parseDelete(undefined, t);
      case "CREATE": return this.parseCreate();
      case "DROP": return this.parseDrop();
      case "ALTER": return this.parseAlter();
      case "BEGIN": {
        this.next();
        let mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE" | undefined;
        if (this.atAny("DEFERRED", "IMMEDIATE", "EXCLUSIVE")) mode = this.next().upper as typeof mode;
        this.accept("TRANSACTION");
        return { type: "begin", mode, loc: this.loc(t) };
      }
      case "COMMIT": case "END": this.next(); this.accept("TRANSACTION"); return { type: "commit", loc: this.loc(t) };
      case "ROLLBACK": {
        this.next(); this.accept("TRANSACTION");
        let savepoint: string | undefined;
        if (this.accept("TO")) { this.accept("SAVEPOINT"); savepoint = this.expectIdentifier("savepoint name"); }
        return { type: "rollback", savepoint, loc: this.loc(t) };
      }
      case "SAVEPOINT": this.next(); return { type: "savepoint", name: this.expectIdentifier("savepoint name"), loc: this.loc(t) };
      case "RELEASE": this.next(); this.accept("SAVEPOINT"); return { type: "release", name: this.expectIdentifier("savepoint name"), loc: this.loc(t) };
      case "EXPLAIN": {
        this.next();
        let analyze = false, queryPlan = false;
        if (this.accept("QUERY")) { this.expect("PLAN"); queryPlan = true; }
        else if (this.accept("ANALYZE")) analyze = true;
        const statement = this.parseStatement();
        return { type: "explain", analyze, queryPlan, statement, loc: this.loc(t) };
      }
      case "ANALYZE": {
        this.next();
        let target: string | undefined;
        if (this.isIdentifierToken(this.peek())) target = this.expectQualifiedName().name;
        return { type: "analyze", target, loc: this.loc(t) };
      }
      case "VACUUM": this.next(); if (this.isIdentifierToken(this.peek())) this.next(); return { type: "vacuum", loc: this.loc(t) };
      case "PRAGMA": return this.parsePragma();
      default: this.fail("expected statement");
    }
  }

  private parsePragma(): PragmaStmt {
    const start = this.expect("PRAGMA");
    const { schema, name } = this.expectQualifiedName("pragma name");
    let value: Expr | undefined, assign = false;
    if (this.acceptPunct("=")) { assign = true; value = this.parsePragmaValue(); }
    else if (this.acceptPunct("(")) { value = this.parsePragmaValue(); this.expectPunct(")"); }
    return { type: "pragma", schema, name, value, assign, loc: this.loc(start) };
  }
  private parsePragmaValue(): Expr {
    const t = this.peek();
    if (t.kind === "ident" && !t.quoted && (t.upper === "ON" || t.upper === "OFF" || t.upper === "YES" || t.upper === "NO" || t.upper === "TRUE" || t.upper === "FALSE")) {
      this.next();
      return { type: "literal", value: t.value as string, loc: this.loc(t) };
    }
    if (this.isIdentifierToken(t) && t.kind !== "string") { this.next(); return { type: "literal", value: t.value as string, loc: this.loc(t) }; }
    return this.parseExpr(PREC_UNARY);
  }

  // ───────── SELECT ─────────
  private parseWith(): WithClause {
    const start = this.expect("WITH");
    const recursive = this.accept("RECURSIVE");
    const ctes: CommonTableExpr[] = [];
    do {
      const cstart = this.peek();
      const name = this.expectIdentifier("CTE name");
      let columns: string[] | undefined;
      if (this.atPunct("(")) columns = this.identifierList();
      this.expect("AS");
      let materialized: boolean | undefined;
      if (this.accept("NOT")) { this.expect("MATERIALIZED"); materialized = false; }
      else if (this.accept("MATERIALIZED")) materialized = true;
      this.expectPunct("(");
      const select = this.parseSelect();
      this.expectPunct(")");
      ctes.push({ name, columns, materialized, select, loc: this.loc(cstart) });
    } while (this.acceptPunct(","));
    return { recursive, ctes, loc: this.loc(start) };
  }

  parseSelect(): SelectStmt {
    const start = this.peek();
    const w = this.at("WITH") ? this.parseWith() : undefined;
    const body = this.parseCompound();
    const tail = this.parseSelectTail();
    return { type: "select", with: w, body, ...tail, loc: this.loc(start) };
  }

  private parseSelectTail(): { orderBy?: OrderingTerm[]; limit?: Expr; offset?: Expr } {
    let orderBy: OrderingTerm[] | undefined, limit: Expr | undefined, offset: Expr | undefined;
    if (this.at("ORDER")) orderBy = this.parseOrderBy();
    if (this.accept("LIMIT")) {
      limit = this.parseExpr();
      if (this.accept("OFFSET")) offset = this.parseExpr();
      else if (this.acceptPunct(",")) { offset = limit; limit = this.parseExpr(); } // LIMIT offset, count
    }
    return { orderBy, limit, offset };
  }

  private parseOrderBy(): OrderingTerm[] {
    this.expect("ORDER"); this.expect("BY");
    const terms: OrderingTerm[] = [];
    do terms.push(this.parseOrderingTerm()); while (this.acceptPunct(","));
    return terms;
  }

  private parseOrderingTerm(): OrderingTerm {
    const start = this.peek();
    let expr = this.parseExpr();
    let collation: string | undefined;
    // `a COLLATE NOCASE DESC`: the expression parser already consumed COLLATE (highest precedence); unwrap it
    if (expr.type === "collate") { collation = expr.collation; expr = expr.expr; }
    let desc = false;
    if (this.accept("DESC")) desc = true; else this.accept("ASC");
    let nulls: "FIRST" | "LAST" | undefined;
    if (this.accept("NULLS")) { if (this.accept("FIRST")) nulls = "FIRST"; else { this.expect("LAST"); nulls = "LAST"; } }
    return { expr, desc, nulls, collation, loc: this.loc(start) };
  }

  private parseCompound(): SelectBody {
    const start = this.peek();
    let left = this.parseSelectCoreOrValues();
    for (;;) {
      let op: CompoundOp;
      if (this.accept("UNION")) op = this.accept("ALL") ? "UNION ALL" : "UNION";
      else if (this.accept("INTERSECT")) op = "INTERSECT";
      else if (this.accept("EXCEPT")) op = "EXCEPT";
      else break;
      const right = this.parseSelectCoreOrValues();
      left = { type: "compound", op, left, right, loc: this.loc(start) };
    }
    return left;
  }

  private parseSelectCoreOrValues(): SelectBody {
    const start = this.peek();
    if (this.accept("VALUES")) {
      const rows: Expr[][] = [];
      do {
        this.expectPunct("(");
        const row: Expr[] = [];
        do row.push(this.parseExpr()); while (this.acceptPunct(","));
        this.expectPunct(")");
        rows.push(row);
      } while (this.acceptPunct(","));
      return { type: "values", rows, loc: this.loc(start) };
    }
    if (this.atPunct("(")) {
      // Parenthesised select used as a compound operand: `(SELECT ...) UNION (SELECT ...)`.
      const save = this.pos;
      this.next();
      if (this.atAny("SELECT", "VALUES", "WITH") || this.atPunct("(")) {
        const inner = this.parseSelect();
        this.expectPunct(")");
        if (inner.with || inner.orderBy || inner.limit) {
          // Wrap as a derived table so the ORDER BY/LIMIT semantics are preserved.
          const core: SelectCore = {
            type: "select", distinct: false, columns: [{ type: "star", loc: inner.loc }],
            from: { type: "subquery", select: inner, loc: inner.loc }, loc: this.loc(start),
          };
          return core;
        }
        return inner.body;
      }
      this.pos = save;
    }
    return this.parseSelectCore();
  }

  private parseSelectCore(): SelectCore {
    const start = this.expect("SELECT");
    let distinct = false;
    if (this.accept("DISTINCT")) distinct = true; else this.accept("ALL");
    const columns: ResultColumn[] = [];
    do columns.push(this.parseResultColumn()); while (this.acceptPunct(","));
    let from: TableRef | undefined;
    if (this.accept("FROM")) from = this.parseTableRefs();
    let where: Expr | undefined;
    if (this.accept("WHERE")) where = this.parseExpr();
    let groupBy: Expr[] | undefined;
    if (this.accept("GROUP")) {
      this.expect("BY");
      groupBy = [];
      do groupBy.push(this.parseExpr()); while (this.acceptPunct(","));
    }
    let having: Expr | undefined;
    if (this.accept("HAVING")) having = this.parseExpr();
    let windows: { name: string; spec: WindowSpec }[] | undefined;
    if (this.accept("WINDOW")) {
      windows = [];
      do {
        const name = this.expectIdentifier("window name");
        this.expect("AS");
        windows.push({ name, spec: this.parseWindowSpec() });
      } while (this.acceptPunct(","));
    }
    return { type: "select", distinct, columns, from, where, groupBy, having, windows, loc: this.loc(start) };
  }

  private parseResultColumn(): ResultColumn {
    const start = this.peek();
    if (this.acceptPunct("*")) return { type: "star", loc: this.loc(start) };
    if (this.isIdentifierToken(start) && start.kind !== "string" && this.atPunct(".", 1) && this.atPunct("*", 2)) {
      this.pos += 3;
      return { type: "tableStar", table: start.value as string, loc: this.loc(start) };
    }
    const expr = this.parseExpr();
    let alias: string | undefined;
    if (this.accept("AS")) alias = this.expectIdentifier("alias");
    else if (this.isIdentifierToken(this.peek())) alias = this.expectIdentifier("alias");
    return { type: "expr", expr, alias, loc: this.loc(start) };
  }

  private parseTableRefs(): TableRef {
    const start = this.peek();
    let left = this.parseTableRefItem();
    for (;;) {
      if (this.acceptPunct(",")) {
        const right = this.parseTableRefItem();
        left = { type: "join", joinType: "INNER", natural: false, left, right, loc: this.loc(start) };
        continue;
      }
      if (!this.atAny(...JOIN_START)) break;
      const natural = this.accept("NATURAL");
      let joinType: JoinType = "INNER";
      if (this.accept("LEFT")) { this.accept("OUTER"); joinType = "LEFT"; }
      else if (this.accept("RIGHT")) { this.accept("OUTER"); joinType = "RIGHT"; }
      else if (this.accept("FULL")) { this.accept("OUTER"); joinType = "FULL"; }
      else if (this.accept("INNER")) joinType = "INNER";
      else if (this.accept("CROSS")) joinType = "CROSS";
      this.expect("JOIN");
      const right = this.parseTableRefItem();
      let on: Expr | undefined, using: string[] | undefined;
      if (this.accept("ON")) on = this.parseExpr();
      else if (this.accept("USING")) using = this.identifierList();
      if (natural && (on || using)) this.fail("a NATURAL join may not have an ON or USING clause", this.prev());
      left = { type: "join", joinType, natural, left, right, on, using, loc: this.loc(start) };
    }
    return left;
  }

  private parseTableRefItem(): TableRef {
    const start = this.peek();
    if (this.acceptPunct("(")) {
      if (this.atAny("SELECT", "VALUES", "WITH")) {
        const select = this.parseSelect();
        this.expectPunct(")");
        const alias = this.parseOptionalAlias();
        return { type: "subquery", select, alias, loc: this.loc(start) };
      }
      const inner = this.parseTableRefs();
      this.expectPunct(")");
      return inner;
    }
    const { schema, name } = this.expectQualifiedName("table name");
    const alias = this.parseOptionalAlias();
    let indexedBy: string | null | undefined;
    if (this.accept("INDEXED")) { this.expect("BY"); indexedBy = this.expectIdentifier("index name"); }
    else if (this.at("NOT") && this.at("INDEXED", 1)) { this.pos += 2; indexedBy = null; }
    return { type: "table", schema, name, alias, indexedBy, loc: this.loc(start) };
  }

  private parseOptionalAlias(): string | undefined {
    if (this.accept("AS")) return this.expectIdentifier("alias");
    const t = this.peek();
    if (t.kind === "ident" && (t.quoted || (!RESERVED.has(t.upper) && t.upper !== "INDEXED"))) { this.pos++; return t.value as string; }
    return undefined;
  }

  // ───────── window specs ─────────
  private parseWindowSpec(): WindowSpec {
    const start = this.expectPunct("(");
    let baseName: string | undefined;
    if (this.isIdentifierToken(this.peek()) && this.peek().kind !== "string" && !this.atAny("PARTITION", "ORDER", "ROWS", "RANGE", "GROUPS")) {
      baseName = this.expectIdentifier("window name");
    }
    const partitionBy: Expr[] = [];
    if (this.accept("PARTITION")) {
      this.expect("BY");
      do partitionBy.push(this.parseExpr()); while (this.acceptPunct(","));
    }
    const orderBy = this.at("ORDER") ? this.parseOrderBy() : [];
    let frame: WindowFrame | undefined;
    if (this.atAny("ROWS", "RANGE", "GROUPS")) frame = this.parseFrame();
    this.expectPunct(")");
    return { baseName, partitionBy, orderBy, frame, loc: this.loc(start) };
  }

  private parseFrame(): WindowFrame {
    const unit = this.next().upper as WindowFrame["unit"];
    let startBound: FrameBound, endBound: FrameBound;
    if (this.accept("BETWEEN")) {
      startBound = this.parseFrameBound();
      this.expect("AND");
      endBound = this.parseFrameBound();
    } else {
      startBound = this.parseFrameBound();
      endBound = { kind: "currentRow" };
    }
    if (startBound.kind === "unboundedFollowing") this.fail("frame starting from UNBOUNDED FOLLOWING is invalid", this.prev());
    if (endBound.kind === "unboundedPreceding") this.fail("frame ending at UNBOUNDED PRECEDING is invalid", this.prev());
    let exclude: FrameExclude = "NO OTHERS";
    if (this.accept("EXCLUDE")) {
      if (this.accept("NO")) { this.expect("OTHERS"); exclude = "NO OTHERS"; }
      else if (this.accept("CURRENT")) { this.expect("ROW"); exclude = "CURRENT ROW"; }
      else if (this.accept("GROUP")) exclude = "GROUP";
      else { this.expect("TIES"); exclude = "TIES"; }
    }
    return { unit, start: startBound, end: endBound, exclude };
  }

  private parseFrameBound(): FrameBound {
    if (this.accept("UNBOUNDED")) {
      if (this.accept("PRECEDING")) return { kind: "unboundedPreceding" };
      this.expect("FOLLOWING");
      return { kind: "unboundedFollowing" };
    }
    if (this.accept("CURRENT")) { this.expect("ROW"); return { kind: "currentRow" }; }
    const offset = this.parseExpr();
    if (this.accept("PRECEDING")) return { kind: "preceding", offset };
    this.expect("FOLLOWING");
    return { kind: "following", offset };
  }

  // ───────── DML ─────────
  private parseInsert(w: WithClause | undefined, start: Token): InsertStmt {
    let or: ConflictAction | undefined;
    if (this.accept("REPLACE")) or = "REPLACE";
    else {
      this.expect("INSERT");
      if (this.accept("OR")) or = this.parseConflictAction();
    }
    this.expect("INTO");
    const { name: table } = this.expectQualifiedName("table name");
    let alias: string | undefined;
    if (this.accept("AS")) alias = this.expectIdentifier("alias");
    let columns: string[] | undefined;
    if (this.atPunct("(")) columns = this.identifierList();
    const stmt: InsertStmt = { type: "insert", with: w, or, table, alias, columns, loc: this.loc(start) };
    if (this.accept("DEFAULT")) { this.expect("VALUES"); stmt.defaultValues = true; }
    else if (this.at("VALUES")) {
      // Plain VALUES rows are kept as rows (so a trailing upsert clause is unambiguous);
      // `VALUES ... UNION ...`/`ORDER BY`/`LIMIT` falls back to a full select.
      const save = this.pos;
      const body = this.parseSelectCoreOrValues();
      if (body.type === "values" && !this.atAny("UNION", "INTERSECT", "EXCEPT", "ORDER", "LIMIT")) stmt.values = body.rows;
      else { this.pos = save; stmt.select = this.parseSelect(); }
    } else stmt.select = this.parseSelect();
    if (this.at("ON")) stmt.upsert = this.parseUpsert();
    if (this.at("RETURNING")) stmt.returning = this.parseReturning();
    stmt.loc = this.loc(start);
    return stmt;
  }

  private parseConflictAction(): ConflictAction {
    const t = this.next();
    if (t.kind === "ident" && ["ROLLBACK", "ABORT", "FAIL", "IGNORE", "REPLACE"].includes(t.upper)) return t.upper as ConflictAction;
    this.fail("expected conflict action (ROLLBACK, ABORT, FAIL, IGNORE or REPLACE)", t);
  }

  private parseUpsert(): UpsertClause {
    const start = this.expect("ON");
    this.expect("CONFLICT");
    const target: string[] = [];
    let targetWhere: Expr | undefined;
    if (this.atPunct("(")) {
      target.push(...this.identifierList());
      if (this.accept("WHERE")) targetWhere = this.parseExpr();
    }
    this.expect("DO");
    if (this.accept("NOTHING")) return { target, targetWhere, loc: this.loc(start) };
    this.expect("UPDATE"); this.expect("SET");
    const set: { column: string; value: Expr }[] = [];
    do {
      const column = this.expectIdentifier("column name");
      this.expectPunct("=");
      set.push({ column, value: this.parseExpr() });
    } while (this.acceptPunct(","));
    let where: Expr | undefined;
    if (this.accept("WHERE")) where = this.parseExpr();
    return { target, targetWhere, set, where, loc: this.loc(start) };
  }

  private parseReturning(): ResultColumn[] {
    this.expect("RETURNING");
    const cols: ResultColumn[] = [];
    do cols.push(this.parseResultColumn()); while (this.acceptPunct(","));
    return cols;
  }

  private parseUpdate(w: WithClause | undefined, start: Token): UpdateStmt {
    this.expect("UPDATE");
    let or: ConflictAction | undefined;
    if (this.accept("OR")) or = this.parseConflictAction();
    const { name: table } = this.expectQualifiedName("table name");
    let alias: string | undefined;
    if (this.accept("AS")) alias = this.expectIdentifier("alias");
    else if (!this.at("SET") && this.isIdentifierToken(this.peek()) && this.peek().kind !== "string") alias = this.expectIdentifier("alias");
    this.expect("SET");
    const assignments: UpdateStmt["assignments"] = [];
    do {
      const astart = this.peek();
      if (this.atPunct("(")) {
        // `(a, b) = (expr, expr)` is expanded into one assignment per column at parse time
        const columns = this.identifierList();
        this.expectPunct("=");
        const open = this.expectPunct("(");
        if (this.atAny("SELECT", "VALUES", "WITH")) this.fail("row-value subqueries are not supported in UPDATE SET", open);
        const values: Expr[] = [];
        do values.push(this.parseExpr()); while (this.acceptPunct(","));
        this.expectPunct(")");
        if (values.length !== columns.length) this.fail(`${columns.length} columns assigned ${values.length} values`, astart);
        columns.forEach((c, i) => assignments.push({ columns: [c], value: values[i]!, loc: this.loc(astart) }));
        continue;
      }
      const columns = [this.expectIdentifier("column name")];
      this.expectPunct("=");
      const value = this.parseExpr();
      assignments.push({ columns, value, loc: this.loc(astart) });
    } while (this.acceptPunct(","));
    let from: TableRef | undefined;
    if (this.accept("FROM")) from = this.parseTableRefs();
    let where: Expr | undefined;
    if (this.accept("WHERE")) where = this.parseExpr();
    let returning: ResultColumn[] | undefined;
    if (this.at("RETURNING")) returning = this.parseReturning();
    return { type: "update", with: w, or, table, alias, assignments, from, where, returning, loc: this.loc(start) };
  }

  private parseDelete(w: WithClause | undefined, start: Token): DeleteStmt {
    this.expect("DELETE"); this.expect("FROM");
    const { name: table } = this.expectQualifiedName("table name");
    let alias: string | undefined;
    if (this.accept("AS")) alias = this.expectIdentifier("alias");
    else if (this.isIdentifierToken(this.peek()) && this.peek().kind !== "string" && !this.at("INDEXED")) alias = this.expectIdentifier("alias");
    if (this.accept("INDEXED")) { this.expect("BY"); this.expectIdentifier("index name"); }
    else if (this.at("NOT") && this.at("INDEXED", 1)) this.pos += 2;
    let where: Expr | undefined;
    if (this.accept("WHERE")) where = this.parseExpr();
    let returning: ResultColumn[] | undefined;
    if (this.at("RETURNING")) returning = this.parseReturning();
    return { type: "delete", with: w, table, alias, where, returning, loc: this.loc(start) };
  }

  // ───────── DDL ─────────
  private parseCreate(): Statement {
    const start = this.expect("CREATE");
    const temp = this.accept("TEMP") || this.accept("TEMPORARY");
    if (this.accept("TABLE")) return this.parseCreateTable(start, temp);
    if (this.accept("VIEW")) return this.parseCreateView(start, temp);
    const unique = this.accept("UNIQUE");
    if (this.accept("INDEX")) return this.parseCreateIndex(start, unique);
    this.fail("expected TABLE, INDEX or VIEW after CREATE");
  }

  private parseIfNotExists(): boolean {
    if (this.accept("IF")) { this.expect("NOT"); this.expect("EXISTS"); return true; }
    return false;
  }

  private parseCreateTable(start: Token, temp: boolean): CreateTableStmt {
    const ifNotExists = this.parseIfNotExists();
    const { name } = this.expectQualifiedName("table name");
    if (this.accept("AS")) {
      const asSelect = this.parseSelect();
      return { type: "createTable", ifNotExists, temp, name, columns: [], constraints: [], withoutRowid: false, asSelect, sql: this.text(start), loc: this.loc(start) };
    }
    this.expectPunct("(");
    const columns: ColumnDefinition[] = [];
    const constraints: TableConstraint[] = [];
    do {
      if (this.atAny("CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN")) constraints.push(this.parseTableConstraint());
      else columns.push(this.parseColumnDefinition());
    } while (this.acceptPunct(","));
    this.expectPunct(")");
    let withoutRowid = false;
    while (this.at("WITHOUT") || this.at("STRICT")) {
      if (this.accept("WITHOUT")) { this.expect("ROWID"); withoutRowid = true; }
      else this.next();
      if (!this.acceptPunct(",")) break;
    }
    if (columns.length === 0) this.fail("a table must have at least one column", start);
    return { type: "createTable", ifNotExists, temp, name, columns, constraints, withoutRowid, sql: this.text(start), loc: this.loc(start) };
  }

  private parseColumnDefinition(): ColumnDefinition {
    const start = this.peek();
    const name = this.expectIdentifier("column name");
    let typeName: string | undefined;
    const words: string[] = [];
    while (this.peek().kind === "ident" && !this.peek().quoted && !CONSTRAINT_START.has(this.peek().upper) && !RESERVED.has(this.peek().upper)) {
      words.push(this.next().text);
    }
    if (words.length > 0) {
      typeName = words.join(" ");
      if (this.acceptPunct("(")) {
        const args: string[] = [];
        do {
          const sign = this.acceptPunct("-") ? "-" : (this.acceptPunct("+"), "");
          const t = this.next();
          if (t.kind !== "integer" && t.kind !== "real") this.fail("expected a number in type declaration", t);
          args.push(sign + t.text);
        } while (this.acceptPunct(","));
        this.expectPunct(")");
        typeName += `(${args.join(", ")})`;
      }
    }
    const constraints: ColumnConstraint[] = [];
    while (this.atAny(...CONSTRAINT_START)) constraints.push(this.parseColumnConstraint());
    return { name, typeName, constraints, loc: this.loc(start) };
  }

  private parseOnConflict(): ConflictAction | undefined {
    if (this.at("ON") && this.at("CONFLICT", 1)) { this.pos += 2; return this.parseConflictAction(); }
    return undefined;
  }

  private parseColumnConstraint(): ColumnConstraint {
    let name: string | undefined;
    if (this.accept("CONSTRAINT")) name = this.expectIdentifier("constraint name");
    if (this.accept("PRIMARY")) {
      this.expect("KEY");
      let desc = false;
      if (this.accept("DESC")) desc = true; else this.accept("ASC");
      const onConflict = this.parseOnConflict();
      const autoincrement = this.accept("AUTOINCREMENT");
      return { kind: "primaryKey", desc, autoincrement, onConflict, name };
    }
    if (this.accept("NOT")) { this.expect("NULL"); return { kind: "notNull", onConflict: this.parseOnConflict(), name }; }
    if (this.accept("NULL")) { this.parseOnConflict(); return { kind: "null", name }; }
    if (this.accept("UNIQUE")) return { kind: "unique", onConflict: this.parseOnConflict(), name };
    if (this.accept("CHECK")) { this.expectPunct("("); const expr = this.parseExpr(); this.expectPunct(")"); return { kind: "check", expr, name }; }
    if (this.accept("DEFAULT")) {
      if (this.acceptPunct("(")) { const expr = this.parseExpr(); this.expectPunct(")"); return { kind: "default", expr, parenthesized: true, name }; }
      return { kind: "default", expr: this.parseExpr(PREC_UNARY), parenthesized: false, name };
    }
    if (this.accept("COLLATE")) return { kind: "collate", collation: this.expectIdentifier("collation name"), name };
    if (this.accept("REFERENCES")) {
      const table = this.expectQualifiedName("table name").name;
      let columns: string[] | undefined;
      if (this.atPunct("(")) columns = this.identifierList();
      this.skipForeignKeyClauses();
      return { kind: "references", table, columns, name };
    }
    if (this.accept("GENERATED")) { this.expect("ALWAYS"); }
    if (this.accept("AS")) {
      this.expectPunct("("); const expr = this.parseExpr(); this.expectPunct(")");
      let stored = false;
      if (this.accept("STORED")) stored = true; else this.accept("VIRTUAL");
      return { kind: "generated", expr, stored, name };
    }
    this.fail("expected column constraint");
  }

  private skipForeignKeyClauses(): void {
    for (;;) {
      if (this.accept("ON")) {
        if (!this.accept("DELETE")) this.expect("UPDATE");
        if (this.accept("SET")) { if (!this.accept("NULL")) this.expect("DEFAULT"); }
        else if (this.accept("NO")) this.expect("ACTION");
        else if (!this.accept("CASCADE") && !this.accept("RESTRICT")) this.fail("expected foreign key action");
      } else if (this.accept("MATCH")) this.expectIdentifier("match type");
      else if (this.at("NOT") && this.at("DEFERRABLE", 1)) { this.pos += 2; this.skipDeferrable(); }
      else if (this.accept("DEFERRABLE")) this.skipDeferrable();
      else break;
    }
  }
  private skipDeferrable(): void {
    if (this.accept("INITIALLY")) { if (!this.accept("DEFERRED")) this.expect("IMMEDIATE"); }
  }

  private parseIndexedColumns(): IndexedColumn[] {
    this.expectPunct("(");
    const cols: IndexedColumn[] = [];
    do {
      const start = this.peek();
      let expr = this.parseExpr();
      let collation: string | undefined;
      if (expr.type === "collate") { collation = expr.collation; expr = expr.expr; }
      let desc = false;
      if (this.accept("DESC")) desc = true; else this.accept("ASC");
      if (expr.type === "column" && !expr.table) cols.push({ name: expr.name, collation, desc, loc: this.loc(start) });
      else cols.push({ name: this.sql.slice(expr.loc.offset, expr.loc.end), expr, collation, desc, loc: this.loc(start) });
    } while (this.acceptPunct(","));
    this.expectPunct(")");
    return cols;
  }

  private parseTableConstraint(): TableConstraint {
    const start = this.peek();
    let name: string | undefined;
    if (this.accept("CONSTRAINT")) name = this.expectIdentifier("constraint name");
    if (this.accept("PRIMARY")) {
      this.expect("KEY");
      const columns = this.parseIndexedColumns();
      return { kind: "primaryKey", columns, onConflict: this.parseOnConflict(), name, loc: this.loc(start) };
    }
    if (this.accept("UNIQUE")) {
      const columns = this.parseIndexedColumns();
      return { kind: "unique", columns, onConflict: this.parseOnConflict(), name, loc: this.loc(start) };
    }
    if (this.accept("CHECK")) {
      this.expectPunct("("); const expr = this.parseExpr(); this.expectPunct(")");
      return { kind: "check", expr, name, loc: this.loc(start) };
    }
    if (this.accept("FOREIGN")) {
      this.expect("KEY");
      const columns = this.identifierList();
      this.expect("REFERENCES");
      const table = this.expectQualifiedName("table name").name;
      let refColumns: string[] | undefined;
      if (this.atPunct("(")) refColumns = this.identifierList();
      this.skipForeignKeyClauses();
      return { kind: "foreignKey", columns, table, refColumns, name, loc: this.loc(start) };
    }
    this.fail("expected table constraint");
  }

  private parseCreateIndex(start: Token, unique: boolean): CreateIndexStmt {
    const ifNotExists = this.parseIfNotExists();
    const { name } = this.expectQualifiedName("index name");
    this.expect("ON");
    const table = this.expectIdentifier("table name");
    const columns = this.parseIndexedColumns();
    let where: Expr | undefined;
    if (this.accept("WHERE")) where = this.parseExpr();
    return { type: "createIndex", unique, ifNotExists, name, table, columns, where, sql: this.text(start), loc: this.loc(start) };
  }

  private parseCreateView(start: Token, temp: boolean): CreateViewStmt {
    const ifNotExists = this.parseIfNotExists();
    const { name } = this.expectQualifiedName("view name");
    let columns: string[] | undefined;
    if (this.atPunct("(")) columns = this.identifierList();
    this.expect("AS");
    const select = this.parseSelect();
    return { type: "createView", ifNotExists, temp, name, columns, select, sql: this.text(start), loc: this.loc(start) };
  }

  private parseDrop(): Statement {
    const start = this.expect("DROP");
    let object: "TABLE" | "INDEX" | "VIEW";
    if (this.accept("TABLE")) object = "TABLE";
    else if (this.accept("INDEX")) object = "INDEX";
    else if (this.accept("VIEW")) object = "VIEW";
    else this.fail("expected TABLE, INDEX or VIEW after DROP");
    let ifExists = false;
    if (this.accept("IF")) { this.expect("EXISTS"); ifExists = true; }
    const { name } = this.expectQualifiedName("name");
    return { type: "drop", object, ifExists, name, loc: this.loc(start) };
  }

  private parseAlter(): AlterTableStmt {
    const start = this.expect("ALTER");
    this.expect("TABLE");
    const { name: table } = this.expectQualifiedName("table name");
    if (this.accept("RENAME")) {
      if (this.accept("TO")) return { type: "alterTable", table, action: "renameTo", newName: this.expectIdentifier("new table name"), loc: this.loc(start) };
      this.accept("COLUMN");
      const column = this.expectIdentifier("column name");
      this.expect("TO");
      return { type: "alterTable", table, action: "renameColumn", column, newName: this.expectIdentifier("new column name"), loc: this.loc(start) };
    }
    if (this.accept("ADD")) {
      this.accept("COLUMN");
      return { type: "alterTable", table, action: "addColumn", column: this.parseColumnDefinition(), loc: this.loc(start) };
    }
    if (this.accept("DROP")) {
      this.accept("COLUMN");
      return { type: "alterTable", table, action: "dropColumn", column: this.expectIdentifier("column name"), loc: this.loc(start) };
    }
    this.fail("expected RENAME, ADD or DROP after ALTER TABLE");
  }

  // ───────── expressions ─────────
  parseExpr(minPrec = 0): Expr {
    const start = this.peek();
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      let prec: number;
      let not = false;
      let kw = "";
      if (t.kind === "punct") {
        switch (t.text) {
          case "||": prec = PREC_CONCAT; break;
          case "*": case "/": case "%": prec = PREC_MUL; break;
          case "+": case "-": prec = PREC_ADD; break;
          case "<<": case ">>": case "&": case "|": prec = PREC_BIT; break;
          case "<": case "<=": case ">": case ">=": prec = PREC_CMP; break;
          case "=": case "==": case "!=": case "<>": prec = PREC_EQ; break;
          default: return left;
        }
      } else if (t.kind === "ident" && !t.quoted) {
        kw = t.upper;
        if (kw === "NOT") {
          const n = this.peek(1);
          if (n.kind !== "ident" || n.quoted || !["LIKE", "GLOB", "REGEXP", "MATCH", "BETWEEN", "IN", "NULL"].includes(n.upper)) return left;
          not = true; kw = n.upper; prec = PREC_EQ;
        } else {
          switch (kw) {
            case "OR": prec = PREC_OR; break;
            case "AND": prec = PREC_AND; break;
            case "IS": case "IN": case "LIKE": case "GLOB": case "REGEXP": case "MATCH": case "BETWEEN": case "ISNULL": case "NOTNULL": prec = PREC_EQ; break;
            case "COLLATE": prec = PREC_COLLATE; break;
            default: return left;
          }
        }
      } else return left;
      if (prec < minPrec) return left;

      // consume operator token(s)
      this.next();
      if (not) this.next();

      if (t.kind === "punct") {
        const right = this.parseExpr(prec + 1);
        left = { type: "binary", op: t.text as BinaryOp, left, right, loc: this.loc(start) };
        continue;
      }
      switch (kw) {
        case "OR": case "AND": {
          const right = this.parseExpr(prec + 1);
          left = { type: "binary", op: kw, left, right, loc: this.loc(start) };
          break;
        }
        case "COLLATE": left = { type: "collate", expr: left, collation: this.expectIdentifier("collation name"), loc: this.loc(start) }; break;
        case "ISNULL": left = { type: "isnull", not: false, expr: left, loc: this.loc(start) }; break;
        case "NOTNULL": left = { type: "isnull", not: true, expr: left, loc: this.loc(start) }; break;
        case "NULL": left = { type: "isnull", not: true, expr: left, loc: this.loc(start) }; break; // `x NOT NULL`
        case "IS": {
          const isNot = this.accept("NOT");
          if (this.at("DISTINCT")) {
            this.next(); this.expect("FROM");
            const right = this.parseExpr(prec + 1);
            left = { type: "binary", op: isNot ? "IS NOT DISTINCT FROM" : "IS DISTINCT FROM", left, right, loc: this.loc(start) };
          } else if (this.at("NULL")) {
            this.next();
            left = { type: "isnull", not: isNot, expr: left, loc: this.loc(start) };
          } else {
            const right = this.parseExpr(prec + 1);
            left = { type: "binary", op: isNot ? "IS NOT" : "IS", left, right, loc: this.loc(start) };
          }
          break;
        }
        case "BETWEEN": {
          const low = this.parseExpr(PREC_CMP);
          this.expect("AND");
          const high = this.parseExpr(PREC_CMP);
          left = { type: "between", not, expr: left, low, high, loc: this.loc(start) };
          break;
        }
        case "IN": left = this.parseInTail(left, not, start); break;
        case "LIKE": case "GLOB": case "REGEXP": case "MATCH": {
          const right = this.parseExpr(PREC_CMP);
          let escape: Expr | undefined;
          if (this.accept("ESCAPE")) escape = this.parseExpr(PREC_CMP);
          left = { type: "like", op: kw as LikeOp, not, left, right, escape, loc: this.loc(start) };
          break;
        }
        default: this.fail("unexpected operator", t);
      }
    }
  }

  private parseInTail(expr: Expr, not: boolean, start: Token): Expr {
    if (this.acceptPunct("(")) {
      if (this.acceptPunct(")")) return { type: "in", not, expr, list: [], loc: this.loc(start) };
      if (this.atAny("SELECT", "VALUES", "WITH")) {
        const subquery = this.parseSelect();
        this.expectPunct(")");
        return { type: "in", not, expr, subquery, loc: this.loc(start) };
      }
      const list: Expr[] = [];
      do list.push(this.parseExpr()); while (this.acceptPunct(","));
      this.expectPunct(")");
      return { type: "in", not, expr, list, loc: this.loc(start) };
    }
    const { name } = this.expectQualifiedName("table name");
    if (this.atPunct("(")) this.fail("table-valued functions are not supported");
    return { type: "in", not, expr, table: name, loc: this.loc(start) };
  }

  private parsePrefix(): Expr {
    const t = this.peek();
    const start = t;
    switch (t.kind) {
      case "integer": this.next(); return { type: "literal", value: t.value as bigint, loc: this.loc(start) };
      case "real": this.next(); return { type: "literal", value: t.value as number, loc: this.loc(start) };
      case "string": this.next(); return { type: "literal", value: t.value as string, loc: this.loc(start) };
      case "blob": this.next(); return { type: "literal", value: t.value as Uint8Array, loc: this.loc(start) };
      case "param": {
        this.next();
        if (typeof t.value === "number") return { type: "param", index: t.value, loc: this.loc(start) };
        if (typeof t.value === "string") return { type: "param", name: t.value, loc: this.loc(start) };
        return { type: "param", loc: this.loc(start) };
      }
      case "punct": {
        if (t.text === "-" || t.text === "+" || t.text === "~") {
          this.next();
          const operand = this.parseExpr(PREC_UNARY);
          if (operand.type === "literal" && t.text !== "~") {
            // fold signed numeric literals so -9223372036854775808 parses as an integer
            if (typeof operand.value === "bigint") {
              const v = t.text === "-" ? -operand.value : operand.value;
              // -(-9223372036854775808) overflows int64 and becomes REAL, as in SQLite
              return { type: "literal", value: v > 9223372036854775807n ? Number(v) : v, loc: this.loc(start) };
            }
            if (typeof operand.value === "number") {
              // `-9223372036854775808` is INT64_MIN even though its magnitude does not fit an int64
              if (t.text === "-" && this.sql.slice(operand.loc.offset, operand.loc.end) === "9223372036854775808") return { type: "literal", value: -9223372036854775808n, loc: this.loc(start) };
              return { type: "literal", value: t.text === "-" ? -operand.value : operand.value, loc: this.loc(start) };
            }
          }
          return { type: "unary", op: t.text, operand, loc: this.loc(start) };
        }
        if (t.text === "(") {
          this.next();
          if (this.atAny("SELECT", "VALUES", "WITH")) {
            const subquery = this.parseSelect();
            this.expectPunct(")");
            return { type: "subquery", subquery, loc: this.loc(start) };
          }
          const inner = this.parseExpr();
          if (this.atPunct(",")) this.fail("row values are not supported");
          this.expectPunct(")");
          return inner;
        }
        this.fail("expected expression");
      }
      // falls through to error above
      case "eof": this.fail("expected expression");
      case "ident": break;
    }
    // identifiers and keywords
    if (!t.quoted) {
      switch (t.upper) {
        case "NULL": this.next(); return { type: "literal", value: null, loc: this.loc(start) };
        case "TRUE": this.next(); return { type: "literal", value: 1n, loc: this.loc(start) };
        case "FALSE": this.next(); return { type: "literal", value: 0n, loc: this.loc(start) };
        case "CURRENT_TIME": case "CURRENT_DATE": case "CURRENT_TIMESTAMP":
          this.next();
          return { type: "function", name: t.upper.toLowerCase(), args: [], distinct: false, star: false, loc: this.loc(start) };
        case "NOT": {
          this.next();
          if (this.accept("EXISTS")) {
            this.expectPunct("("); const subquery = this.parseSelect(); this.expectPunct(")");
            return { type: "exists", not: true, subquery, loc: this.loc(start) };
          }
          const operand = this.parseExpr(PREC_NOT);
          return { type: "unary", op: "NOT", operand, loc: this.loc(start) };
        }
        case "EXISTS": {
          this.next();
          this.expectPunct("("); const subquery = this.parseSelect(); this.expectPunct(")");
          return { type: "exists", not: false, subquery, loc: this.loc(start) };
        }
        case "CASE": return this.parseCase();
        case "CAST": {
          this.next(); this.expectPunct("(");
          const expr = this.parseExpr();
          this.expect("AS");
          const words: string[] = [];
          while (this.peek().kind === "ident" && !this.atPunct(")") && !this.atPunct("(")) words.push(this.next().text);
          if (words.length === 0) this.fail("expected type name");
          let typeName = words.join(" ");
          if (this.acceptPunct("(")) {
            const args: string[] = [];
            do args.push(this.next().text); while (this.acceptPunct(","));
            this.expectPunct(")");
            typeName += `(${args.join(", ")})`;
          }
          this.expectPunct(")");
          return { type: "cast", expr, typeName, loc: this.loc(start) };
        }
        case "RAISE": {
          this.next(); this.expectPunct("(");
          const a = this.next();
          if (a.kind !== "ident" || !["IGNORE", "ROLLBACK", "ABORT", "FAIL"].includes(a.upper)) this.fail("expected IGNORE, ROLLBACK, ABORT or FAIL", a);
          let message: string | undefined;
          if (this.acceptPunct(",")) { const m = this.next(); if (m.kind !== "string") this.fail("expected error message string", m); message = m.value as string; }
          this.expectPunct(")");
          return { type: "raise", action: a.upper as "IGNORE" | "ROLLBACK" | "ABORT" | "FAIL", message, loc: this.loc(start) };
        }
      }
      if (RESERVED.has(t.upper)) this.fail("expected expression");
    }
    // function call or column reference
    this.next();
    if (this.atPunct("(")) return this.parseFunctionCall(t);
    const name = t.value as string;
    if (this.atPunct(".") && this.isIdentifierToken(this.peek(1))) {
      this.next();
      const second = this.expectIdentifier("column name");
      if (this.atPunct(".") && this.isIdentifierToken(this.peek(1))) {
        this.next();
        const third = this.expectIdentifier("column name");
        return { type: "column", schema: name, table: second, name: third, loc: this.loc(start) };
      }
      return { type: "column", table: name, name: second, loc: this.loc(start) };
    }
    return { type: "column", name, loc: this.loc(start) };
  }

  private parseCase(): Expr {
    const start = this.expect("CASE");
    let operand: Expr | undefined;
    if (!this.at("WHEN")) operand = this.parseExpr();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.accept("WHEN")) {
      const when = this.parseExpr();
      this.expect("THEN");
      whens.push({ when, then: this.parseExpr() });
    }
    if (whens.length === 0) this.fail("expected WHEN");
    let elseExpr: Expr | undefined;
    if (this.accept("ELSE")) elseExpr = this.parseExpr();
    this.expect("END");
    return { type: "case", operand, whens, else: elseExpr, loc: this.loc(start) };
  }

  private parseFunctionCall(nameTok: Token): FunctionExpr {
    this.expectPunct("(");
    const name = (nameTok.value as string).toLowerCase();
    let distinct = false, star = false;
    const args: Expr[] = [];
    if (this.acceptPunct("*")) star = true;
    else if (!this.atPunct(")")) {
      if (this.accept("DISTINCT")) distinct = true; else this.accept("ALL");
      do args.push(this.parseExpr()); while (this.acceptPunct(","));
    }
    this.expectPunct(")");
    let filter: Expr | undefined;
    if (this.at("FILTER") && this.atPunct("(", 1)) {
      this.pos += 2; this.expect("WHERE"); filter = this.parseExpr(); this.expectPunct(")");
    }
    let over: WindowSpec | string | undefined;
    if (this.accept("OVER")) {
      if (this.atPunct("(")) over = this.parseWindowSpec();
      else over = this.expectIdentifier("window name");
    }
    return { type: "function", name, args, distinct, star, filter, over, loc: this.loc(nameTok) };
  }
}

/** Parse one or more `;`-separated statements. Throws `SyntaxError_` with line/column on malformed input. */
export function parse(sql: string): Statement[] {
  return new Parser(tokenize(sql), sql).parseStatements();
}

/** Parse exactly one statement (a trailing `;` is allowed). */
export function parseOne(sql: string): Statement {
  const stmts = parse(sql);
  if (stmts.length !== 1) throw new SyntaxError_(`expected exactly one statement, got ${stmts.length}`, 1, 1);
  return stmts[0]!;
}

/** Parse a standalone expression (e.g. a DEFAULT clause stored in the catalog). */
export function parseExpression(sql: string): Expr {
  const p = new Parser(tokenize(sql), sql);
  const e = p.parseExpr();
  p.expectEnd();
  return e;
}
