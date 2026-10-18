/**
 * Byte-level encodings shared by storage and the upper layers:
 *
 * - unsigned LEB128 varints
 * - CRC32 (table based, IEEE polynomial)
 * - an **order-preserving key encoding** of `Value[]` (memcmp order == `compareValues` order)
 * - a compact **record format** for rows (exact type round trip, SQLite-serial-type-like integers)
 *
 * This module imports only `./types` and allocates as little as possible on the hot paths.
 */
import { type Value } from "./types";

// ---------------------------------------------------------------------------------------------
// Varints
// ---------------------------------------------------------------------------------------------

/** Number of bytes `writeVarint` uses for `value` (value must be a non-negative safe integer). */
export function varintSize(value: number): number {
  let n = 1;
  while (value >= 0x80) { value = Math.floor(value / 128); n++; }
  return n;
}

/** Writes an unsigned LEB128 varint at `offset`; returns the offset just past it. */
export function writeVarint(buf: Uint8Array, offset: number, value: number): number {
  while (value >= 0x80) {
    buf[offset++] = (value % 128) | 0x80;
    value = Math.floor(value / 128);
  }
  buf[offset++] = value;
  return offset;
}

/**
 * Reads an unsigned LEB128 varint at `offset`. The number of bytes consumed equals
 * `varintSize(result)` because the encoding is canonical.
 */
export function readVarint(buf: Uint8Array, offset: number): number {
  let result = 0, mul = 1, b: number;
  do {
    b = buf[offset++]!;
    result += (b & 0x7f) * mul;
    mul *= 128;
  } while (b & 0x80);
  return result;
}

// ---------------------------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** CRC32 (IEEE 802.3) of `buf[start, end)`, returned as an unsigned 32-bit integer. */
export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------------------------

