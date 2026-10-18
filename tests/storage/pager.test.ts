import { describe, expect, it } from "vitest";
import { encodeKey } from "../../src/core/encoding";
import { MemoryBackend } from "../../src/storage/backend";
import { BTree } from "../../src/storage/btree";
import { decodeMeta, encodeMeta, selectMeta } from "../../src/storage/meta";
import { PAGE_SIZE, PageType, initPage, insertCell, cellCount, cellOffset, deleteCell, totalFree, contiguousFree, USABLE_SIZE, liveBytes } from "../../src/storage/page";
import { Pager } from "../../src/storage/pager";
import { CrashSimBackend } from "../../src/storage/testing";
import { TransactionManager } from "../../src/txn/transaction";
import { bytesEqual, createTree, hex, openDb, randBytes, readTree, rng, scanAll, withTree } from "./helpers";

const k = (n: number) => encodeKey([BigInt(n)]);

describe("meta pages", () => {
  it("formats a fresh file with two meta pages", () => {
    const db = openDb();
    const m = db.pager.readMeta();
    expect(m.txnId).toBe(0);
    expect(m.pageCount).toBe(2);
    expect(m.masterRoot).toBe(0);
    expect(db.backend.pageCount()).toBe(2);
  });

  it("selects the valid meta with the highest txn id and rejects bad checksums", () => {
    const a = new Uint8Array(PAGE_SIZE), b = new Uint8Array(PAGE_SIZE);
    encodeMeta({ formatVersion: 1, pageSize: PAGE_SIZE, txnId: 5, masterRoot: 2, freelistHead: 0, pageCount: 10 }, a);
    encodeMeta({ formatVersion: 1, pageSize: PAGE_SIZE, txnId: 6, masterRoot: 3, freelistHead: 0, pageCount: 11 }, b);
    expect(selectMeta(a, b)).toEqual({ meta: decodeMeta(b), slot: 1 });
    b[20] = b[20]! ^ 0xff; // corrupt txnId byte -> checksum mismatch
    expect(decodeMeta(b)).toBeNull();
    expect(selectMeta(a, b).slot).toBe(0);
    expect(() => selectMeta(b, b)).toThrow(/no valid meta/);
    expect(decodeMeta(a)!.txnId).toBe(5);
  });

  it("alternates meta slots on commit", () => {
    const db = openDb();
    createTree(db); // txn 1 -> slot 1
    withTree(db, (t) => t.insert(k(1), k(1))); // txn 2 -> slot 0
    const s0 = new Uint8Array(PAGE_SIZE), s1 = new Uint8Array(PAGE_SIZE);
    db.backend.readSync(0, s0); db.backend.readSync(1, s1);
    expect(decodeMeta(s0)!.txnId).toBe(2);
    expect(decodeMeta(s1)!.txnId).toBe(1);
  });
});

describe("slotted page", () => {
  it("inserts, deletes and defragments cells", () => {
    const d = new Uint8Array(PAGE_SIZE);
    initPage(d, PageType.LEAF);
    const sizeOf = (p: Uint8Array, off: number) => p[off]!; // cell = [len][payload...]
    const mk = (len: number, fill: number) => { const c = new Uint8Array(len); c.fill(fill); c[0] = len; return c; };
    let n = 0;
    while (totalFree(d) >= 100 + 2) { insertCell(d, n % 2 === 0 ? n : 0, mk(100, n), sizeOf); n++; }
    expect(cellCount(d)).toBe(n);
    expect(liveBytes(d)).toBe(n * 102);
    // delete every other cell -> fragmentation
    for (let i = cellCount(d) - 1; i >= 0; i -= 2) deleteCell(d, i, 100);
    expect(cellCount(d)).toBe(Math.floor(n / 2));
    expect(totalFree(d)).toBeGreaterThan(contiguousFree(d));
    // a big cell only fits after defragmentation
    const big = mk(Math.min(255, contiguousFree(d) + 50), 9);
    insertCell(d, 0, big, sizeOf);
    expect(d[cellOffset(d, 0)]).toBe(big.length);
    expect(liveBytes(d)).toBe(Math.floor(n / 2) * 102 + big.length + 2);
    expect(USABLE_SIZE - totalFree(d)).toBe(liveBytes(d));
  });
});

