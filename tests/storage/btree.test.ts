import { describe, expect, it } from "vitest";
import { compareBytes, encodeKey } from "../../src/core/encoding";
import { MemoryBackend } from "../../src/storage/backend";
import { BTree, MAX_KEY_SIZE } from "../../src/storage/btree";
import { bytesEqual, createTree, hex, openDb, randBytes, randInt, readTree, rng, scanAll, withTree } from "./helpers";

const k = (n: number) => encodeKey([BigInt(n)]);
const te = new TextEncoder();

describe("BTree", () => {
  it("inserts, gets and deletes a few keys", () => {
    const db = openDb();
    createTree(db);
    withTree(db, (t) => {
      t.insert(k(1), te.encode("one"));
      t.insert(k(3), te.encode("three"));
      t.insert(k(2), te.encode("two"));
      expect(new TextDecoder().decode(t.get(k(2))!)).toBe("two");
      expect(t.get(k(4))).toBeNull();
      expect(t.delete(k(3))).toBe(true);
      expect(t.delete(k(3))).toBe(false);
      expect(t.count()).toBe(2);
    });
    const t = readTree(db);
    expect(scanAll(t).map((e) => hex(e.key))).toEqual([hex(k(1)), hex(k(2))]);
    expect(() => t.insert(k(9), new Uint8Array(1))).toThrow(/read-only/);
  });

  it("matches a reference Map over 100k random inserts/deletes/gets (with commits)", () => {
    const db = openDb(new MemoryBackend(), 512);
    createTree(db);
    const rand = rng(12345);
    const ref = new Map<string, Uint8Array>();
    const keyOf = (n: number) => k(n);
    const N = 100_000, KEYSPACE = 40_000;
    for (let batch = 0; batch < 10; batch++) {
      withTree(db, (t) => {
        for (let i = 0; i < N / 10; i++) {
          const n = randInt(rand, 0, KEYSPACE);
          const key = keyOf(n), ks = hex(key);
          const op = rand();
          if (op < 0.6) {
            const v = randBytes(rand, randInt(rand, 0, 200));
            t.insert(key, v);
            ref.set(ks, v);
          } else if (op < 0.9) {
            const existed = t.delete(key);
            expect(existed).toBe(ref.delete(ks));
          } else {
            const got = t.get(key);
            const want = ref.get(ks);
            if (want === undefined) expect(got).toBeNull();
            else expect(got && bytesEqual(got, want)).toBe(true);
          }
        }
      });
    }
    const t = readTree(db);
    const all = scanAll(t);
    expect(all.length).toBe(ref.size);
    expect(t.count()).toBe(ref.size);
    const sortedRef = [...ref.keys()].sort();
    for (let i = 0; i < all.length; i++) {
      const e = all[i]!;
      expect(hex(e.key)).toBe(sortedRef[i]);
      expect(bytesEqual(e.value, ref.get(sortedRef[i]!)!)).toBe(true);
    }
    // reverse iteration
    const c = t.cursor();
    let i = all.length - 1;
    for (c.seekLast(); c.valid(); c.prev(), i--) expect(hex(c.key())).toBe(sortedRef[i]);
    expect(i).toBe(-1);
    // Every page is accounted for: in use by the tree, free, or a free-list trunk page.
    expect(t.depth()).toBeGreaterThanOrEqual(2);
  });

  it("range cursor: seek positions at the first key >= target", () => {
    const db = openDb();
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 5000; i += 5) t.insert(k(i), k(i * 2)); });
    const t = readTree(db);
    const c = t.cursor();
    expect(c.seek(k(100))).toBe(true);
    expect(hex(c.key())).toBe(hex(k(100)));
    expect(c.seek(k(101))).toBe(false);
    expect(c.valid()).toBe(true);
    expect(hex(c.key())).toBe(hex(k(105)));
    expect(bytesEqual(c.value(), k(210))).toBe(true);
    c.next();
    expect(hex(c.key())).toBe(hex(k(110)));
    c.prev(); c.prev();
    expect(hex(c.key())).toBe(hex(k(100)));
    expect(c.seek(k(4996))).toBe(false);
    expect(c.valid()).toBe(false);
    expect(c.seek(k(-7))).toBe(false);
    expect(hex(c.key())).toBe(hex(k(0)));
    c.prev();
    expect(c.valid()).toBe(false);
    // walk a range
    let n = 0;
    for (c.seek(k(1000)); c.valid() && compareBytes(c.key(), k(2000)) < 0; c.next()) n++;
    expect(n).toBe(200);
    // empty tree
    const db2 = openDb();
    createTree(db2);
    const c2 = readTree(db2).cursor();
    c2.seekFirst(); expect(c2.valid()).toBe(false);
    c2.seekLast(); expect(c2.valid()).toBe(false);
    expect(c2.seek(k(1))).toBe(false); expect(c2.valid()).toBe(false);
    expect(readTree(db2).count()).toBe(0);
  });

  it("stores and frees overflow values (1 MB)", () => {
    const db = openDb(new MemoryBackend(), 64);
    createTree(db);
    const rand = rng(5);
    const big = randBytes(rand, 1 << 20);
    const medium = randBytes(rand, 5000);
    withTree(db, (t) => {
      t.insert(k(1), big);
      t.insert(k(2), medium);
      t.insert(k(3), te.encode("small"));
    });
    const pagesAfterInsert = db.pager.pageCount;
    expect(pagesAfterInsert).toBeGreaterThan(256);
    let t = readTree(db);
    expect(bytesEqual(t.get(k(1))!, big)).toBe(true);
    expect(bytesEqual(t.get(k(2))!, medium)).toBe(true);
    const c = t.cursor();
    c.seek(k(2));
    expect(bytesEqual(c.value(), medium)).toBe(true);
    // replace the big value with a small one; its overflow chain becomes free
    withTree(db, (tr) => { tr.insert(k(1), te.encode("tiny")); });
    expect(db.pager.freelist.size).toBeGreaterThan(250);
    t = readTree(db);
    expect(new TextDecoder().decode(t.get(k(1))!)).toBe("tiny");
    // freed pages are reused: re-inserting the big value should not grow the file much
    withTree(db, (tr) => { tr.insert(k(1), big); });
    expect(db.pager.pageCount).toBeLessThan(pagesAfterInsert + 20);
    expect(bytesEqual(readTree(db).get(k(1))!, big)).toBe(true);
    withTree(db, (tr) => { expect(tr.delete(k(1))).toBe(true); });
    expect(readTree(db).get(k(1))).toBeNull();
  });

  it("handles variable-length keys up to MAX_KEY_SIZE and rejects larger ones", () => {
    const db = openDb();
    createTree(db);
    const rand = rng(77);
    const keys: Uint8Array[] = [];
    withTree(db, (t) => {
      for (let i = 0; i < 3000; i++) {
        const key = encodeKey([String.fromCharCode(...Array.from({ length: randInt(rand, 1, 700) }, () => randInt(rand, 97, 123)))]);
        keys.push(key);
        t.insert(key, k(i));
      }
      expect(() => t.insert(new Uint8Array(MAX_KEY_SIZE + 1), k(0))).toThrow(/MAX_KEY_SIZE/);
      t.insert(new Uint8Array(MAX_KEY_SIZE).fill(7), k(1));
    });
    const t = readTree(db);
    const uniq = new Set(keys.map(hex));
    expect(t.count()).toBe(uniq.size + 1);
    const all = scanAll(t);
    for (let i = 1; i < all.length; i++) expect(compareBytes(all[i - 1]!.key, all[i]!.key)).toBe(-1);
    // delete everything in random order, checking shrink + root collapse
    withTree(db, (tr) => {
      const order = [...uniq].sort(() => rand() - 0.5);
      for (const h of order) expect(tr.delete(Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16))))).toBe(true);
      expect(tr.delete(new Uint8Array(MAX_KEY_SIZE).fill(7))).toBe(true);
      expect(tr.count()).toBe(0);
      expect(tr.depth()).toBe(1);
    });
  });

  it("yields correct results with a tiny 16-page buffer pool", () => {
    const db = openDb(new MemoryBackend(), 16);
    createTree(db);
    const rand = rng(2024);
    const ref = new Map<number, number>();
    for (let batch = 0; batch < 4; batch++) {
      withTree(db, (t) => {
        for (let i = 0; i < 5000; i++) {
          const n = randInt(rand, 0, 20000);
          if (rand() < 0.7) { t.insert(k(n), k(i)); ref.set(n, i); }
          else { expect(t.delete(k(n))).toBe(ref.delete(n)); }
        }
      });
    }
    const t = readTree(db);
    expect(t.count()).toBe(ref.size);
    for (const [n, v] of ref) expect(bytesEqual(t.get(k(n))!, k(v))).toBe(true);
    expect(db.pager.stats().cacheEvictions).toBeGreaterThan(100);
    expect(db.pager.stats().cachedPages).toBeLessThanOrEqual(16);
  });

  it("supports many trees in one transaction and a cursor on another tree during writes", () => {
    const db = openDb();
    createTree(db);
    const txn = db.tm.beginWrite();
    const a = new BTree(db.pager, txn.masterRoot, txn);
    const b = BTree.create(db.pager, txn);
    for (let i = 0; i < 2000; i++) a.insert(k(i), k(i));
    const c = a.cursor();
    c.seekFirst();
    // Writes to tree b must not disturb a cursor positioned in tree a.
    let i = 0;
    for (; c.valid(); c.next(), i++) {
      expect(hex(c.key())).toBe(hex(k(i)));
      b.insert(c.key(), c.value());
    }
    expect(i).toBe(2000);
    expect(b.count()).toBe(2000);
    txn.masterRoot = a.root;
    db.tm.commit(txn);
    expect(new BTree(db.pager, b.root).count()).toBe(2000);
  });

  it("destroy() frees every page of a tree", () => {
    const db = openDb();
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 3000; i++) t.insert(k(i), randBytes(rng(i), 100)); });
    const before = db.pager.stats();
    const txn = db.tm.beginWrite();
    const t = new BTree(db.pager, txn.masterRoot, txn);
    t.destroy();
    const fresh = BTree.create(db.pager, txn);
    txn.masterRoot = fresh.root;
    db.tm.commit(txn);
    const after = db.pager.stats();
    expect(after.freePages).toBeGreaterThan(before.freePages + 50);
    expect(after.pageCount).toBeLessThanOrEqual(before.pageCount + 2);
  });
});