/** Lexicographic unsigned byte comparison; a shorter prefix sorts first. Returns -1, 0 or 1. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** Compares `a[aOff, aOff+aLen)` with `b` (whole array) without allocating. */
export function compareBytesAt(a: Uint8Array, aOff: number, aLen: number, b: Uint8Array): number {
  const n = Math.min(aLen, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[aOff + i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return aLen < b.length ? -1 : aLen > b.length ? 1 : 0;
}

/** Growable byte buffer used by the encoders. Reusable: call `reset()` between uses. */
export class ByteWriter {
  buf: Uint8Array;
  view: DataView;
  pos = 0;
  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }
  reset(): void { this.pos = 0; }
  ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v: number): void { this.ensure(1); this.buf[this.pos++] = v; }
  u16(v: number): void { this.ensure(2); this.view.setUint16(this.pos, v); this.pos += 2; }
  u32(v: number): void { this.ensure(4); this.view.setUint32(this.pos, v); this.pos += 4; }
  u64(v: bigint): void { this.ensure(8); this.view.setBigUint64(this.pos, v); this.pos += 8; }
  f64(v: number): void { this.ensure(8); this.view.setFloat64(this.pos, v); this.pos += 8; }
  varint(v: number): void { this.ensure(10); this.pos = writeVarint(this.buf, this.pos, v); }
  bytes(b: Uint8Array): void { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  /** Returns a copy of the bytes written so far. */
  toBytes(): Uint8Array { return this.buf.slice(0, this.pos); }
}

// ---------------------------------------------------------------------------------------------
// Order-preserving key encoding
// ---------------------------------------------------------------------------------------------
//
// Layout per value: a tag byte, then a tag-specific payload. Tags are chosen so that byte order
// follows `typeRank` (NULL < BOOLEAN < numbers < TEXT < BLOB).
//
// Numbers share one ordering domain because `compareValues` compares INTEGER and REAL
// numerically. They use a *family* of tags (0x03..0x08) ordered numerically:
//   NaN  <  -Infinity  <  reals < -2^63  <  [in-range numbers]  <  reals >= 2^63  <  +Infinity
// In-range numbers are `tag 0x06 + floor(x) as sign-flipped big-endian int64 + flag byte`
// where flag = 0x00 for integral values and 0x01 followed by the 8 order-transformed IEEE bytes of
// x otherwise (within one floor bucket those bytes follow numeric order, and the bucket's integer
// sorts first). Consequence: numerically equal values encode identically (so 5 and 5.0 are the same
// key, as `compareValues` requires), and decoding an integral REAL yields a bigint.

export const TAG_NULL = 0x01;
export const TAG_BOOL = 0x02;
export const TAG_NUM_NAN = 0x03;
export const TAG_NUM_NEG_INF = 0x04;
export const TAG_NUM_NEG_BIG = 0x05;
export const TAG_NUM = 0x06;
export const TAG_NUM_POS_BIG = 0x07;
export const TAG_NUM_POS_INF = 0x08;
export const TAG_TEXT = 0x09;
export const TAG_BLOB = 0x0a;

const SIGN_BIT = 1n << 63n;
const TWO_63 = 9223372036854775808; // 2^63 as a double (exact)
const scratch8 = new Uint8Array(8);
const scratchView = new DataView(scratch8.buffer);
const keyWriter = new ByteWriter(128);

/** Writes a double so that unsigned byte order equals numeric order (all finite doubles). */
function writeOrderedDouble(w: ByteWriter, x: number): void {
  scratchView.setFloat64(0, x);
  let bits = scratchView.getBigUint64(0);
  bits = bits & SIGN_BIT ? ~bits & 0xffffffffffffffffn : bits | SIGN_BIT;
  w.u64(bits);
}

function readOrderedDouble(buf: Uint8Array, off: number): number {
  for (let i = 0; i < 8; i++) scratch8[i] = buf[off + i]!;
  let bits = scratchView.getBigUint64(0);
  bits = bits & SIGN_BIT ? bits ^ SIGN_BIT : ~bits & 0xffffffffffffffffn;
  scratchView.setBigUint64(0, bits);
  return scratchView.getFloat64(0);
}

function writeNumber(w: ByteWriter, v: number | bigint): void {
  if (typeof v === "bigint") {
    w.u8(TAG_NUM);
    w.u64(BigInt.asUintN(64, v) ^ SIGN_BIT);
    w.u8(0);
    return;
  }
  if (Number.isNaN(v)) { w.u8(TAG_NUM_NAN); return; }
  if (v === Number.NEGATIVE_INFINITY) { w.u8(TAG_NUM_NEG_INF); return; }
  if (v === Number.POSITIVE_INFINITY) { w.u8(TAG_NUM_POS_INF); return; }
  if (v < -TWO_63) { w.u8(TAG_NUM_NEG_BIG); writeOrderedDouble(w, v); return; }
  if (v >= TWO_63) { w.u8(TAG_NUM_POS_BIG); writeOrderedDouble(w, v); return; }
  const fl = Math.floor(v); // exact; -0 floors to -0 -> BigInt 0
  w.u8(TAG_NUM);
  w.u64(BigInt.asUintN(64, BigInt(fl)) ^ SIGN_BIT);
  if (fl === v) {
    w.u8(0);
  } else {
    // Non-integral: within one floor bucket the ordered IEEE bits of v follow numeric order, and
    // every fractional value sorts after the bucket's integer (flag 0 < flag 1). Exact round trip.
    w.u8(1);
    writeOrderedDouble(w, v);
  }
}

/** Writes `bytes` with `0x00` escaped as `0x00 0xFF`, then the `0x00 0x00` terminator. */
function writeEscaped(w: ByteWriter, bytes: Uint8Array): void {
  w.ensure(bytes.length * 2 + 2);
  const out = w.buf;
  let p = w.pos;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out[p++] = b;
    if (b === 0) out[p++] = 0xff;
  }
  out[p++] = 0; out[p++] = 0;
  w.pos = p;
}

/**
 * Writes a string as CESU-8 (each UTF-16 code unit encoded independently with the UTF-8 byte
 * patterns) with the same 0x00 escaping/termination as blobs. Byte order then equals the UTF-16
 * code-unit order that JavaScript `<` (and therefore `compareValues`) uses for strings.
 */
function writeEscapedText(w: ByteWriter, s: string): void {
  w.ensure(s.length * 3 + 2);
  const out = w.buf;
  let p = w.pos;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out[p++] = c;
      if (c === 0) out[p++] = 0xff;
    } else if (c < 0x800) {
      out[p++] = 0xc0 | (c >> 6);
      out[p++] = 0x80 | (c & 0x3f);
    } else {
      out[p++] = 0xe0 | (c >> 12);
      out[p++] = 0x80 | ((c >> 6) & 0x3f);
      out[p++] = 0x80 | (c & 0x3f);
    }
  }
  out[p++] = 0; out[p++] = 0;
  w.pos = p;
}

/** Appends the order-preserving encoding of one value to `w`. */
export function writeKeyValue(w: ByteWriter, v: Value): void {
  if (v === null) { w.u8(TAG_NULL); return; }
  switch (typeof v) {
    case "boolean": w.u8(TAG_BOOL); w.u8(v ? 1 : 0); return;
    case "bigint":
    case "number": writeNumber(w, v); return;
    case "string": w.u8(TAG_TEXT); writeEscapedText(w, v); return;
    default: w.u8(TAG_BLOB); writeEscaped(w, v); return;
  }
}