describe("persistence", () => {
  it("reopens from the same bytes and reads the data", () => {
    const backend = new MemoryBackend();
    const db = openDb(backend);
    createTree(db);
    const rand = rng(1);
    const values = new Map<number, Uint8Array>();
    withTree(db, (t) => { for (let i = 0; i < 3000; i++) { const v = randBytes(rand, 50); values.set(i, v); t.insert(k(i), v); } });
    withTree(db, (t) => { for (let i = 0; i < 3000; i += 3) { t.delete(k(i)); values.delete(i); } });
    const image = backend.toBytes();
    const db2 = openDb(MemoryBackend.fromBytes(image));
    expect(db2.pager.readMeta()).toEqual(db.pager.readMeta());
    const t = readTree(db2);
    expect(t.count()).toBe(values.size);
    for (const [i, v] of values) expect(bytesEqual(t.get(k(i))!, v)).toBe(true);
    expect(db2.pager.freelist.size).toBe(db.pager.freelist.size);
    // and keeps working after reopen
    withTree(db2, (tr) => tr.insert(k(99999), k(1)));
    expect(readTree(db2).get(k(99999))).not.toBeNull();
  });

  it("rejects a truncated file", () => {
    const backend = new MemoryBackend();
    const db = openDb(backend);
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 2000; i++) t.insert(k(i), k(i)); });
    const image = backend.toBytes().subarray(0, 4 * PAGE_SIZE);
    expect(() => new Pager(MemoryBackend.fromBytes(image))).toThrow(/meta records/);
  });
});

describe("crash simulation", () => {
  it("a crash before the meta write leaves the previous commit intact", () => {
    const backend = new CrashSimBackend();
    const db = openDb(backend);
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 1000; i++) t.insert(k(i), k(i)); }); // commit A
    const metaA = db.pager.readMeta();
    const txn = db.tm.beginWrite();
    const tree = new BTree(db.pager, txn.masterRoot, txn);
    for (let i = 1000; i < 3000; i++) tree.insert(k(i), k(i));
    for (let i = 0; i < 500; i++) tree.delete(k(i));
    txn.masterRoot = tree.root;
    db.pager.flush(); // pages written but not synced
    expect(backend.unsyncedWrites).toBeGreaterThan(0);
    backend.crash();
    const db2 = openDb(backend);
    expect(db2.pager.readMeta()).toEqual(metaA);
    const t = readTree(db2);
    expect(t.count()).toBe(1000);
    for (let i = 0; i < 1000; i++) expect(t.get(k(i))).not.toBeNull();
    expect(t.get(k(1500))).toBeNull();
    // the reopened database is fully functional
    withTree(db2, (tr) => tr.insert(k(5), k(55)));
    expect(bytesEqual(readTree(db2).get(k(5))!, k(55))).toBe(true);
  });

  it("a crash after data pages are synced but before the meta page still yields the old snapshot", () => {
    const backend = new CrashSimBackend();
    const db = openDb(backend);
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 500; i++) t.insert(k(i), k(i)); });
    const metaA = db.pager.readMeta();
    const txn = db.tm.beginWrite();
    const tree = new BTree(db.pager, txn.masterRoot, txn);
    for (let i = 500; i < 1500; i++) tree.insert(k(i), k(i));
    db.pager.flush();
    backend.syncSync(); // data durable, meta not yet written
    backend.crash();
    const db2 = openDb(backend);
    expect(db2.pager.readMeta()).toEqual(metaA);
    expect(readTree(db2).count()).toBe(500);
  });

  it("a crash with the new meta page written but unsynced falls back too; synced meta is durable", () => {
    const backend = new CrashSimBackend();
    const db = openDb(backend);
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 300; i++) t.insert(k(i), k(i)); });
    const metaA = db.pager.readMeta();
    const txn = db.tm.beginWrite();
    const tree = new BTree(db.pager, txn.masterRoot, txn);
    tree.insert(k(1000), k(1));
    txn.masterRoot = tree.root;
    db.pager.flush(); backend.syncSync();
    db.pager.writeMeta({ ...metaA, txnId: txn.txnId, masterRoot: tree.root, pageCount: db.pager.pageCount });
    backend.crash(); // meta write lost
    let db2 = openDb(backend);
    expect(db2.pager.readMeta()).toEqual(metaA);
    // Now do it properly through the manager: durable.
    const txn2 = db2.tm.beginWrite();
    const t2 = new BTree(db2.pager, txn2.masterRoot, txn2);
    t2.insert(k(1000), k(1));
    txn2.masterRoot = t2.root;
    db2.tm.commit(txn2);
    backend.crash(); // nothing pending
    db2 = openDb(backend);
    expect(readTree(db2).get(k(1000))).not.toBeNull();
    expect(readTree(db2).count()).toBe(301);
  });
});

