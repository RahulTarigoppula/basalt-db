/**
 * Builtin scalar, aggregate and window functions with SQLite semantics, plus the value-coercion helpers shared with
 * the expression compiler (`expr.ts`). Golden behaviour was checked against SQLite 3.4x via `node:sqlite`.
 *
 * Numeric representation: INTEGER is always `bigint`, REAL is always `number` (a `number` is never treated as an
 * integer even when integral). BOOLEAN values coerce to 0/1 integers.
 */
import { BasaltError } from "../core/errors.js";
import { compareValues, type Value } from "../core/types.js";
import type { ExprType, FunctionInfo, FunctionProvider } from "../sql/bound.js";
import type { EvalContext } from "./expr.js";

export const INT64_MAX = 9223372036854775807n;
export const INT64_MIN = -9223372036854775808n;
const TWO63 = 9223372036854775808; // 2^63 as a double

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

// ───────────────────────────────── coercions ─────────────────────────────────

/** SQLite `typeof()` name of a value. */
export function sqlTypeName(v: Value): "null" | "integer" | "real" | "text" | "blob" {
  if (v === null) return "null";
  switch (typeof v) {
    case "bigint": case "boolean": return "integer";
    case "number": return "real";
    case "string": return "text";
    default: return "blob";
  }
}

/** Formats a REAL the way SQLite does (`%!.15g`): 15 significant digits, always a decimal point or exponent. */
export function formatReal(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Inf";
  if (n === -Infinity) return "-Inf";
  if (n === 0) return "0.0";
  const expStr = n.toExponential(14); // d.dddddddddddddde±x
  const ePos = expStr.indexOf("e");
  const exp = Number(expStr.slice(ePos + 1));
  if (exp < -4 || exp >= 15) {
    let mant = expStr.slice(0, ePos);
    if (mant.includes(".")) mant = mant.replace(/0+$/, "");
    if (mant.endsWith(".")) mant += "0";
    if (!mant.includes(".")) mant += ".0";
    const sign = exp < 0 ? "-" : "+";
    const digits = String(Math.abs(exp)).padStart(2, "0");
    return `${mant}e${sign}${digits}`;
  }
  let s = n.toFixed(Math.max(0, 14 - exp));
  if (s.includes(".")) s = s.replace(/0+$/, "");
  if (s.endsWith(".")) s += "0";
  if (!s.includes(".")) s += ".0";
  return s;
}

/** Converts a non-NULL value to TEXT (blobs are decoded as UTF-8). */
export function toText(v: Value): string {
  switch (typeof v) {
    case "string": return v;
    case "bigint": return v.toString();
    case "number": return formatReal(v);
    case "boolean": return v ? "1" : "0";
    case "object": return v === null ? "" : utf8Decoder.decode(v);
    default: return "";
  }
}

/** Converts a non-NULL value to BLOB (text is UTF-8 encoded; numbers via their text form). */
export function toBlob(v: Value): Uint8Array {
  if (v instanceof Uint8Array) return v;
  return utf8Encoder.encode(toText(v));
}

const NUM_PREFIX = /^[ \t\n\r\f\v]*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?/;

/**
 * Parses the longest numeric prefix of `s` (SQLite `sqlite3AtoF`-style). Returns a bigint for integer text that fits
 * in int64, a number otherwise; `null` when there is no numeric prefix at all. `end` is the index after the prefix.
 */
export function parseNumericPrefix(s: string): { value: bigint | number; end: number } | null {
  const m = NUM_PREFIX.exec(s);
  if (!m) return null;
  const sign = m[1]!, intPart = m[2]!, fracPart = m[3], expPart = m[4];
  if (intPart.length === 0 && (fracPart === undefined || fracPart.length === 0)) return null;
  const isReal = fracPart !== undefined || expPart !== undefined;
  const end = m[0]!.length;
  if (!isReal) {
    const big = BigInt(sign + intPart);
    if (big >= INT64_MIN && big <= INT64_MAX) return { value: big, end };
    return { value: Number(sign + intPart), end };
  }
  const text = `${sign}${intPart || "0"}.${fracPart ?? "0"}${expPart !== undefined ? "e" + expPart : ""}`;
  return { value: Number(text), end };
}

/** Numeric value for arithmetic (SQLite semantics): text uses its numeric prefix, non-numeric text/blob -> 0. */
export function toNumeric(v: Value): bigint | number {
  switch (typeof v) {
    case "bigint": case "number": return v;
    case "boolean": return v ? 1n : 0n;
    case "string": return parseNumericPrefix(v)?.value ?? 0n;
    case "object": return v === null ? 0n : (parseNumericPrefix(utf8Decoder.decode(v))?.value ?? 0n);
    default: return 0n;
  }
}

/**
 * Numeric value if the whole text is numeric (whitespace allowed), as `sqlite3_value_numeric_type()` does;
 * returns null for NULL, blobs and non-numeric text (the math functions then yield NULL).
 */
export function toNumericStrict(v: Value): bigint | number | null {
  switch (typeof v) {
    case "bigint": case "number": return v;
    case "boolean": return v ? 1n : 0n;
    case "string": {
      const p = parseNumericPrefix(v);
      if (!p) return null;
      return /^[ \t\n\r\f\v]*$/.test(v.slice(p.end)) ? p.value : null;
    }
    default: return null;
  }
}

/** Truncates a double toward zero and clamps into int64 (NaN -> 0). */
export function doubleToInt64(n: number): bigint {
  if (Number.isNaN(n)) return 0n;
  if (n >= TWO63) return INT64_MAX;
  if (n <= -TWO63) return INT64_MIN;
  return BigInt(Math.trunc(n));
}

/** Integer value for bitwise operators (`sqlite3VdbeIntValue`): reals truncate, text uses its numeric prefix. */
export function toInt64(v: Value): bigint {
  const n = toNumeric(v);
  return typeof n === "bigint" ? n : doubleToInt64(n);
}

/** Converts to a double (`sqlite3_value_double`): text uses its numeric prefix, otherwise 0.0. */
export function toDouble(v: Value): number {
  const n = toNumeric(v);
  return typeof n === "bigint" ? Number(n) : n;
}

/** SQL truth value: NULL -> null, numbers ≠ 0 -> true, text/blob via numeric prefix. */
export function truthy(v: Value): boolean | null {
  if (v === null) return null;
  switch (typeof v) {
    case "bigint": return v !== 0n;
    case "number": return v !== 0 && !Number.isNaN(v);
    case "boolean": return v;
    default: { const n = toNumeric(v); return typeof n === "bigint" ? n !== 0n : n !== 0; }
  }
}