/** Order-preserving encoding of a composite key: concatenation of the per-value encodings. */
export function encodeKey(values: readonly Value[]): Uint8Array {
  const w = keyWriter;
  w.reset();
  for (let i = 0; i < values.length; i++) writeKeyValue(w, values[i]!);
  return w.toBytes();
}

/** Encodes a single value (same bytes as `encodeKey([v])`). */
export function encodeKeyValue(v: Value): Uint8Array {
  const w = keyWriter;
  w.reset();
  writeKeyValue(w, v);
  return w.toBytes();
}

/** Finds the end (exclusive, past the 0x00 0x00 terminator) of an escaped byte string. */
function findTerminator(buf: Uint8Array, off: number): number {
  while (off < buf.length) {
    if (buf[off] === 0) {
      if (buf[off + 1] === 0) return off + 2;
      off += 2;
    } else off++;
  }
  throw new RangeError("unterminated key string");
}

function unescapeBytes(buf: Uint8Array, off: number, end: number): Uint8Array {
  // end points just past the terminator
  const out = new Uint8Array(end - 2 - off);
  let n = 0;
  for (let i = off; i < end - 2; i++) {
    const b = buf[i]!;
    out[n++] = b;
    if (b === 0) i++; // skip the 0xFF escape byte
  }
  return out.subarray(0, n);
}

function decodeText(bytes: Uint8Array): string {
  const codes: number[] = [];
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    if (b < 0x80) { codes.push(b); i++; }
    else if (b < 0xe0) { codes.push(((b & 0x1f) << 6) | (bytes[i + 1]! & 0x3f)); i += 2; }
    else { codes.push(((b & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f)); i += 3; }
  }
  let s = "";
  for (let i = 0; i < codes.length; i += 8192) s += String.fromCharCode.apply(null, codes.slice(i, i + 8192));
  return s;
}

/** Cursor over an encoded key; `next()` decodes one value and advances. */
export class KeyReader {
  pos = 0;
  constructor(public readonly buf: Uint8Array, pos = 0) { this.pos = pos; }
  get done(): boolean { return this.pos >= this.buf.length; }
  next(): Value {
    const buf = this.buf;
    const tag = buf[this.pos++];
    switch (tag) {
      case TAG_NULL: return null;
      case TAG_BOOL: return buf[this.pos++] !== 0;
      case TAG_NUM_NAN: return Number.NaN;
      case TAG_NUM_NEG_INF: return Number.NEGATIVE_INFINITY;
      case TAG_NUM_POS_INF: return Number.POSITIVE_INFINITY;
      case TAG_NUM_NEG_BIG:
      case TAG_NUM_POS_BIG: { const v = readOrderedDouble(buf, this.pos); this.pos += 8; return v; }
      case TAG_NUM: {
        for (let i = 0; i < 8; i++) scratch8[i] = buf[this.pos + i]!;
        this.pos += 8;
        const int = BigInt.asIntN(64, scratchView.getBigUint64(0) ^ SIGN_BIT);
        const flag = buf[this.pos++];
        if (flag === 0) return int;
        const v = readOrderedDouble(buf, this.pos);
        this.pos += 8;
        return v;
      }
      case TAG_TEXT: {
        const end = findTerminator(buf, this.pos);
        const raw = unescapeBytes(buf, this.pos, end);
        this.pos = end;
        return decodeText(raw);
      }
      case TAG_BLOB: {
        const end = findTerminator(buf, this.pos);
        const raw = unescapeBytes(buf, this.pos, end);
        this.pos = end;
        return raw.slice();
      }
      default: throw new RangeError(`invalid key tag 0x${(tag ?? 0).toString(16)} at ${this.pos - 1}`);
    }
  }
}

/**
 * Decodes a composite key. Note: numerically equal INTEGER/REAL values share one encoding, so an
 * integral REAL (e.g. 5.0) decodes as the INTEGER 5n; use the record format for exact types.
 */
export function decodeKey(bytes: Uint8Array): Value[] {
  const r = new KeyReader(bytes);
  const out: Value[] = [];
  while (!r.done) out.push(r.next());
  return out;
}

