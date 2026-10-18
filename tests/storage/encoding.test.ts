import { describe, expect, it } from "vitest";
import {
  compareBytes, crc32, decodeKey, decodeRecord, encodeKey, encodeRecord, readVarint, varintSize, writeVarint,
} from "../../src/core/encoding";
import { compareValues, type Value } from "../../src/core/types";
import { randBytes, randInt, rng } from "./helpers";

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

function randomText(rand: () => number): string {
  const len = randInt(rand, 0, 12);
  let s = "";
  for (let i = 0; i < len; i++) {
    const r = rand();
    if (r < 0.15) s += "\0";
    else if (r < 0.5) s += String.fromCharCode(randInt(rand, 0x20, 0x7f));
    else if (r < 0.75) s += String.fromCharCode(randInt(rand, 0x80, 0xd800));
    else if (r < 0.9) s += String.fromCodePoint(randInt(rand, 0x10000, 0x10ffff)); // astral (surrogate pair)
    else s += String.fromCharCode(randInt(rand, 0xe000, 0x10000));
  }
  return s;
}

function randomValue(rand: () => number): Value {
  const r = rand();
  if (r < 0.08) return null;
  if (r < 0.16) return rand() < 0.5;
  if (r < 0.4) {
    const k = rand();
    if (k < 0.4) return BigInt(randInt(rand, -1000, 1000));
    if (k < 0.7) return BigInt(randInt(rand, -(2 ** 52), 2 ** 52));
    // full 64-bit range
    const hi = BigInt(randInt(rand, -(2 ** 31), 2 ** 31)), lo = BigInt(randInt(rand, 0, 2 ** 32));
    return (hi << 32n) | lo;
  }
  if (r < 0.65) {
    const k = rand();
    if (k < 0.1) return -0;
    if (k < 0.15) return Number.NaN;
    if (k < 0.2) return rand() < 0.5 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    if (k < 0.4) return randInt(rand, -1000, 1000) + (rand() < 0.5 ? 0 : rand());
    if (k < 0.6) return (rand() - 0.5) * 1e20; // beyond int64
    if (k < 0.8) return (rand() - 0.5) * 2e5;
    return (rand() - 0.5) * 1e-300;
  }
  if (r < 0.85) return randomText(rand);
  return randBytes(rand, randInt(rand, 0, 8)).map((b) => (rand() < 0.2 ? 0 : b));
}

describe("varint", () => {
  it("round-trips", () => {
    const buf = new Uint8Array(16);
    for (const v of [0, 1, 127, 128, 255, 300, 16383, 16384, 2 ** 31, 2 ** 32, 2 ** 53 - 1]) {
      const end = writeVarint(buf, 0, v);
      expect(end).toBe(varintSize(v));
      expect(readVarint(buf, 0)).toBe(v);
    }
  });
});