/** Normalises booleans to integers so `compareValues` treats TRUE like 1. */
export function normalize(v: Value): Value {
  return typeof v === "boolean" ? (v ? 1n : 0n) : v;
}

/** `CAST(v AS INTEGER)`: longest integer prefix of text; reals truncate toward zero; clamped to int64. */
export function castToInteger(v: Value): Value {
  if (v === null) return null;
  switch (typeof v) {
    case "bigint": return v;
    case "number": return doubleToInt64(v);
    case "boolean": return v ? 1n : 0n;
    default: {
      const s = typeof v === "string" ? v : utf8Decoder.decode(v);
      const m = /^[ \t\n\r\f\v]*([+-]?\d+)/.exec(s);
      if (!m) return 0n;
      const big = BigInt(m[1]!);
      return big > INT64_MAX ? INT64_MAX : big < INT64_MIN ? INT64_MIN : big;
    }
  }
}

/** `CAST(v AS REAL)`. */
export function castToReal(v: Value): Value {
  if (v === null) return null;
  switch (typeof v) {
    case "number": return v;
    case "bigint": return Number(v);
    case "boolean": return v ? 1 : 0;
    default: {
      const p = parseNumericPrefix(typeof v === "string" ? v : utf8Decoder.decode(v));
      return p ? Number(p.value) : 0;
    }
  }
}

/** `CAST(v AS NUMERIC)`: text becomes INTEGER when it is integral and fits, else REAL; numbers are unchanged. */
export function castToNumeric(v: Value): Value {
  if (v === null) return null;
  switch (typeof v) {
    case "number": case "bigint": return v;
    case "boolean": return v ? 1n : 0n;
    default: {
      const p = parseNumericPrefix(typeof v === "string" ? v : utf8Decoder.decode(v));
      if (!p) return 0n;
      if (typeof p.value === "bigint") return p.value;
      const n = p.value;
      if (Number.isInteger(n) && Math.abs(n) < TWO63) return BigInt(n);
      return n;
    }
  }
}

/** Apply a CAST. "BOOLEAN" follows SQLite (NUMERIC affinity). */
export function castValue(v: Value, target: "INTEGER" | "REAL" | "TEXT" | "BLOB" | "BOOLEAN" | "NULL" | "NUMERIC"): Value {
  if (v === null) return null;
  switch (target) {
    case "INTEGER": return castToInteger(v);
    case "REAL": return castToReal(v);
    case "TEXT": return toText(v);
    case "BLOB": return toBlob(v);
    case "NUMERIC": case "BOOLEAN": return castToNumeric(v);
    case "NULL": return null;
  }
}

// ───────────────────────────────── LIKE / GLOB ─────────────────────────────────

const patternCache = new Map<string, RegExp>();

function cached(key: string, build: () => RegExp): RegExp {
  let re = patternCache.get(key);
  if (!re) {
    if (patternCache.size > 512) patternCache.clear();
    re = build();
    patternCache.set(key, re);
  }
  return re;
}

function regexEscape(ch: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(ch) ? "\\" + ch : ch;
}

/** Compiles a LIKE pattern (ASCII case-insensitive, `%`/`_`, optional single-character ESCAPE) into a RegExp. */
export function compileLike(pattern: string, escape?: string): RegExp {
  if (escape !== undefined && [...escape].length !== 1) throw new BasaltError("ESCAPE expression must be a single character", "ERROR");
  return cached(`L${escape ?? ""}\u0000${pattern}`, () => {
    let re = "^";
    const chars = [...pattern];
    for (let i = 0; i < chars.length; i++) {
      let c = chars[i]!;
      if (escape !== undefined && c === escape) {
        if (i + 1 >= chars.length) break;
        c = chars[++i]!;
        re += literalLikeChar(c);
        continue;
      }
      if (c === "%") re += "[\\s\\S]*";
      else if (c === "_") re += "[\\s\\S]";
      else re += literalLikeChar(c);
    }
    return new RegExp(re + "$", "u");
  });
}

function literalLikeChar(c: string): string {
  const code = c.charCodeAt(0);
  if (c.length === 1 && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) return `[${c.toLowerCase()}${c.toUpperCase()}]`;
  return regexEscape(c);
}

/** Compiles a GLOB pattern (`*`, `?`, `[...]`, `[^...]`, case-sensitive) into a RegExp. */
export function compileGlob(pattern: string): RegExp {
  return cached(`G\u0000${pattern}`, () => {
    let re = "^";
    const chars = [...pattern];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!;
      if (c === "*") re += "[\\s\\S]*";
      else if (c === "?") re += "[\\s\\S]";
      else if (c === "[") {
        let j = i + 1;
        let cls = "[";
        if (chars[j] === "^") { cls += "^"; j++; }
        if (chars[j] === "]") { cls += "\\]"; j++; }
        let closed = false;
        while (j < chars.length) {
          const d = chars[j]!;
          if (d === "]") { closed = true; break; }
          if (chars[j + 1] === "-" && j + 2 < chars.length && chars[j + 2] !== "]") {
            cls += `${regexEscape(d)}-${regexEscape(chars[j + 2]!)}`;
            j += 3;
            continue;
          }
          cls += regexEscape(d);
          j++;
        }
        if (!closed) return /(?!)/u; // unterminated class never matches (SQLite)
        re += cls + "]";
        i = j;
      } else re += regexEscape(c);
    }
    return new RegExp(re + "$", "u");
  });
}

/** `x LIKE pattern [ESCAPE e]` with SQLite semantics (NULL if either operand is NULL). */
export function sqlLike(pattern: Value, text: Value, escape?: Value): Value {
  if (pattern === null || text === null) return null;
  if (escape === null) return null;
  return compileLike(toText(pattern), escape === undefined ? undefined : toText(escape)).test(toText(text)) ? 1n : 0n;
}

/** `x GLOB pattern`. */
export function sqlGlob(pattern: Value, text: Value): Value {
  if (pattern === null || text === null) return null;
  return compileGlob(toText(pattern)).test(toText(text)) ? 1n : 0n;
}

// ───────────────────────────────── printf ─────────────────────────────────

function padTo(s: string, width: number, left: boolean, zero: boolean): string {
  if (s.length >= width) return s;
  if (zero && !left) {
    // zero padding goes after the sign
    const prefixLen = (s.startsWith("-") || s.startsWith("+") || s.startsWith(" ")) ? 1 : 0;
    return s.slice(0, prefixLen) + "0".repeat(width - s.length) + s.slice(prefixLen);
  }
  return left ? s + " ".repeat(width - s.length) : " ".repeat(width - s.length) + s;
}

