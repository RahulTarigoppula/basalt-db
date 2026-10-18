import { type Backend, MemoryBackend } from "../../src/storage/backend";
import { BTree } from "../../src/storage/btree";
import { Pager } from "../../src/storage/pager";
import { TransactionManager, type WriteTxn } from "../../src/txn/transaction";

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo));
}

export function randBytes(rand: () => number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

export interface Db { backend: Backend; pager: Pager; tm: TransactionManager }

export function openDb(backend: Backend = new MemoryBackend(), poolPages = 256): Db {
  const pager = new Pager(backend, poolPages);
  return { backend, pager, tm: new TransactionManager(pager) };
}

/** Creates an empty tree in a committed transaction and returns its root (stored as masterRoot). */
export function createTree(db: Db): number {
  const txn = db.tm.beginWrite();
  const tree = BTree.create(db.pager, txn);
  txn.masterRoot = tree.root;
  db.tm.commit(txn);
  return tree.root;
}

/** Runs `fn` against the master tree inside a write txn and commits, returning the new root. */
export function withTree(db: Db, fn: (tree: BTree, txn: WriteTxn) => void): number {
  const txn = db.tm.beginWrite();
  const tree = new BTree(db.pager, txn.masterRoot, txn);
  fn(tree, txn);
  txn.masterRoot = tree.root;
  db.tm.commit(txn);
  return tree.root;
}

/** Read-only view of the committed master tree. */
export function readTree(db: Db): BTree {
  return new BTree(db.pager, db.pager.readMeta().masterRoot);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function hex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

/** Collects all (key, value) pairs of a tree in cursor order. */
export function scanAll(tree: BTree): { key: Uint8Array; value: Uint8Array }[] {
  const out: { key: Uint8Array; value: Uint8Array }[] = [];
  const c = tree.cursor();
  for (c.seekFirst(); c.valid(); c.next()) out.push({ key: c.key(), value: c.value() });
  return out;
}
