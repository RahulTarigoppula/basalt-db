/**
 * Token definitions for the SQL lexer.
 */

/** Token categories produced by the lexer. */
export type TokenKind =
  | "ident"      // bare word (possibly a keyword) or quoted identifier
  | "string"     // 'text literal'
  | "blob"       // X'hex'
  | "integer"    // integer literal (bigint value)
  | "real"       // floating-point literal
  | "param"      // ? ?NNN :name @name $name
  | "punct"      // operator or punctuation
  | "eof";

/** A single lexical token with source position (1-based line/col, 0-based offset). */
export interface Token {
  kind: TokenKind;
  /** Raw source text of the token. */
  text: string;
  /**
   * Decoded value: identifier name (unquoted) for `ident`, decoded string for `string`,
   * bytes for `blob`, bigint for `integer`, number for `real`, parameter name/number for `param`,
   * operator text for `punct`.
   */
  value: string | bigint | number | Uint8Array | null;
  /** Upper-cased bare word for `ident` tokens that were NOT quoted (used for keyword matching); "" otherwise. */
  upper: string;
  /** True when an identifier was quoted ("..", [..], `..`) and therefore can never be a keyword. */
  quoted: boolean;
  line: number;
  col: number;
  offset: number;
  /** Offset one past the last character. */
  end: number;
}

/** Every keyword the parser recognises (SQLite's list, trimmed to what Basalt uses plus common ones). */
export const KEYWORDS: ReadonlySet<string> = new Set([
  "ABORT", "ACTION", "ADD", "AFTER", "ALL", "ALTER", "ALWAYS", "ANALYZE", "AND", "AS", "ASC", "ATTACH", "AUTOINCREMENT",
  "BEFORE", "BEGIN", "BETWEEN", "BY", "CASCADE", "CASE", "CAST", "CHECK", "COLLATE", "COLUMN", "COMMIT", "CONFLICT",
  "CONSTRAINT", "CREATE", "CROSS", "CURRENT", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "DATABASE", "DEFAULT",
  "DEFERRABLE", "DEFERRED", "DELETE", "DESC", "DETACH", "DISTINCT", "DO", "DROP", "EACH", "ELSE", "END", "ESCAPE", "EXCEPT",
  "EXCLUDE", "EXCLUSIVE", "EXISTS", "EXPLAIN", "FAIL", "FALSE", "FILTER", "FIRST", "FOLLOWING", "FOR", "FOREIGN", "FROM", "FULL",
  "GENERATED", "GLOB", "GROUP", "GROUPS", "HAVING", "IF", "IGNORE", "IMMEDIATE", "IN", "INDEX", "INDEXED", "INITIALLY", "INNER",
  "INSERT", "INSTEAD", "INTERSECT", "INTO", "IS", "ISNULL", "JOIN", "KEY", "LAST", "LEFT", "LIKE", "LIMIT", "MATCH",
  "MATERIALIZED", "NATURAL", "NO", "NOT", "NOTHING", "NOTNULL", "NULL", "NULLS", "OF", "OFFSET", "ON", "OR", "ORDER", "OTHERS",
  "OUTER", "OVER", "PARTITION", "PLAN", "PRAGMA", "PRECEDING", "PRIMARY", "QUERY", "RAISE", "RANGE", "RECURSIVE", "REFERENCES",
  "REGEXP", "REINDEX", "RELEASE", "RENAME", "REPLACE", "RESTRICT", "RETURNING", "RIGHT", "ROLLBACK", "ROW", "ROWS", "SAVEPOINT",
  "SELECT", "SET", "TABLE", "TEMP", "TEMPORARY", "THEN", "TIES", "TO", "TRANSACTION", "TRIGGER", "TRUE", "UNBOUNDED", "UNION",
  "UNIQUE", "UPDATE", "USING", "VACUUM", "VALUES", "VIEW", "VIRTUAL", "WHEN", "WHERE", "WINDOW", "WITH", "WITHOUT",
]);

/**
 * Keywords that can NOT be used as bare identifiers (SQLite's reserved subset, slightly extended for parser sanity).
 * Everything in KEYWORDS but not here (e.g. KEY, ROW, FIRST, FILTER, OVER, PARTITION, RANGE) may name a table/column.
 */
export const RESERVED: ReadonlySet<string> = new Set([
  "ADD", "ALL", "ALTER", "AND", "AS", "AUTOINCREMENT", "BETWEEN", "CASE", "CHECK", "COLLATE", "COMMIT", "CONSTRAINT", "CREATE",
  "CROSS", "DEFAULT", "DEFERRABLE", "DELETE", "DISTINCT", "DROP", "ELSE", "ESCAPE", "EXCEPT", "EXISTS", "FOREIGN", "FROM", "FULL",
  "GROUP", "HAVING", "IN", "INDEX", "INNER", "INSERT", "INTERSECT", "INTO", "IS", "ISNULL", "JOIN", "LEFT", "LIMIT", "NATURAL",
  "NOT", "NOTNULL", "NULL", "ON", "OR", "ORDER", "OUTER", "PRIMARY", "REFERENCES", "RIGHT", "SELECT", "SET", "TABLE", "THEN", "TO",
  "TRANSACTION", "UNION", "UNIQUE", "UPDATE", "USING", "VALUES", "WHEN", "WHERE", "WINDOW", "WITH",
]);

/** Returns true when the token is the given (upper-case) keyword written as a bare word. */
export function isKeyword(tok: Token, kw: string): boolean {
  return tok.kind === "ident" && !tok.quoted && tok.upper === kw;
}

/** Returns true when the token is the given punctuation/operator text. */
export function isPunct(tok: Token, p: string): boolean {
  return tok.kind === "punct" && tok.text === p;
}

/** Human-readable description of a token for error messages. */
export function describeToken(tok: Token): string {
  switch (tok.kind) {
    case "eof": return "end of input";
    case "string": return `string '${String(tok.value).replace(/'/g, "''")}'`;
    default: return `'${tok.text}'`;
  }
}