/**
 * Decimal digits of a finite non-negative double the way SQLite's `sqlite3FpDecode` extracts them: the exact
 * expansion truncated to the 18 or 19 significant digits that fit a u64 after scaling into [2^63/10, 2^63).
 * `digits[0]` is the digit at 10^exp. Callers then round half-up at the requested position (≤ 16 significant
 * digits, or 26 with the `!` flag - which never exceeds what was extracted).
 */
function decodeDouble(v: number): { digits: string; exp: number } {
  if (v === 0) return { digits: "0", exp: 0 };
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, v);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const biasedExp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2: number;
  if (biasedExp === 0) e2 = -1074;
  else { mant |= 1n << 52n; e2 = biasedExp - 1075; }
  let digits: string, exp: number;
  if (e2 >= 0) {
    digits = (mant << BigInt(e2)).toString();
    exp = digits.length - 1;
  } else {
    const k = -e2;
    digits = (mant * 5n ** BigInt(k)).toString();
    exp = digits.length - 1 - k;
  }
  // SQLite scales the value so the integer part fits a u64 below 2^63: 19 digits when the leading 19-digit prefix is
  // below 9223372036854774784, otherwise 18. Digits beyond that are discarded (truncation, not rounding).
  const limit = digits.length >= 19 && digits.slice(0, 19) >= "9223372036854774784" ? 18 : 19;
  if (digits.length > limit) digits = digits.slice(0, limit);
  digits = digits.replace(/0+$/, "");
  return { digits: digits || "0", exp };
}

/** Round extracted digits half-up to `n` significant digits, never exceeding the `maxSig` cap (16, or 26 with `!`). */
function significant(d: { digits: string; exp: number }, n: number, maxSig: number): { digits: string; carry: boolean } {
  return roundDigits(d.digits, Math.min(n, maxSig));
}

/** Round a digit string half-up to `n` digits (n ≥ 0). Returns the digits (length ≤ n) and whether a carry added a digit. */
function roundDigits(digits: string, n: number): { digits: string; carry: boolean } {
  if (digits.length <= n) return { digits, carry: false };
  if (n < 0) return { digits: "", carry: false };
  const head = digits.slice(0, n);
  if (digits.charCodeAt(n) < 53) return { digits: head, carry: false }; // next digit < '5'
  if (n === 0) return { digits: "1", carry: true };
  const up = (BigInt(head) + 1n).toString();
  if (up.length > head.length) return { digits: up.slice(0, n), carry: true };
  return { digits: up.padStart(n, "0"), carry: false };
}