describe("crc32", () => {
  it("matches the reference vector", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("key encoding", () => {
  it("preserves compareValues order over 10k random pairs", () => {
    const rand = rng(42);
    let checked = 0, skipped = 0;
    for (let i = 0; i < 10_000; i++) {
      const a = randomValue(rand), b = randomValue(rand);
      const expected = sign(compareValues(a, b));
      const actual = compareBytes(encodeKey([a]), encodeKey([b]));
      if (expected === 0 && actual !== 0 && typeof a !== typeof b && (typeof a === "bigint" || typeof b === "bigint")) {
        // compareValues rounds bigints beyond 2^53 through Number(); the key encoding compares exactly.
        skipped++;
        continue;
      }
      if (actual !== expected) throw new Error(`order mismatch for ${String(a)} (${typeof a}) vs ${String(b)} (${typeof b}): expected ${expected}, got ${actual}`);
      checked++;
    }
    expect(checked).toBeGreaterThan(9900);
    expect(skipped).toBeLessThan(50);
  });

  it("handles the numeric corner cases", () => {
    const cmp = (a: Value, b: Value) => compareBytes(encodeKey([a]), encodeKey([b]));
    expect(cmp(5n, 5.0)).toBe(0);
    expect(cmp(-0, 0n)).toBe(0);
    expect(cmp(-0, 0)).toBe(0);
    expect(cmp(5n, 5.5)).toBe(-1);
    expect(cmp(6n, 5.5)).toBe(1);
    expect(cmp(-3n, -2.5)).toBe(-1);
    expect(cmp(-2n, -2.5)).toBe(1);
    expect(cmp(2n ** 63n - 1n, 9.3e18)).toBe(-1);
    expect(cmp(-(2n ** 63n), -1e19)).toBe(1);
    expect(cmp(1e300, Number.POSITIVE_INFINITY)).toBe(-1);
    expect(cmp(Number.NEGATIVE_INFINITY, -1e300)).toBe(-1);
    expect(cmp(Number.NaN, Number.NEGATIVE_INFINITY)).toBe(-1); // NaN sorts first, like compareValues
    expect(cmp(true, 0n)).toBe(-1);
    expect(cmp(null, false)).toBe(-1);
    expect(cmp(1e308, "a")).toBe(-1);
    expect(cmp("zzz", new Uint8Array(0))).toBe(-1);
  });

  it("orders text with embedded NULs and blobs by prefix", () => {
    const cmp = (a: Value, b: Value) => compareBytes(encodeKey([a]), encodeKey([b]));
    expect(cmp("a\0b", "a")).toBe(1);
    expect(cmp("a\0", "a\x01")).toBe(-1);
    expect(cmp("", "\0")).toBe(-1);
    expect(cmp(new Uint8Array([0, 0]), new Uint8Array([0]))).toBe(1);
    expect(cmp(new Uint8Array([0]), new Uint8Array([0, 0xff]))).toBe(-1);
    expect(cmp(new Uint8Array(0), new Uint8Array([0]))).toBe(-1);
  });

  it("orders composite keys column by column", () => {
    expect(compareBytes(encodeKey([1n, "b"]), encodeKey([1n, "c"]))).toBe(-1);
    expect(compareBytes(encodeKey([1n, "zzz"]), encodeKey([2n, "a"]))).toBe(-1);
    expect(compareBytes(encodeKey(["a\0", 1n]), encodeKey(["a", 1n]))).toBe(1);
    expect(compareBytes(encodeKey([1.5, 9n]), encodeKey([2n, 0n]))).toBe(-1);
  });

  it("round-trips values (integral REALs come back as INTEGER)", () => {
    const rand = rng(7);
    for (let i = 0; i < 2000; i++) {
      const vals = [randomValue(rand), randomValue(rand), randomValue(rand)];
      const decoded = decodeKey(encodeKey(vals));
      expect(decoded.length).toBe(3);
      for (let j = 0; j < 3; j++) {
        const v = vals[j]!, d = decoded[j]!;
        if (typeof v === "number" && Number.isNaN(v)) { expect(Number.isNaN(d)).toBe(true); continue; }
        expect(compareValues(v, d)).toBe(0);
        if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 2 ** 63) expect(typeof d).toBe("bigint");
        else if (typeof v === "string") expect(d).toBe(v);
        else if (v instanceof Uint8Array) expect(Array.from(d as Uint8Array)).toEqual(Array.from(v));
        else expect(d).toBe(v);
      }
    }
    expect(decodeKey(encodeKey(["héllo\0wörld 😀"]))).toEqual(["héllo\0wörld 😀"]);
    expect(decodeKey(encodeKey([-0]))).toEqual([0n]);
    expect(decodeKey(encodeKey([2n ** 63n - 1n, -(2n ** 63n)]))).toEqual([2n ** 63n - 1n, -(2n ** 63n)]);
  });
});

describe("record format", () => {
  it("round-trips rows with exact types", () => {
    const rand = rng(99);
    for (let i = 0; i < 2000; i++) {
      const n = randInt(rand, 0, 8);
      const row: Value[] = [];
      for (let j = 0; j < n; j++) row.push(randomValue(rand));
      const decoded = decodeRecord(encodeRecord(row));
      expect(decoded.length).toBe(n);
      for (let j = 0; j < n; j++) {
        const v = row[j]!, d = decoded[j]!;
        expect(typeof d).toBe(typeof v);
        if (typeof v === "number") {
          if (Number.isNaN(v)) expect(Number.isNaN(d)).toBe(true);
          else expect(Object.is(d, v)).toBe(true); // keeps -0
        } else if (v instanceof Uint8Array) expect(Array.from(d as Uint8Array)).toEqual(Array.from(v));
        else expect(d).toBe(v);
      }
    }
  });

  it("uses minimal integer widths", () => {
    expect(encodeRecord([0n]).length).toBe(1 + 1 + 1);
    expect(encodeRecord([127n]).length).toBe(3);
    expect(encodeRecord([128n]).length).toBe(1 + 1 + 2);
    expect(encodeRecord([-32768n]).length).toBe(4);
    expect(encodeRecord([2n ** 31n]).length).toBe(1 + 1 + 8);
    expect(encodeRecord([null, true, false]).length).toBe(4);
    expect(encodeRecord([]).length).toBe(1);
    expect(decodeRecord(encodeRecord([-(2n ** 63n), 2n ** 63n - 1n]))).toEqual([-(2n ** 63n), 2n ** 63n - 1n]);
  });
});
