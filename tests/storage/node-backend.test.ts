import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeKey } from "../../src/core/encoding";
import { NodeFileBackend } from "../../src/storage/node-backend";
import { PAGE_SIZE } from "../../src/storage/page";
import { createTree, openDb, readTree, withTree } from "./helpers";

const k = (n: number) => encodeKey([BigInt(n)]);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("NodeFileBackend", () => {
  it("creates, writes, closes and reopens a database file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "basalt-"));
    dirs.push(dir);
    const path = join(dir, "test.basalt");
    const db = openDb(NodeFileBackend.open(path), 64);
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 5000; i++) t.insert(k(i), k(i * 3)); });
    withTree(db, (t) => { for (let i = 0; i < 5000; i += 2) t.delete(k(i)); });
    const pages = db.pager.pageCount;
    await db.pager.close();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBe(pages * PAGE_SIZE);

    const db2 = openDb(NodeFileBackend.open(path), 64);
    const t = readTree(db2);
    expect(t.count()).toBe(2500);
    expect(t.get(k(2))).toBeNull();
    expect(Array.from(t.get(k(3))!)).toEqual(Array.from(k(9)));
    await db2.pager.close();
  });

  it("rejects a file without a valid meta page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "basalt-"));
    dirs.push(dir);
    const path = join(dir, "bad.basalt");
    const b = NodeFileBackend.open(path);
    b.extendSync(2); // two zero pages: right length, no magic/checksum
    await b.close();
    expect(() => openDb(NodeFileBackend.open(path))).toThrow(/no valid meta/);
  });
});