function expSuffix(exp: number, upper: boolean): string {
  return `${upper ? "E" : "e"}${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/** `%e` on a non-negative finite double with SQLite's digit handling. */
function formatExp(v: number, precision: number, upper: boolean, maxSig: number): string {
  const d = decodeDouble(v);
  const r = significant(d, precision + 1, maxSig);
  const exp = v === 0 ? 0 : d.exp + (r.carry ? 1 : 0);
  const all = r.digits.padEnd(precision + 1, "0");
  const mant = precision > 0 ? `${all[0]}.${all.slice(1)}` : all;
  return mant + expSuffix(exp, upper);
}

/** `%f` on a non-negative finite double with SQLite's digit handling. */
function formatFixed(v: number, precision: number, maxSig: number): string {
  const d = decodeDouble(v);
  // number of significant digits that survive at `precision` decimals
  const keep = d.exp + 1 + precision;
  let digits: string, exp = d.exp;
  if (v === 0 || keep < 0) { digits = ""; exp = -precision - 1; }
  else {
    const r = significant(d, keep, maxSig);
    digits = r.digits;
    if (r.carry) exp++;
    if (keep === 0 && r.carry) { digits = "1"; exp = -precision; }
  }
  // build integer and fraction parts from digits positioned at 10^exp
  let intPart: string, frac: string;
  if (digits === "") { intPart = "0"; frac = "".padEnd(precision, "0"); }
  else if (exp >= 0) {
    const padded = digits.padEnd(exp + 1 + precision, "0");
    intPart = padded.slice(0, exp + 1);
    frac = padded.slice(exp + 1, exp + 1 + precision);
  } else {
    intPart = "0";
    frac = ("0".repeat(-exp - 1) + digits).padEnd(precision, "0").slice(0, precision);
  }
  return precision > 0 ? `${intPart}.${frac}` : intPart;
}

/** `%g` on a non-negative finite double with SQLite's digit handling. */
function formatG(v: number, precision: number, upper: boolean, alt: boolean, maxSig: number): string {
  if (precision === 0) precision = 1;
  const d = decodeDouble(v);
  const r = significant(d, precision, maxSig);
  const exp = v === 0 ? 0 : d.exp + (r.carry ? 1 : 0);
  let s: string;
  if (exp < -4 || exp >= precision) {
    s = formatExp(v, precision - 1, upper, maxSig);
    if (!alt) s = s.replace(/\.?0+(?=[eE])/, "");
  } else {
    s = formatFixed(v, Math.max(0, precision - 1 - exp), maxSig);
    if (!alt && s.includes(".")) s = s.replace(/\.?0+$/, "");
  }
  return s;
}

function formatInf(v: number): string { return Number.isNaN(v) ? "NaN" : "Inf"; }

function thousands(s: string): string {
  const neg = s.startsWith("-") || s.startsWith("+") || s.startsWith(" ");
  const sign = neg ? s[0]! : "";
  const digits = neg ? s.slice(1) : s;
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** SQLite `printf()`/`format()`: %d %i %u %s %f %e %E %g %G %x %X %o %c %q %Q %w %% with flags `-+ 0#!,`, width and precision. */
export function sqlPrintf(format: string, args: readonly Value[]): string {
  let out = "";
  let argi = 0;
  const nextArg = (): Value => (argi < args.length ? args[argi++]! : null);
  const n = format.length;
  for (let i = 0; i < n; i++) {
    const ch = format[i]!;
    if (ch !== "%") { out += ch; continue; }
    i++;
    if (i >= n) { out += "%"; break; }
    let left = false, plus = false, space = false, zero = false, alt = false, alt2 = false, comma = false;
    for (; i < n; i++) {
      const f = format[i]!;
      if (f === "-") left = true; else if (f === "+") plus = true; else if (f === " ") space = true;
      else if (f === "0") zero = true; else if (f === "#") alt = true; else if (f === "!") alt2 = true; else if (f === ",") comma = true;
      else break;
    }
    let width = 0;
    if (format[i] === "*") { width = Number(toInt64(nextArg())); if (width < 0) { left = true; width = -width; } i++; }
    else while (i < n && format[i]! >= "0" && format[i]! <= "9") width = width * 10 + (format.charCodeAt(i++) - 48);
    let precision = -1;
    if (format[i] === ".") {
      i++; precision = 0;
      if (format[i] === "*") { precision = Number(toInt64(nextArg())); i++; }
      else while (i < n && format[i]! >= "0" && format[i]! <= "9") precision = precision * 10 + (format.charCodeAt(i++) - 48);
    }
    while (i < n && (format[i] === "l" || format[i] === "h" || format[i] === "z" || format[i] === "j" || format[i] === "t")) i++;
    if (i >= n) break;
    const conv = format[i]!;
    let s: string;
    switch (conv) {
      case "d": case "i": case "u": {
        const a = nextArg();
        let v = a === null ? 0n : (typeof a === "number" ? doubleToInt64(a) : toInt64(a));
        const neg = v < 0n;
        if (neg) v = -v;
        const signStr = neg ? "-" : plus ? "+" : space ? " " : "";
        // SQLite turns the 0 flag into a minimum digit count, so it wins over '-'
        if (zero && precision < width - signStr.length) precision = width - signStr.length;
        let digits = v.toString();
        if (precision >= 0) digits = digits.padStart(precision, "0");
        if (comma) digits = thousands(digits);
        s = padTo(signStr + digits, width, left, false);
        break;
      }
      case "x": case "X": case "o": {
        const a = nextArg();
        const v = BigInt.asUintN(64, a === null ? 0n : (typeof a === "number" ? doubleToInt64(a) : toInt64(a)));
        if (zero && precision < width) precision = width;
        let digits = v.toString(conv === "o" ? 8 : 16);
        if (conv === "X") digits = digits.toUpperCase();
        if (precision >= 0) digits = digits.padStart(precision, "0");
        if (alt && v !== 0n) digits = (conv === "o" ? "0" : conv === "X" ? "0X" : "0x") + digits;
        s = padTo(digits, width, left, false);
        break;
      }
      case "f": case "e": case "E": case "g": case "G": {
        const a = nextArg();
        const v = a === null ? 0 : toDouble(a);
        const prec = precision < 0 ? 6 : precision;
        const maxSig = alt2 ? 26 : 16;
        let body: string;
        if (!Number.isFinite(v)) body = formatInf(v);
        else if (conv === "f") {
          body = formatFixed(Math.abs(v), prec, maxSig);
          if (alt && prec === 0) body += ".";
          if (alt2 && body.includes(".")) { body = body.replace(/0+$/, ""); if (body.endsWith(".")) body += "0"; }
        } else if (conv === "e" || conv === "E") body = formatExp(Math.abs(v), prec, conv === "E", maxSig);
        else body = formatG(Math.abs(v), prec, conv === "G", alt, maxSig);
        const sign = v < 0 ? "-" : plus ? "+" : space ? " " : ""; // -0.0 prints unsigned, as in SQLite
        s = padTo(sign + body, width, left, zero && Number.isFinite(v));
        break;
      }
      case "s": case "z": {
        const a = nextArg();
        s = a === null ? "" : toText(a);
        if (alt2 && typeof a === "number") s = formatReal(a);
        if (precision >= 0) s = [...s].slice(0, precision).join("");
        s = padTo(s, width, left, false);
        break;
      }
      case "c": {
        const a = nextArg();
        // SQLite's %c takes the first character of the argument's text form (so 65 -> "6", not "A")
        s = a === null ? "" : [...toText(a)].slice(0, 1).join("");
        s = padTo(s, width, left, false);
        break;
      }
      case "q": case "Q": case "w": {
        const a = nextArg();
        if (a === null) s = conv === "Q" ? "NULL" : "(NULL)";
        else {
          let t = a instanceof Uint8Array ? utf8Decoder.decode(a) : toText(a);
          if (precision >= 0) t = [...t].slice(0, precision).join("");
          if (conv === "w") s = t.replace(/"/g, "\"\"");
          else { s = t.replace(/'/g, "''"); if (conv === "Q") s = `'${s}'`; }
        }
        s = padTo(s, width, left, false);
        break;
      }
      case "%": s = padTo("%", width, left, false); break;
      case "n": case "p": case "r": case "T": case "S": s = ""; break; // unsupported internal conversions
      default: s = ""; break;
    }
    out += s;
  }
  return out;
}

// ───────────────────────────────── scalar functions ─────────────────────────────────

/** A scalar builtin. `call` receives already-evaluated arguments; it must not retain the `args` array. */
export interface ScalarFunction {
  name: string;
  minArgs: number;
  /** -1 = variadic */
  maxArgs: number;
  deterministic: boolean;
  returnType(argTypes: readonly ExprType[]): ExprType;
  call(args: readonly Value[], ctx: EvalContext): Value;
}

/** An aggregate: `init` creates per-group state, `step` folds a row, `final` produces the result. */
export interface AggregateFunction<S = unknown> {
  name: string;
  minArgs: number;
  maxArgs: number;
  returnType(argTypes: readonly ExprType[]): ExprType;
  init(): S;
  step(state: S, args: readonly Value[]): void;
  final(state: S): Value;
}

/**
 * Per-row view of a window partition handed to a `WindowFunction`. Indexes are 0-based positions within the
 * partition (sorted by the window ORDER BY). Frame and peer bounds are inclusive; an empty frame has `frameEnd < frameStart`.
 */
export interface WindowFrameContext {
  /** Evaluated function arguments for every partition row: `args[row][argIndex]`. */
  readonly args: readonly (readonly Value[])[];
  readonly size: number;
  readonly index: number;
  readonly frameStart: number;
  readonly frameEnd: number;
  /** Bounds of the current row's ORDER BY peer group (the whole partition when there is no ORDER BY). */
  readonly peerStart: number;
  readonly peerEnd: number;
  /** 0-based ordinal of the current peer group within the partition. */
  readonly peerGroup: number;
  /** True when row `i` is removed from the frame by an EXCLUDE clause (default: never). */
  isExcluded?(i: number): boolean;
}

/** A pure window function (not an aggregate-as-window). */
export interface WindowFunction {
  name: string;
  minArgs: number;
  maxArgs: number;
  returnType(argTypes: readonly ExprType[]): ExprType;
  compute(w: WindowFrameContext): Value;
}

const INTEGER = (): ExprType => "INTEGER";
const REAL = (): ExprType => "REAL";
const TEXT = (): ExprType => "TEXT";
const BLOB = (): ExprType => "BLOB";
const ANY = (): ExprType => "ANY";
const FIRST_ARG = (t: readonly ExprType[]): ExprType => t[0] ?? "ANY";
const nullable = (f: (t: readonly ExprType[]) => ExprType) => (t: readonly ExprType[]): ExprType => (t.some((x) => x === "NULL") ? "NULL" : f(t));

function scalar(name: string, minArgs: number, maxArgs: number, returnType: (t: readonly ExprType[]) => ExprType, call: ScalarFunction["call"], deterministic = true): ScalarFunction {
  return { name, minArgs, maxArgs, deterministic, returnType, call };
}

/** Code points of a text value (SQLite counts characters, not UTF-16 units). */
function codePoints(s: string): string[] { return [...s]; }

/** SQLite `substr()` index arithmetic shared by text and blob variants. Returns [start, end) over `len` units. */
function substrRange(len: number, p1: bigint, p2: bigint | undefined): [number, number] {
  const n = BigInt(len);
  let a = p1;
  let b = p2 === undefined ? n + 1n : p2;
  if (a < 0n) { a = n + a; if (a < 0n) { if (b >= 0n) b += a; a = 0n; } }
  else if (a > 0n) a--;
  else if (b > 0n) b--; // p1 == 0: SQLite treats it as 1 but shortens by one
  if (b < 0n) { a += b; b = -b; if (a < 0n) { b += a; a = 0n; } }
  if (a > n) a = n;
  if (b < 0n) b = 0n;
  let e = a + b;
  if (e > n) e = n;
  return [Number(a), Number(e)];
}

function substr(args: readonly Value[]): Value {
  const x = args[0]!, a1 = args[1]!, a2 = args[2];
  if (x === null || a1 === null || a2 === null) return null;
  const p1 = toInt64(a1);
  const p2 = a2 === undefined ? undefined : toInt64(a2);
  if (x instanceof Uint8Array) {
    const [s, e] = substrRange(x.length, p1, p2);
    return x.slice(s, e);
  }
  const cps = codePoints(toText(x));
  const [s, e] = substrRange(cps.length, p1, p2);
  return cps.slice(s, e).join("");
}

function trimImpl(args: readonly Value[], left: boolean, right: boolean): Value {
  const x = args[0]!;
  if (x === null) return null;
  if (args.length > 1 && args[1] === null) return null;
  const s = toText(x);
  const set = args.length > 1 ? new Set(codePoints(toText(args[1]!))) : new Set([" "]);
  const cps = codePoints(s);
  let a = 0, b = cps.length;
  if (left) while (a < b && set.has(cps[a]!)) a++;
  if (right) while (b > a && set.has(cps[b - 1]!)) b--;
  return cps.slice(a, b).join("");
}

function hexOf(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s.toUpperCase();
}

function mathUnary(name: string, f: (x: number) => number): ScalarFunction {
  return scalar(name, 1, 1, nullable(REAL), (a) => {
    const n = toNumericStrict(a[0]!);
    if (n === null) return null;
    const r = f(Number(n));
    return Number.isNaN(r) ? null : r;
  });
}

/** Round half away from zero to `digits` decimals using SQLite's algorithm. */
function roundDouble(r: number, digits: number): number {
  if (!Number.isFinite(r)) return r;
  if (r < -4503599627370496 || r > 4503599627370496) return r;
  if (digits <= 0) return r < 0 ? Math.ceil(r - 0.5) : Math.floor(r + 0.5);
  const v = Number(r.toFixed(Math.min(digits, 30)));
  return v === 0 ? 0 : v;
}

function randomInt64(ctx: EvalContext): bigint {
  const rnd = ctx.random ?? Math.random;
  const hi = BigInt(Math.floor(rnd() * 0x100000000)), lo = BigInt(Math.floor(rnd() * 0x100000000));
  return BigInt.asIntN(64, (hi << 32n) | lo);
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function nowDate(ctx: EvalContext): Date { return new Date(ctx.now ? ctx.now() : Date.now()); }

const SCALARS: ScalarFunction[] = [
  scalar("length", 1, 1, nullable(INTEGER), (a) => {
    const x = a[0]!;
    if (x === null) return null;
    if (x instanceof Uint8Array) return BigInt(x.length);
    const t = toText(x);
    const nul = t.indexOf("\0");
    return BigInt(codePoints(nul < 0 ? t : t.slice(0, nul)).length);
  }),
  scalar("upper", 1, 1, nullable(TEXT), (a) => (a[0] === null ? null : toText(a[0]!).replace(/[a-z]+/g, (m) => m.toUpperCase()))),
  scalar("lower", 1, 1, nullable(TEXT), (a) => (a[0] === null ? null : toText(a[0]!).replace(/[A-Z]+/g, (m) => m.toLowerCase()))),
  scalar("substr", 2, 3, nullable((t) => (t[0] === "BLOB" ? "BLOB" : "TEXT")), substr),
  scalar("substring", 2, 3, nullable((t) => (t[0] === "BLOB" ? "BLOB" : "TEXT")), substr),
  scalar("instr", 2, 2, nullable(INTEGER), (a) => {
    const x = a[0]!, y = a[1]!;
    if (x === null || y === null) return null;
    if (x instanceof Uint8Array && y instanceof Uint8Array) {
      outer: for (let i = 0; i + y.length <= x.length; i++) {
        for (let j = 0; j < y.length; j++) if (x[i + j] !== y[j]) continue outer;
        return BigInt(i + 1);
      }
      return 0n;
    }
    const hay = codePoints(toText(x)), needle = toText(y);
    const idx = hay.join("").indexOf(needle);
    if (idx < 0) return 0n;
    return BigInt(codePoints(hay.join("").slice(0, idx)).length + 1);
  }),
  scalar("replace", 3, 3, nullable(TEXT), (a) => {
    if (a[0] === null || a[1] === null || a[2] === null) return null;
    const s = toText(a[0]!), from = toText(a[1]!), to = toText(a[2]!);
    if (from === "") return s;
    return s.split(from).join(to);
  }),
  scalar("trim", 1, 2, nullable(TEXT), (a) => trimImpl(a, true, true)),
  scalar("ltrim", 1, 2, nullable(TEXT), (a) => trimImpl(a, true, false)),
  scalar("rtrim", 1, 2, nullable(TEXT), (a) => trimImpl(a, false, true)),
  scalar("abs", 1, 1, nullable((t) => (t[0] === "INTEGER" ? "INTEGER" : "REAL")), (a) => {
    const x = a[0]!;
    if (x === null) return null;
    if (typeof x === "bigint" || typeof x === "boolean") {
      const v = typeof x === "boolean" ? (x ? 1n : 0n) : x;
      if (v === INT64_MIN) throw new BasaltError("integer overflow", "ERROR");
      return v < 0n ? -v : v;
    }
    const r = toDouble(x);
    return r < 0 ? -r : r; // keeps -0.0 like SQLite
  }),
  scalar("round", 1, 2, nullable(REAL), (a) => {
    if (a[0] === null || a[1] === null) return null;
    const r = toDouble(a[0]!);
    const digits = a.length > 1 ? Number(toInt64(a[1]!)) : 0;
    return roundDouble(r, digits);
  }),
  scalar("floor", 1, 1, nullable(FIRST_ARG), (a) => { const n = toNumericStrict(a[0]!); return n === null ? null : typeof n === "bigint" ? n : Math.floor(n); }),
  scalar("ceil", 1, 1, nullable(FIRST_ARG), (a) => { const n = toNumericStrict(a[0]!); return n === null ? null : typeof n === "bigint" ? n : Math.ceil(n); }),
  scalar("ceiling", 1, 1, nullable(FIRST_ARG), (a) => { const n = toNumericStrict(a[0]!); return n === null ? null : typeof n === "bigint" ? n : Math.ceil(n); }),
  scalar("trunc", 1, 1, nullable(FIRST_ARG), (a) => { const n = toNumericStrict(a[0]!); return n === null ? null : typeof n === "bigint" ? n : Math.trunc(n); }),
  mathUnary("sqrt", Math.sqrt),
  mathUnary("exp", Math.exp),
  mathUnary("ln", (x) => (x <= 0 ? NaN : Math.log(x))),
  mathUnary("log10", (x) => (x <= 0 ? NaN : Math.log10(x))),
  mathUnary("log2", (x) => (x <= 0 ? NaN : Math.log2(x))),
  mathUnary("sin", Math.sin), mathUnary("cos", Math.cos), mathUnary("tan", Math.tan),
  mathUnary("asin", Math.asin), mathUnary("acos", Math.acos), mathUnary("atan", Math.atan),
  mathUnary("sinh", Math.sinh), mathUnary("cosh", Math.cosh), mathUnary("tanh", Math.tanh),
  mathUnary("asinh", Math.asinh), mathUnary("acosh", Math.acosh), mathUnary("atanh", Math.atanh),
  mathUnary("degrees", (x) => (x * 180) / Math.PI),
  mathUnary("radians", (x) => (x * Math.PI) / 180),
  scalar("log", 1, 2, nullable(REAL), (a) => {
    if (a.length === 1) { const n = toNumericStrict(a[0]!); if (n === null) return null; const x = Number(n); return x <= 0 ? null : Math.log10(x); }
    const b = toNumericStrict(a[0]!), x = toNumericStrict(a[1]!);
    if (b === null || x === null) return null;
    const bn = Number(b), xn = Number(x);
    if (bn <= 0 || xn <= 0 || bn === 1) return null;
    const r = Math.log(xn) / Math.log(bn);
    return Number.isFinite(r) ? r : null;
  }),
  scalar("atan2", 2, 2, nullable(REAL), (a) => { const y = toNumericStrict(a[0]!), x = toNumericStrict(a[1]!); return y === null || x === null ? null : Math.atan2(Number(y), Number(x)); }),
  scalar("pow", 2, 2, nullable(REAL), (a) => {
    const x = toNumericStrict(a[0]!), y = toNumericStrict(a[1]!);
    if (x === null || y === null) return null;
    const r = Math.pow(Number(x), Number(y));
    return Number.isNaN(r) ? null : r;
  }),
  scalar("power", 2, 2, nullable(REAL), (a) => {
    const x = toNumericStrict(a[0]!), y = toNumericStrict(a[1]!);
    if (x === null || y === null) return null;
    const r = Math.pow(Number(x), Number(y));
    return Number.isNaN(r) ? null : r;
  }),
  scalar("mod", 2, 2, nullable(REAL), (a) => {
    const x = toNumericStrict(a[0]!), y = toNumericStrict(a[1]!);
    if (x === null || y === null) return null;
    const yn = Number(y);
    if (yn === 0) return null;
    return Number(x) % yn;
  }),
  scalar("pi", 0, 0, REAL, () => Math.PI),
  scalar("sign", 1, 1, nullable(INTEGER), (a) => {
    const n = toNumericStrict(a[0]!);
    if (n === null) return null;
    if (typeof n === "bigint") return n > 0n ? 1n : n < 0n ? -1n : 0n;
    return n > 0 ? 1n : n < 0 ? -1n : 0n;
  }),
  scalar("min", 2, -1, (t) => (t.every((x) => x === t[0]) ? t[0]! : "ANY"), (a) => {
    let best: Value = a[0]!;
    if (best === null) return null;
    for (let i = 1; i < a.length; i++) {
      const v = a[i]!;
      if (v === null) return null;
      if (compareValues(normalize(v), normalize(best)) <= 0) best = v; // ties take the later argument (SQLite)
    }
    return best;
  }),
  scalar("max", 2, -1, (t) => (t.every((x) => x === t[0]) ? t[0]! : "ANY"), (a) => {
    let best: Value = a[0]!;
    if (best === null) return null;
    for (let i = 1; i < a.length; i++) {
      const v = a[i]!;
      if (v === null) return null;
      if (compareValues(normalize(v), normalize(best)) > 0) best = v;
    }
    return best;
  }),
  scalar("typeof", 1, 1, TEXT, (a) => sqlTypeName(a[0]!)),
  scalar("hex", 1, 1, TEXT, (a) => (a[0] === null ? "" : hexOf(toBlob(a[0]!)))),
  scalar("unhex", 1, 2, nullable(BLOB), (a) => {
    if (a[0] === null || a[1] === null) return null;
    const s = toText(a[0]!);
    const ignore = a.length > 1 ? toText(a[1]!) : "";
    // leading/trailing ignore characters are allowed, interior ones only between byte pairs
    const cps = codePoints(s);
    let i = 0, j = cps.length;
    while (i < j && ignore.includes(cps[i]!)) i++;
    while (j > i && ignore.includes(cps[j - 1]!)) j--;
    const bytes: number[] = [];
    while (i < j) {
      const h = cps[i]!, l = cps[i + 1];
      if (l === undefined || !/^[0-9a-fA-F]$/.test(h) || !/^[0-9a-fA-F]$/.test(l)) return null;
      bytes.push(parseInt(h + l, 16));
      i += 2;
      while (i < j && ignore.includes(cps[i]!)) i++;
    }
    return new Uint8Array(bytes);
  }),
  scalar("random", 0, 0, INTEGER, (_a, ctx) => randomInt64(ctx), false),
  scalar("randomblob", 1, 1, BLOB, (a, ctx) => {
    let n = a[0] === null ? 1 : Number(toInt64(a[0]!));
    if (n < 1) n = 1;
    const rnd = ctx.random ?? Math.random;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * 256);
    return out;
  }, false),
  scalar("printf", 1, -1, TEXT, (a) => (a[0] === null ? "" : sqlPrintf(toText(a[0]!), a.slice(1)))),
  scalar("format", 1, -1, TEXT, (a) => (a[0] === null ? "" : sqlPrintf(toText(a[0]!), a.slice(1)))),
  scalar("char", 0, -1, TEXT, (a) => {
    let s = "";
    for (const v of a) {
      if (v === null) { s += "\0"; continue; }
      const cp = Number(toInt64(v));
      s += cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�";
    }
    return s;
  }),
  scalar("unicode", 1, 1, nullable(INTEGER), (a) => {
    if (a[0] === null) return null;
    const s = toText(a[0]!);
    if (s.length === 0) return null;
    return BigInt(s.codePointAt(0)!);
  }),
  scalar("quote", 1, 1, TEXT, (a) => {
    const v = a[0]!;
    if (v === null) return "NULL";
    switch (typeof v) {
      case "bigint": return v.toString();
      case "boolean": return v ? "1" : "0";
      case "number": return Number.isFinite(v) ? formatReal(v) : v > 0 ? "9.0e+999" : v < 0 ? "-9.0e+999" : "NULL";
      case "string": return `'${v.replace(/'/g, "''")}'`;
      default: return `X'${hexOf(v)}'`;
    }
  }),
  scalar("zeroblob", 1, 1, BLOB, (a) => {
    const n = a[0] === null ? 0 : Number(toInt64(a[0]!));
    return new Uint8Array(Math.max(0, n));
  }),
  scalar("nullif", 2, 2, FIRST_ARG, (a) => {
    const x = a[0]!, y = a[1]!;
    if (x === null) return null;
    if (y === null) return x;
    return compareValues(normalize(x), normalize(y)) === 0 ? null : x;
  }),
  scalar("coalesce", 2, -1, (t) => { const nn = t.filter((x) => x !== "NULL"); return nn.length === 0 ? "NULL" : nn.every((x) => x === nn[0]) ? nn[0]! : "ANY"; }, (a) => {
    for (const v of a) if (v !== null) return v;
    return null;
  }),
  scalar("ifnull", 2, 2, (t) => (t[0] === t[1] ? t[0]! : "ANY"), (a) => (a[0] !== null ? a[0]! : a[1]!)),
  scalar("iif", 2, -1, (t) => { const r = t.filter((_, i) => i % 2 === 1); return r.every((x) => x === r[0]) ? (r[0] ?? "NULL") : "ANY"; }, (a) => {
    // iif(c1, v1, c2, v2, ..., [else])
    let i = 0;
    for (; i + 1 < a.length; i += 2) if (truthy(a[i]!) === true) return a[i + 1]!;
    return i < a.length ? a[i]! : null;
  }),
  scalar("concat", 1, -1, TEXT, (a) => { let s = ""; for (const v of a) if (v !== null) s += toText(v); return s; }),
  scalar("concat_ws", 2, -1, nullable(TEXT), (a) => {
    if (a[0] === null) return null;
    const sep = toText(a[0]!);
    const parts: string[] = [];
    for (let i = 1; i < a.length; i++) if (a[i] !== null) parts.push(toText(a[i]!));
    return parts.join(sep);
  }),
  scalar("likelihood", 2, 2, FIRST_ARG, (a) => a[0]!),
  scalar("likely", 1, 1, FIRST_ARG, (a) => a[0]!),
  scalar("unlikely", 1, 1, FIRST_ARG, (a) => a[0]!),
  scalar("like", 2, 3, nullable(INTEGER), (a) => sqlLike(a[0]!, a[1]!, a.length > 2 ? a[2]! : undefined)),
  scalar("glob", 2, 2, nullable(INTEGER), (a) => sqlGlob(a[0]!, a[1]!)),
  scalar("current_timestamp", 0, 0, TEXT, (_a, ctx) => {
    const d = nowDate(ctx);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  }, false),
  scalar("current_date", 0, 0, TEXT, (_a, ctx) => { const d = nowDate(ctx); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }, false),
  scalar("current_time", 0, 0, TEXT, (_a, ctx) => { const d = nowDate(ctx); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`; }, false),
];

// ───────────────────────────────── aggregates ─────────────────────────────────

interface SumState { count: number; isInt: boolean; i: bigint; r: number; overflow: boolean }

function stepSum(s: SumState, v: Value): void {
  if (v === null) return;
  s.count++;
  const n = toNumeric(v);
  if (typeof n === "bigint" && s.isInt && !s.overflow) {
    s.i += n;
    if (s.i > INT64_MAX || s.i < INT64_MIN) { s.overflow = true; }
    return;
  }
  if (s.isInt) { s.isInt = false; s.r = Number(s.i); }
  s.r += Number(n);
}

function aggregate<S>(name: string, minArgs: number, maxArgs: number, returnType: (t: readonly ExprType[]) => ExprType, init: () => S, step: (s: S, a: readonly Value[]) => void, final: (s: S) => Value): AggregateFunction<S> {
  return { name, minArgs, maxArgs, returnType, init, step, final };
}

const AGGREGATES: AggregateFunction<unknown>[] = [
  aggregate("count", 0, 1, INTEGER, () => ({ n: 0n }), (s, a) => { if (a.length === 0 || a[0] !== null) s.n++; }, (s) => s.n),
  aggregate("sum", 1, 1, (t) => (t[0] === "INTEGER" ? "INTEGER" : t[0] === "REAL" ? "REAL" : "ANY"),
    (): SumState => ({ count: 0, isInt: true, i: 0n, r: 0, overflow: false }),
    (s, a) => stepSum(s, a[0]!),
    (s) => (s.count === 0 ? null : s.isInt && !s.overflow ? s.i : s.isInt ? Number(s.i) : s.r)),
  aggregate("total", 1, 1, REAL,
    (): SumState => ({ count: 0, isInt: true, i: 0n, r: 0, overflow: false }),
    (s, a) => stepSum(s, a[0]!),
    (s) => (s.isInt ? Number(s.i) : s.r)),
  aggregate("avg", 1, 1, nullable(REAL),
    (): SumState => ({ count: 0, isInt: true, i: 0n, r: 0, overflow: false }),
    (s, a) => stepSum(s, a[0]!),
    (s) => (s.count === 0 ? null : (s.isInt ? Number(s.i) : s.r) / s.count)),
  aggregate("min", 1, 1, FIRST_ARG, (): { v: Value } => ({ v: null }), (s, a) => {
    const v = a[0]!;
    if (v === null) return;
    if (s.v === null || compareValues(normalize(v), normalize(s.v)) < 0) s.v = v;
  }, (s) => s.v),
  aggregate("max", 1, 1, FIRST_ARG, (): { v: Value } => ({ v: null }), (s, a) => {
    const v = a[0]!;
    if (v === null) return;
    if (s.v === null || compareValues(normalize(v), normalize(s.v)) > 0) s.v = v;
  }, (s) => s.v),
  aggregate("group_concat", 1, 2, nullable(TEXT), (): { s: string | null } => ({ s: null }), (st, a) => {
    const v = a[0]!;
    if (v === null) return;
    const sep = a.length > 1 ? (a[1] === null ? "" : toText(a[1]!)) : ",";
    st.s = st.s === null ? toText(v) : st.s + sep + toText(v);
  }, (st) => st.s),
  aggregate("string_agg", 2, 2, nullable(TEXT), (): { s: string | null } => ({ s: null }), (st, a) => {
    const v = a[0]!;
    if (v === null) return;
    const sep = a[1] === null ? "" : toText(a[1]!);
    st.s = st.s === null ? toText(v) : st.s + sep + toText(v);
  }, (st) => st.s),
] as AggregateFunction<unknown>[];

// ───────────────────────────────── window functions ─────────────────────────────────

function frameRows(w: WindowFrameContext): number[] {
  const out: number[] = [];
  for (let i = w.frameStart; i <= w.frameEnd; i++) if (!w.isExcluded || !w.isExcluded(i)) out.push(i);
  return out;
}

function windowFn(name: string, minArgs: number, maxArgs: number, returnType: (t: readonly ExprType[]) => ExprType, compute: (w: WindowFrameContext) => Value): WindowFunction {
  return { name, minArgs, maxArgs, returnType, compute };
}

const WINDOWS: WindowFunction[] = [
  windowFn("row_number", 0, 0, INTEGER, (w) => BigInt(w.index + 1)),
  windowFn("rank", 0, 0, INTEGER, (w) => BigInt(w.peerStart + 1)),
  windowFn("dense_rank", 0, 0, INTEGER, (w) => BigInt(w.peerGroup + 1)),
  windowFn("percent_rank", 0, 0, REAL, (w) => (w.size <= 1 ? 0 : w.peerStart / (w.size - 1))),
  windowFn("cume_dist", 0, 0, REAL, (w) => (w.peerEnd + 1) / w.size),
  windowFn("ntile", 1, 1, INTEGER, (w) => {
    const arg = w.args[w.index]![0]!;
    if (arg === null) return null;
    const n = Number(toInt64(arg));
    if (n <= 0) throw new BasaltError("argument of ntile must be a positive integer", "ERROR");
    const size = w.size, i = w.index;
    const small = Math.floor(size / n);
    if (small === 0) return BigInt(i + 1);
    const large = size - small * n; // number of buckets holding small+1 rows
    const largeRows = large * (small + 1);
    if (i < largeRows) return BigInt(Math.floor(i / (small + 1)) + 1);
    return BigInt(large + Math.floor((i - largeRows) / small) + 1);
  }),
  windowFn("lag", 1, 3, FIRST_ARG, (w) => {
    const a = w.args[w.index]!;
    const off = a.length > 1 ? (a[1] === null ? null : Number(toInt64(a[1]!))) : 1;
    if (off === null) return null;
    const j = w.index - off;
    if (j < 0 || j >= w.size) return a.length > 2 ? a[2]! : null;
    return w.args[j]![0]!;
  }),
  windowFn("lead", 1, 3, FIRST_ARG, (w) => {
    const a = w.args[w.index]!;
    const off = a.length > 1 ? (a[1] === null ? null : Number(toInt64(a[1]!))) : 1;
    if (off === null) return null;
    const j = w.index + off;
    if (j < 0 || j >= w.size) return a.length > 2 ? a[2]! : null;
    return w.args[j]![0]!;
  }),
  windowFn("first_value", 1, 1, FIRST_ARG, (w) => { const rows = frameRows(w); return rows.length === 0 ? null : w.args[rows[0]!]![0]!; }),
  windowFn("last_value", 1, 1, FIRST_ARG, (w) => { const rows = frameRows(w); return rows.length === 0 ? null : w.args[rows[rows.length - 1]!]![0]!; }),
  windowFn("nth_value", 2, 2, FIRST_ARG, (w) => {
    const nArg = w.args[w.index]![1]!;
    if (nArg === null) return null;
    const n = toNumeric(nArg);
    if (typeof n !== "bigint" || n <= 0n) throw new BasaltError("second argument to nth_value must be a positive integer", "ERROR");
    const rows = frameRows(w);
    const k = Number(n) - 1;
    return k < rows.length ? w.args[rows[k]!]![0]! : null;
  }),
];

// ───────────────────────────────── registry ─────────────────────────────────

/** Registry of builtin functions; also serves as the binder's `FunctionProvider`. */
export class FunctionRegistry implements FunctionProvider {
  private readonly scalars = new Map<string, ScalarFunction>();
  private readonly aggregates = new Map<string, AggregateFunction<unknown>>();
  private readonly windows = new Map<string, WindowFunction>();

  registerScalar(fn: ScalarFunction): this { this.scalars.set(fn.name.toLowerCase(), fn); return this; }
  registerAggregate(fn: AggregateFunction<unknown>): this { this.aggregates.set(fn.name.toLowerCase(), fn); return this; }
  registerWindow(fn: WindowFunction): this { this.windows.set(fn.name.toLowerCase(), fn); return this; }

  getScalar(name: string): ScalarFunction | undefined { return this.scalars.get(name.toLowerCase()); }
  getAggregate(name: string): AggregateFunction<unknown> | undefined { return this.aggregates.get(name.toLowerCase()); }
  getWindow(name: string): WindowFunction | undefined { return this.windows.get(name.toLowerCase()); }

  lookup(name: string): FunctionInfo | undefined {
    const key = name.toLowerCase();
    const s = this.scalars.get(key), a = this.aggregates.get(key), w = this.windows.get(key);
    if (!s && !a && !w) return undefined;
    return {
      name: key,
      scalar: s ? { minArgs: s.minArgs, maxArgs: s.maxArgs } : undefined,
      aggregate: a ? { minArgs: a.minArgs, maxArgs: a.maxArgs } : undefined,
      window: w ? { minArgs: w.minArgs, maxArgs: w.maxArgs } : undefined,
      deterministic: s ? s.deterministic : true,
      returnType: (argTypes, kind) => {
        if (kind === "scalar" && s) return s.returnType(argTypes);
        if (kind === "aggregate" && a) return a.returnType(argTypes);
        if (kind === "window" && w) return w.returnType(argTypes);
        return "ANY";
      },
    };
  }
}

/** The default registry with every builtin. */
export const builtinFunctions: FunctionRegistry = new FunctionRegistry();
for (const f of SCALARS) builtinFunctions.registerScalar(f);
for (const f of AGGREGATES) builtinFunctions.registerAggregate(f);
for (const f of WINDOWS) builtinFunctions.registerWindow(f);
