import { describe, expect, it } from "vitest";
import { encodeKey } from "../../src/core/encoding";
import { MemoryBackend } from "../../src/storage/backend";
import { BTree } from "../../src/storage/btree";
import { bytesEqual, createTree, hex, openDb, randBytes, readTree, rng, scanAll, withTree } from "./helpers";

const k = (n: number) => encodeKey([BigInt(n)]);

function keysOf(tree: BTree): number[] {
  return scanAll(tree).map((e) => Number(BigInt.asIntN(64, BigInt("0x" + hex(e.key).slice(2, 18)) ^ (1n << 63n))));
}

describe("rollback", () => {
  it("restores the committed state, page count and free list", () => {
    const backend = new MemoryBackend();
    const db = openDb(backend, 32);
    createTree(db);
    const rand = rng(11);
    withTree(db, (t) => { for (let i = 0; i < 1000; i++) t.insert(k(i), randBytes(rand, 60)); });
    const metaA = db.pager.readMeta();
    const freeA = db.pager.freelist.entries().map((e) => e.pageId).sort((a, b) => a - b);
    const imageA = backend.toBytes();

    const txn = db.tm.beginWrite();
    const tree = new BTree(db.pager, txn.masterRoot, txn);
    for (let i = 1000; i < 2500; i++) tree.insert(k(i), randBytes(rand, 60));
    for (let i = 0; i < 300; i++) tree.delete(k(i));
    tree.insert(k(5), randBytes(rand, 100_000)); // overflow chain, extends the file
    txn.masterRoot = tree.root;
    expect(db.pager.pageCount).toBeGreaterThan(metaA.pageCount);
    db.tm.rollback(txn);

    expect(db.pager.readMeta()).toEqual(metaA);
    expect(db.pager.pageCount).toBe(metaA.pageCount);
    expect(db.pager.freelist.entries().map((e) => e.pageId).sort((a, b) => a - b)).toEqual(freeA);
    expect(txn.state).toBe("rolledBack");
    expect(() => txn.allocate()).toThrow(/rolledBack/);
    const t = readTree(db);
    expect(t.count()).toBe(1000);
    expect(keysOf(t)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    // Every page that belongs to the committed snapshot is byte-for-byte untouched (only pages that
    // were already free may have been written through by the aborted transaction).
    const imageB = backend.toBytes();
    const freeSet = new Set(freeA);
    for (let p = 0; p < metaA.pageCount; p++) {
      if (freeSet.has(p)) continue;
      expect(bytesEqual(imageA.subarray(p * 4096, (p + 1) * 4096), imageB.subarray(p * 4096, (p + 1) * 4096))).toBe(true);
    }
    // and a following transaction works and reuses the space
    withTree(db, (tr) => { for (let i = 0; i < 200; i++) tr.insert(k(i), k(i)); });
    expect(readTree(db).count()).toBe(1000);
  });
});

describe("savepoints", () => {
  it("rollbackTo undoes everything after the savepoint, keeps earlier work, and the txn can commit", () => {
    const db = openDb();
    createTree(db);
    const txn = db.tm.beginWrite();
    const tree = new BTree(db.pager, txn.masterRoot, txn);
    for (let i = 1; i <= 100; i++) tree.insert(k(i), k(i));
    txn.masterRoot = tree.root;
    const pagesAtSp = db.pager.pageCount;
    const sp = txn.savepoint();

    for (let i = 101; i <= 2000; i++) tree.insert(k(i), k(i));
    for (let i = 1; i <= 10; i++) tree.delete(k(i));
    tree.insert(k(50), k(5000));
    txn.masterRoot = tree.root;
    expect(tree.count()).toBe(1990);

    txn.rollbackTo(sp);
    expect(db.pager.pageCount).toBe(pagesAtSp);
    const restored = new BTree(db.pager, txn.masterRoot, txn);
    expect(restored.count()).toBe(100);
    expect(keysOf(restored)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(bytesEqual(restored.get(k(50))!, k(50))).toBe(true);

    // the savepoint is still active: roll back to it again after more work
    for (let i = 300; i < 400; i++) restored.insert(k(i), k(i));
    txn.masterRoot = restored.root;
    txn.rollbackTo(sp);
    const again = new BTree(db.pager, txn.masterRoot, txn);
    expect(again.count()).toBe(100);

    // continue and commit
    for (let i = 101; i <= 150; i++) again.insert(k(i), k(i));
    txn.masterRoot = again.root;
    db.tm.commit(txn);
    expect(keysOf(readTree(db))).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
  });

  it("nested savepoints and release", () => {
    const db = openDb();
    createTree(db);
    const txn = db.tm.beginWrite();
    const tree = new BTree(db.pager, txn.masterRoot, txn);
    tree.insert(k(1), k(1));
    txn.masterRoot = tree.root;
    const sp1 = txn.savepoint();
    tree.insert(k(2), k(2));
    txn.masterRoot = tree.root;
    const sp2 = txn.savepoint();
    tree.insert(k(3), k(3));
    txn.masterRoot = tree.root;
    const sp3 = txn.savepoint();
    tree.insert(k(4), k(4));
    txn.masterRoot = tree.root;
    txn.release(sp3); // 4 stays
    txn.rollbackTo(sp2); // 3 and 4 go
    expect(() => txn.rollbackTo(sp3)).toThrow(/no longer active/);
    let t = new BTree(db.pager, txn.masterRoot, txn);
    expect(keysOf(t)).toEqual([1, 2]);
    t.insert(k(9), k(9));
    txn.masterRoot = t.root;
    txn.rollbackTo(sp1);
    t = new BTree(db.pager, txn.masterRoot, txn);
    expect(keysOf(t)).toEqual([1]);
    t.insert(k(7), k(7));
    txn.masterRoot = t.root;
    db.tm.commit(txn);
    expect(keysOf(readTree(db))).toEqual([1, 7]);
  });

  it("rollbackTo with a tiny pool (pages evicted and re-read) and then full rollback", () => {
    const db = openDb(new MemoryBackend(), 8);
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 500; i++) t.insert(k(i), k(i)); });
    const metaA = db.pager.readMeta();
    const txn = db.tm.beginWrite();
    const tree = new BTree(db.pager, txn.masterRoot, txn);
    for (let i = 500; i < 1000; i++) tree.insert(k(i), k(i));
    txn.masterRoot = tree.root;
    const sp = txn.savepoint();
    for (let i = 0; i < 1000; i++) tree.delete(k(i));
    expect(tree.count()).toBe(0);
    txn.rollbackTo(sp);
    expect(new BTree(db.pager, txn.masterRoot, txn).count()).toBe(1000);
    db.tm.rollback(txn);
    expect(db.pager.readMeta()).toEqual(metaA);
    expect(readTree(db).count()).toBe(500);
  });
});