// ---------------------------------------------------------------------------------------------
// Record format
// ---------------------------------------------------------------------------------------------
//
//   varint columnCount
//   per column: u8 typeCode [varint byteLength for TEXT/BLOB]
//   payloads in column order
//
// Type codes: 0 NULL, 1 FALSE, 2 TRUE, 3 INT8, 4 INT16, 5 INT32, 6 INT64, 7 REAL, 8 TEXT, 9 BLOB.
// INTEGER uses the smallest width that holds the value (sign-extended on read).

export const REC_NULL = 0, REC_FALSE = 1, REC_TRUE = 2, REC_INT8 = 3, REC_INT16 = 4, REC_INT32 = 5,
  REC_INT64 = 6, REC_REAL = 7, REC_TEXT = 8, REC_BLOB = 9;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const recWriter = new ByteWriter(256);

function intCode(v: bigint): number {
  if (v >= -128n && v <= 127n) return REC_INT8;
  if (v >= -32768n && v <= 32767n) return REC_INT16;
  if (v >= -2147483648n && v <= 2147483647n) return REC_INT32;
  return REC_INT64;
}

/** Encodes a row into the compact record format. Types round-trip exactly. */
export function encodeRecord(row: readonly Value[]): Uint8Array {
  const w = recWriter;
  w.reset();
  const n = row.length;
  // Encode strings first so lengths are known for the header.
  let encodedText: (Uint8Array | undefined)[] | undefined;
  for (let i = 0; i < n; i++) {
    const v = row[i];
    if (typeof v === "string") {
      encodedText ??= new Array<Uint8Array | undefined>(n);
      encodedText[i] = textEncoder.encode(v);
    }
  }
  w.varint(n);
  for (let i = 0; i < n; i++) {
    const v = row[i]!;
    if (v === null) w.u8(REC_NULL);
    else switch (typeof v) {
      case "boolean": w.u8(v ? REC_TRUE : REC_FALSE); break;
      case "bigint": w.u8(intCode(v)); break;
      case "number": w.u8(REC_REAL); break;
      case "string": w.u8(REC_TEXT); w.varint(encodedText![i]!.length); break;
      default: w.u8(REC_BLOB); w.varint(v.length); break;
    }
  }
  for (let i = 0; i < n; i++) {
    const v = row[i]!;
    if (v === null || typeof v === "boolean") continue;
    switch (typeof v) {
      case "bigint": {
        const code = intCode(v);
        if (code === REC_INT8) w.u8(Number(v) & 0xff);
        else if (code === REC_INT16) w.u16(Number(v) & 0xffff);
        else if (code === REC_INT32) w.u32(Number(v) >>> 0);
        else w.u64(BigInt.asUintN(64, v));
        break;
      }
      case "number": w.f64(v); break;
      case "string": w.bytes(encodedText![i]!); break;
      default: w.bytes(v); break;
    }
  }
  return w.toBytes();
}

/** Decodes a record produced by `encodeRecord`. BLOB payloads are copied out of `bytes`. */
export function decodeRecord(bytes: Uint8Array): Value[] {
  let pos = 0;
  const n = readVarint(bytes, pos);
  pos += varintSize(n);
  const codes = new Uint8Array(n);
  const lengths = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const code = bytes[pos++]!;
    codes[i] = code;
    if (code === REC_TEXT || code === REC_BLOB) {
      const len = readVarint(bytes, pos);
      pos += varintSize(len);
      lengths[i] = len;
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<Value>(n);
  for (let i = 0; i < n; i++) {
    switch (codes[i]) {
      case REC_NULL: out[i] = null; break;
      case REC_FALSE: out[i] = false; break;
      case REC_TRUE: out[i] = true; break;
      case REC_INT8: out[i] = BigInt(view.getInt8(pos)); pos += 1; break;
      case REC_INT16: out[i] = BigInt(view.getInt16(pos)); pos += 2; break;
      case REC_INT32: out[i] = BigInt(view.getInt32(pos)); pos += 4; break;
      case REC_INT64: out[i] = view.getBigInt64(pos); pos += 8; break;
      case REC_REAL: out[i] = view.getFloat64(pos); pos += 8; break;
      case REC_TEXT: { const len = lengths[i]!; out[i] = textDecoder.decode(bytes.subarray(pos, pos + len)); pos += len; break; }
      case REC_BLOB: { const len = lengths[i]!; out[i] = bytes.slice(pos, pos + len); pos += len; break; }
      default: throw new RangeError(`invalid record type code ${codes[i]}`);
    }
  }
  return out;
}

/** Number of columns in a record without decoding it. */
export function recordColumnCount(bytes: Uint8Array): number {
  return readVarint(bytes, 0);
}
