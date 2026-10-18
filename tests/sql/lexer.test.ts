import { describe, expect, it } from "vitest";
import { tokenize } from "../../src/sql/lexer.js";
import { SyntaxError_ } from "../../src/core/errors.js";

const kinds = (sql: string) => tokenize(sql).map((t) => t.kind);
const texts = (sql: string) => tokenize(sql).filter((t) => t.kind !== "eof").map((t) => t.text);
const values = (sql: string) => tokenize(sql).filter((t) => t.kind !== "eof").map((t) => t.value);

describe("lexer", () => {
  it("always ends with eof", () => {
    expect(kinds("")).toEqual(["eof"]);
    expect(kinds("   \n\t ")).toEqual(["eof"]);
  });

  it("tokenizes keywords and identifiers case-insensitively", () => {
    const toks = tokenize("SeLeCt foo FROM Bar");
    expect(toks.map((t) => t.upper)).toEqual(["SELECT", "FOO", "FROM", "BAR", ""]);
    expect(toks[1]!.value).toBe("foo");
    expect(toks[0]!.quoted).toBe(false);
  });

  it("handles quoted identifiers of every style", () => {
    const toks = tokenize('"double quoted" [bracket id] `back tick` "with""escape"');
    expect(toks.slice(0, 4).map((t) => t.value)).toEqual(["double quoted", "bracket id", "back tick", 'with"escape']);
    expect(toks.every((t) => t.kind === "eof" || t.quoted)).toBe(true);
    expect(toks[0]!.upper).toBe(""); // quoted identifiers never match keywords
  });

  it("decodes string literals with doubled quotes", () => {
    expect(values("'it''s' '' 'a\nb'")).toEqual(["it's", "", "a\nb"]);
    expect(kinds("'x'")).toEqual(["string", "eof"]);
  });

  it("decodes blob literals", () => {
    const [b] = values("X'DEADbeef'");
    expect(b).toBeInstanceOf(Uint8Array);
    expect(Array.from(b as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(Array.from(values("x''")[0] as Uint8Array)).toEqual([]);
  });

  it("lexes integers as bigint and reals as number", () => {
    expect(values("1 42 9223372036854775807")).toEqual([1n, 42n, 9223372036854775807n]);
    expect(values("1.5 .5 1e10 1E-3 2.5e+2 1.")).toEqual([1.5, 0.5, 1e10, 1e-3, 250, 1]);
    expect(kinds("1.5 .5 1e10")).toEqual(["real", "real", "real", "eof"]);
    expect(values("0x1F 0XFF")).toEqual([31n, 255n]);
    // integers beyond int64 become reals like SQLite
    expect(kinds("9223372036854775808")).toEqual(["real", "eof"]);
    expect(values("0xFFFFFFFFFFFFFFFF")).toEqual([-1n]);
  });

  it("does not treat 1e as a real when the exponent lacks digits", () => {
    // `1e` is an error in SQLite too, but `1 e` lexes as number + identifier; we require a digit after e
    expect(() => tokenize("1e")).toThrow(SyntaxError_);
    expect(kinds("1 e")).toEqual(["integer", "ident", "eof"]);
  });

  it("rejects letters directly after a number", () => {
    expect(() => tokenize("12abc")).toThrow(/unexpected character/);
  });

  it("lexes parameters", () => {
    const toks = tokenize("? ?3 :name @name $name $a::b");
    expect(toks.map((t) => t.kind)).toEqual(["param", "param", "param", "param", "param", "param", "eof"]);
    expect(toks.map((t) => t.value)).toEqual([null, 3, ":name", "@name", "$name", "$a::b", null]);
  });

  it("lexes every operator", () => {
    const ops = "|| * / % + - << >> & | < <= > >= = == != <> ~ ( ) , ; .";
    expect(texts(ops)).toEqual(ops.split(" "));
    expect(kinds("a<=b")).toEqual(["ident", "punct", "ident", "eof"]);
    expect(texts("a<>b")).toEqual(["a", "<>", "b"]);
    expect(texts("a<<=b")).toEqual(["a", "<<=", "b"]);
  });

  it("skips line and block comments", () => {
    expect(texts("select -- comment\n 1")).toEqual(["select", "1"]);
    expect(texts("select /* multi\nline */ 1 /**/ 2")).toEqual(["select", "1", "2"]);
    expect(texts("select 1 -- no trailing newline")).toEqual(["select", "1"]);
  });

  it("tracks line and column numbers", () => {
    const toks = tokenize("select 1,\n  foo\n\n   bar");
    const pos = toks.map((t) => [t.line, t.col]);
    expect(pos).toEqual([[1, 1], [1, 8], [1, 9], [2, 3], [4, 4], [4, 7]]);
    expect(toks[3]!.offset).toBe(12);
    expect(toks[3]!.end).toBe(15);
  });

  it("tracks lines across block comments and multi-line strings", () => {
    const toks = tokenize("/* a\nb */ x 'q\nr' y");
    expect(toks.map((t) => [t.kind, t.line, t.col])).toEqual([["ident", 2, 6], ["string", 2, 8], ["ident", 3, 4], ["eof", 3, 5]]);
  });

  it("reports unterminated constructs with position", () => {
    expect(() => tokenize("select 'abc")).toThrow(/unterminated string literal at 1:8/);
    expect(() => tokenize('select "abc')).toThrow(/unterminated quoted identifier/);
    expect(() => tokenize("select /* abc")).toThrow(/unterminated block comment/);
    expect(() => tokenize("x'abc'")).toThrow(/even number of hex digits/);
    expect(() => tokenize("x'zz'")).toThrow(/malformed blob literal/);
    expect(() => tokenize("select 1 # 2")).toThrow(/unexpected character '#' at 1:10/);
    try { tokenize("select\n  'x"); } catch (e) {
      expect(e).toBeInstanceOf(SyntaxError_);
      expect((e as SyntaxError_).line).toBe(2);
      expect((e as SyntaxError_).col).toBe(3);
    }
  });

  it("allows $ and unicode in identifiers", () => {
    expect(values("café a$b _x1")).toEqual(["café", "a$b", "_x1"]);
  });
});