describe("snapshot isolation", () => {
  it("a reader keeps its snapshot while a writer commits; new readers see the new data", () => {
    const db = openDb();
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 1000; i++) t.insert(k(i), k(i)); });
    const snap = db.tm.beginRead();
    const reader = new BTree(db.pager, snap.masterRoot);
    const cursor = reader.cursor();
    cursor.seek(k(500));

    const txn = db.tm.beginWrite();
    const writer = new BTree(db.pager, txn.masterRoot, txn);
    for (let i = 0; i < 1000; i++) writer.insert(k(i), k(i * 10));
    for (let i = 1000; i < 1500; i++) writer.insert(k(i), k(i));
    txn.masterRoot = writer.root;
    // uncommitted: the reader sees nothing of it
    expect(bytesEqual(reader.get(k(3))!, k(3))).toBe(true);
    db.tm.commit(txn);

    // committed: the old snapshot is unchanged, including a cursor opened before the commit
    expect(reader.count()).toBe(1000);
    expect(bytesEqual(reader.get(k(3))!, k(3))).toBe(true);
    expect(reader.get(k(1200))).toBeNull();
    let n = 0;
    for (; cursor.valid(); cursor.next(), n++) expect(bytesEqual(cursor.value(), cursor.key())).toBe(true);
    expect(n).toBe(500);

    const snap2 = db.tm.beginRead();
    expect(snap2.txnId).toBe(snap.txnId + 1);
    const reader2 = new BTree(db.pager, snap2.masterRoot);
    expect(reader2.count()).toBe(1500);
    expect(bytesEqual(reader2.get(k(3))!, k(30))).toBe(true);
    db.tm.endRead(snap);
    db.tm.endRead(snap2);
    expect(() => db.tm.endRead(snap)).toThrow(/not active/);
  });
});
