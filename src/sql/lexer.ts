/**
 * SQL tokenizer. Produces a flat token array with line/column information; errors are `SyntaxError_`.
 */
import { SyntaxError_ } from "../core/errors.js";
import type { Token, TokenKind } from "./token.js";

const PUNCT3 = new Set(["<<=", ">>="]); // not SQL, but keeps the 3-char path generic
const PUNCT2 = new Set(["||", "<<", ">>", "<=", ">=", "==", "!=", "<>", "->"]);
const PUNCT1 = new Set(["*", "/", "%", "+", "-", "&", "|", "<", ">", "=", "~", "(", ")", ",", ";", "."]);

function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127;
}
function isIdentPart(c: number): boolean {
  return isIdentStart(c) || (c >= 48 && c <= 57) || c === 36; // $ allowed inside identifiers like SQLite
}
function isDigit(c: number): boolean { return c >= 48 && c <= 57; }
function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

/** Decode a hexadecimal string (even length, validated by caller) into bytes. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * Tokenize SQL source. The returned array always ends with an `eof` token.
 * @throws SyntaxError_ on unterminated strings/comments or illegal characters.
 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0, line = 1, lineStart = 0;

  const fail = (msg: string, at: number): never => {
    throw new SyntaxError_(`${msg} at ${line}:${at - lineStart + 1}`, line, at - lineStart + 1);
  };
  const push = (kind: TokenKind, start: number, end: number, value: Token["value"], upper = "", quoted = false): void => {
    tokens.push({ kind, text: sql.slice(start, end), value, upper, quoted, line, col: start - lineStart + 1, offset: start, end });
  };

  while (i < n) {
    const c = sql.charCodeAt(i);
    // whitespace
    if (c === 10) { i++; line++; lineStart = i; continue; }
    if (c === 32 || c === 9 || c === 13 || c === 12 || c === 11) { i++; continue; }
    // comments
    if (c === 45 && sql.charCodeAt(i + 1) === 45) { // --
      while (i < n && sql.charCodeAt(i) !== 10) i++;
      continue;
    }
    if (c === 47 && sql.charCodeAt(i + 1) === 42) { // /*
      const start = i;
      const close = sql.indexOf("*/", i + 2);
      if (close < 0) fail("unterminated block comment", start);
      for (let k = i; k < close; k++) if (sql.charCodeAt(k) === 10) { line++; lineStart = k + 1; }
      i = close + 2;
      continue;
    }
    const start = i;
    // string literal
    if (c === 39) {
      let s = "";
      i++;
      for (;;) {
        if (i >= n) fail("unterminated string literal", start);
        const ch = sql.charCodeAt(i);
        if (ch === 39) {
          if (sql.charCodeAt(i + 1) === 39) { s += "'"; i += 2; continue; }
          i++; break;
        }
        if (ch === 10) { s += "\n"; i++; continue; }
        s += sql[i]; i++;
      }
      // recompute line info for multi-line strings
      let ln = line, ls = lineStart;
      for (let k = start; k < i; k++) if (sql.charCodeAt(k) === 10) { ln++; ls = k + 1; }
      tokens.push({ kind: "string", text: sql.slice(start, i), value: s, upper: "", quoted: false, line, col: start - lineStart + 1, offset: start, end: i });
      line = ln; lineStart = ls;
      continue;
    }
    // blob literal X'..'
    if ((c === 88 || c === 120) && sql.charCodeAt(i + 1) === 39) {
      let j = i + 2;
      while (j < n && isHexDigit(sql.charCodeAt(j))) j++;
      if (j >= n || sql.charCodeAt(j) !== 39) fail("malformed blob literal", start);
      const hex = sql.slice(i + 2, j);
      if (hex.length % 2 !== 0) fail("blob literal must have an even number of hex digits", start);
      i = j + 1;
      push("blob", start, i, hexToBytes(hex));
      continue;
    }
    // quoted identifiers
    if (c === 34 || c === 96 || c === 91) { // " ` [
      const closeCh = c === 91 ? 93 : c;
      let name = "";
      i++;
      for (;;) {
        if (i >= n) fail("unterminated quoted identifier", start);
        const ch = sql.charCodeAt(i);
        if (ch === closeCh) {
          if (c !== 91 && sql.charCodeAt(i + 1) === closeCh) { name += sql[i]; i += 2; continue; }
          i++; break;
        }
        name += sql[i]; i++;
      }
      push("ident", start, i, name, "", true);
      continue;
    }
    // numbers
    if (isDigit(c) || (c === 46 && isDigit(sql.charCodeAt(i + 1)))) {
      if (c === 48 && (sql.charCodeAt(i + 1) === 120 || sql.charCodeAt(i + 1) === 88)) { // 0x hex integer
        let j = i + 2;
        while (j < n && isHexDigit(sql.charCodeAt(j))) j++;
        if (j === i + 2) fail("malformed hex literal", start);
        if (j - (i + 2) > 16) fail("hex literal too large", start);
        i = j;
        if (isIdentPart(sql.charCodeAt(i))) fail(`unexpected character '${sql[i]}' after numeric literal`, i);
        push("integer", start, i, BigInt.asIntN(64, BigInt(sql.slice(start, i))));
        continue;
      }
      let j = i, isReal = false;
      while (j < n && isDigit(sql.charCodeAt(j))) j++;
      if (sql.charCodeAt(j) === 46) { isReal = true; j++; while (j < n && isDigit(sql.charCodeAt(j))) j++; }
      if (sql.charCodeAt(j) === 101 || sql.charCodeAt(j) === 69) { // e/E
        let k = j + 1;
        if (sql.charCodeAt(k) === 43 || sql.charCodeAt(k) === 45) k++;
        if (isDigit(sql.charCodeAt(k))) {
          while (k < n && isDigit(sql.charCodeAt(k))) k++;
          j = k; isReal = true;
        }
      }
      i = j;
      if (isIdentPart(sql.charCodeAt(i))) fail(`unexpected character '${sql[i]}' after numeric literal`, i);
      const text = sql.slice(start, i);
      if (isReal) push("real", start, i, Number(text));
      else {
        const big = BigInt(text);
        // integers beyond int64 become REAL, as in SQLite
        if (big > 9223372036854775807n) push("real", start, i, Number(text));
        else push("integer", start, i, big);
      }
      continue;
    }
    // parameters
    if (c === 63) { // ?
      let j = i + 1;
      while (j < n && isDigit(sql.charCodeAt(j))) j++;
      i = j;
      push("param", start, i, j > start + 1 ? Number(sql.slice(start + 1, j)) : null);
      continue;
    }
    if (c === 58 || c === 64 || c === 36) { // : @ $
      let j = i + 1;
      while (j < n && (isIdentPart(sql.charCodeAt(j)) || sql.charCodeAt(j) === 58)) j++;
      if (j === i + 1) fail(`expected parameter name after '${sql[i]}'`, start);
      i = j;
      push("param", start, i, sql.slice(start, i));
      continue;
    }
    // identifiers / keywords
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(sql.charCodeAt(j))) j++;
      i = j;
      const word = sql.slice(start, i);
      push("ident", start, i, word, word.toUpperCase(), false);
      continue;
    }
    // punctuation
    const three = sql.substr(i, 3), two = sql.substr(i, 2), one = sql[i]!;
    if (PUNCT3.has(three)) { i += 3; push("punct", start, i, three); continue; }
    if (PUNCT2.has(two)) { i += 2; push("punct", start, i, two); continue; }
    if (PUNCT1.has(one)) { i += 1; push("punct", start, i, one); continue; }
    fail(`unexpected character '${one}'`, start);
  }
  tokens.push({ kind: "eof", text: "", value: null, upper: "", quoted: false, line, col: i - lineStart + 1, offset: i, end: i });
  return tokens;
}