describe("buffer pool", () => {
  it("throws a clear error when every frame is pinned", () => {
    const db = openDb(new MemoryBackend(), 4);
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 2000; i++) t.insert(k(i), k(i)); });
    const pinned = [db.pager.get(2), db.pager.get(3), db.pager.get(4), db.pager.get(5)];
    expect(() => db.pager.get(6)).toThrow(/buffer pool exhausted/);
    for (const p of pinned) p.unpin();
    expect(() => db.pager.get(6).unpin()).not.toThrow();
  });

  it("counts hits and misses", () => {
    const db = openDb(new MemoryBackend(), 8);
    createTree(db);
    const before = db.pager.stats();
    db.pager.get(2).unpin();
    db.pager.get(2).unpin();
    const after = db.pager.stats();
    expect(after.cacheHits - before.cacheHits).toBe(2);
    expect(after.cacheMisses).toBe(before.cacheMisses);
  });
});

describe("free list", () => {
  it("keeps the file size bounded under insert/delete churn", () => {
    const db = openDb(new MemoryBackend(), 128);
    createTree(db);
    const rand = rng(3);
    withTree(db, (t) => { for (let i = 0; i < 2000; i++) t.insert(k(i), randBytes(rand, 100)); });
    const base = db.pager.pageCount;
    let maxPages = base;
    for (let round = 0; round < 40; round++) {
      withTree(db, (t) => {
        for (let i = 0; i < 2000; i++) if (rand() < 0.5) t.insert(k(i), randBytes(rand, 100));
        for (let i = 0; i < 2000; i++) if (rand() < 0.3) t.delete(k(i));
      });
      maxPages = Math.max(maxPages, db.pager.pageCount);
    }
    // Every commit copies the touched path (COW) but recycles previously freed pages; growth stays
    // within a small multiple of the live tree size rather than growing per commit.
    expect(maxPages).toBeLessThan(base * 3);
    expect(db.pager.freelist.size).toBeLessThan(base * 2);
    const t = readTree(db);
    expect(t.count()).toBe(scanAll(t).length);
  });

  it("does not recycle pages still visible to a live reader", () => {
    const db = openDb();
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 2000; i++) t.insert(k(i), k(i)); });
    const snap = db.tm.beginRead();
    const oldTree = new BTree(db.pager, snap.masterRoot);
    const pagesBefore = db.pager.pageCount;
    withTree(db, (t) => { for (let i = 0; i < 2000; i++) t.insert(k(i), k(i + 1)); }); // rewrites every leaf
    expect(db.pager.freelist.size).toBeGreaterThan(10);
    expect(db.pager.freelist.readyCount).toBe(0); // all freed pages are tagged newer than the reader
    expect(db.pager.pageCount).toBeGreaterThan(pagesBefore);
    // The reader still sees its snapshot even after another full rewrite.
    withTree(db, (t) => { for (let i = 0; i < 2000; i++) t.insert(k(i), k(i + 2)); });
    for (let i = 0; i < 2000; i += 97) expect(hex(oldTree.get(k(i))!)).toBe(hex(k(i)));
    expect(oldTree.count()).toBe(2000);
    db.tm.endRead(snap);
    expect(db.pager.freelist.readyCount).toBe(db.pager.freelist.size);
    const pagesAfter = db.pager.pageCount;
    withTree(db, (t) => { for (let i = 0; i < 2000; i++) t.insert(k(i), k(i + 3)); });
    expect(db.pager.pageCount).toBeLessThanOrEqual(pagesAfter + 2);
  });

  it("persists the free list across reopen", () => {
    const backend = new MemoryBackend();
    const db = openDb(backend);
    createTree(db);
    withTree(db, (t) => { for (let i = 0; i < 3000; i++) t.insert(k(i), randBytes(rng(i), 120)); });
    withTree(db, (t) => { for (let i = 0; i < 3000; i++) t.delete(k(i)); });
    const entries = db.pager.freelist.entries().map((e) => e.pageId).sort((a, b) => a - b);
    expect(entries.length).toBeGreaterThan(50);
    const db2 = openDb(MemoryBackend.fromBytes(backend.toBytes()));
    const entries2 = db2.pager.freelist.entries().map((e) => e.pageId).sort((a, b) => a - b);
    expect(entries2).toEqual(entries);
    expect(db2.pager.freelist.readyCount).toBe(entries.length);
    expect(db2.pager.freelist.trunkPages.length).toBeGreaterThan(0);
    // refilling reuses the free pages rather than growing the file
    const pages = db2.pager.pageCount;
    withTree(db2, (t) => { for (let i = 0; i < 1000; i++) t.insert(k(i), randBytes(rng(i), 120)); });
    expect(db2.pager.pageCount).toBe(pages);
  });
});

describe("TransactionManager basics", () => {
  it("rejects a second concurrent writer", () => {
    const db = openDb();
    const txn = db.tm.beginWrite();
    expect(() => db.tm.beginWrite()).toThrow(/already active/);
    db.tm.rollback(txn);
    expect(db.tm.beginWrite()).toBeTruthy();
    expect(new TransactionManager(db.pager)).toBeTruthy();
  });
});
