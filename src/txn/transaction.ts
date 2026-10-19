/**
 * Transactions on top of copy-on-write roots: snapshot isolation with one writer and any number of
 * readers (the LMDB model).
 *
 * - A **read snapshot** is just the committed meta: `{txnId, masterRoot, freelistHead}`. Readers never
 *   block and never see a page change under them, because writers never modify committed pages.
 * - A **write transaction** owns every page it allocates and copies any other page before touching it.
 *   Commit = flush dirty pages, fsync, write the other meta slot, fsync. Rollback = drop the pages it
 *   allocated and un-free the pages it freed; nothing else was ever modified.
 * - **Savepoints** are copy-on-write epochs: after `savepoint()`, pages allocated earlier in the
 *   transaction count as *not owned* and are copied before modification, so `rollbackTo()` only needs
 *   to discard the pages allocated since the savepoint and un-free the pages freed since. No page
 *   contents are ever snapshotted.
 */
import { StorageError, TransactionError } from "../core/errors";
import { type PageRef } from "../storage/bufferpool";
import { type WriteContext } from "../storage/btree";
import { type Meta } from "../storage/meta";
import { type Pager } from "../storage/pager";

/** A read snapshot: the committed roots as of `txnId`. */
export interface Snapshot {
  readonly txnId: number;
  readonly masterRoot: number;
  readonly freelistHead: number;
}

/** Opaque savepoint handle returned by `WriteTxn.savepoint()`. */
export interface SavepointToken {
  readonly epoch: number;
  readonly masterRoot: number;
  readonly freedLogLength: number;
  readonly pageCount: number;
}

export type TxnState = "active" | "committed" | "rolledBack";

/**
 * A write transaction. Implements the B+tree's `WriteContext`; the catalog/engine layers read
 * `masterRoot` back after writes and set it to the new catalog root before `commit`.
 */
export class WriteTxn implements WriteContext {
  /** Id this transaction will commit as (committed txnId + 1). */
  readonly txnId: number;
  /** Root of the master catalog tree; mutable, written to the meta page on commit. */
  masterRoot: number;
  /** Free-list head of the snapshot this transaction started from (informational). */
  readonly freelistHead: number;
  /** Logical page count when the transaction began (restored on rollback). */
  readonly startPageCount: number;
  state: TxnState = "active";

  /** Pages allocated per savepoint epoch; the last set is the current epoch. */
  private readonly epochs: Set<number>[] = [new Set()];
  /** Committed pages freed by this transaction (tagged `txnId` in the free list), in order. */
  private readonly freedLog: number[] = [];

  constructor(private readonly pager: Pager, base: Meta) {
    this.txnId = base.txnId + 1;
    this.masterRoot = base.masterRoot;
    this.freelistHead = base.freelistHead;
    this.startPageCount = pager.pageCount;
  }

  /** Pages allocated in the current savepoint epoch (modifiable in place). */
  get allocatedPages(): ReadonlySet<number> { return this.epochs[this.epochs.length - 1]!; }

  owns(pageId: number): boolean { return this.epochs[this.epochs.length - 1]!.has(pageId); }

  allocate(): PageRef {
    this.assertActive();
    const ref = this.pager.allocate();
    this.epochs[this.epochs.length - 1]!.add(ref.id);
    return ref;
  }

  free(pageId: number): void {
    this.assertActive();
    const epoch = this.epochs[this.epochs.length - 1]!;
    if (epoch.has(pageId)) {
      epoch.delete(pageId);
      this.pager.free(pageId, 0);
    } else {
      this.freedLog.push(pageId);
      this.pager.free(pageId, this.txnId);
    }
  }

  /** Opens a savepoint; later writes copy pages allocated before it, so they can be undone. */
  savepoint(): SavepointToken {
    this.assertActive();
    const token: SavepointToken = {
      epoch: this.epochs.length,
      masterRoot: this.masterRoot,
      freedLogLength: this.freedLog.length,
      pageCount: this.pager.pageCount,
    };
    this.epochs.push(new Set());
    return token;
  }

  /** Undoes everything since `token` (the savepoint stays open, like SQL `ROLLBACK TO`). */
  rollbackTo(token: SavepointToken): void {
    this.assertActive();
    if (token.epoch < 1 || token.epoch >= this.epochs.length) throw new TransactionError("savepoint is no longer active");
    for (let e = this.epochs.length - 1; e >= token.epoch; e--) {
      for (const id of this.epochs[e]!) {
        this.pager.discard(id);
        if (id < token.pageCount) this.pager.free(id, 0);
      }
    }
    for (let i = token.freedLogLength; i < this.freedLog.length; i++) this.pager.freelist.remove(this.freedLog[i]!);
    this.freedLog.length = token.freedLogLength;
    this.epochs.length = token.epoch;
    this.epochs.push(new Set());
    this.masterRoot = token.masterRoot;
    this.pager.truncate(token.pageCount);
  }

  /**
   * Closes `token` (SQL `RELEASE`): pages allocated since it become modifiable in place again.
   *
   * Pages freed since the savepoint that this transaction itself allocated (in the target epoch or
   * later) were never visible to any reader and no open savepoint can still need them, so they are
   * retagged `0` and become reusable at once instead of waiting for commit. Without this every
   * statement of a long transaction (each runs under its own savepoint) would copy the pages the
   * previous statement wrote and the file would grow by a few pages per statement.
   */
  release(token: SavepointToken): void {
    this.assertActive();
    if (token.epoch < 1 || token.epoch >= this.epochs.length) throw new TransactionError("savepoint is no longer active");
    const target = this.epochs[token.epoch - 1]!;
    for (let e = token.epoch; e < this.epochs.length; e++) for (const id of this.epochs[e]!) target.add(id);
    this.epochs.length = token.epoch;
    const log = this.freedLog;
    if (log.length > token.freedLogLength) {
      let w = token.freedLogLength;
      for (let i = token.freedLogLength; i < log.length; i++) {
        const id = log[i]!;
        if (target.has(id)) {
          target.delete(id);
          this.pager.free(id, 0);
        } else {
          log[w++] = id;
        }
      }
      log.length = w;
    }
  }

  /** @internal every page allocated by this transaction, across epochs. */
  *allAllocated(): IterableIterator<number> {
    for (const epoch of this.epochs) yield* epoch;
  }

  private assertActive(): void {
    if (this.state !== "active") throw new TransactionError(`transaction ${this.txnId} is ${this.state}`);
  }
}

export class TransactionManager {
  private writer: WriteTxn | null = null;
  /** Live read snapshots: txnId -> number of readers holding it. */
  private readonly readers = new Map<number, number>();

  constructor(readonly pager: Pager) {}

  /** The last committed meta. */
  get committed(): Meta { return this.pager.readMeta(); }

  get activeWriter(): WriteTxn | null { return this.writer; }

  /** Number of live read snapshots. */
  get readerCount(): number {
    let n = 0;
    for (const c of this.readers.values()) n += c;
    return n;
  }

  /** Takes a read snapshot of the committed state. Pair with `endRead` so free pages can be reclaimed. */
  beginRead(): Snapshot {
    const m = this.pager.readMeta();
    this.readers.set(m.txnId, (this.readers.get(m.txnId) ?? 0) + 1);
    this.recomputeBound();
    return { txnId: m.txnId, masterRoot: m.masterRoot, freelistHead: m.freelistHead };
  }

  endRead(snapshot: Snapshot): void {
    const c = this.readers.get(snapshot.txnId);
    if (c === undefined) throw new TransactionError(`read snapshot ${snapshot.txnId} is not active`);
    if (c === 1) this.readers.delete(snapshot.txnId);
    else this.readers.set(snapshot.txnId, c - 1);
    this.recomputeBound();
  }

  /** Starts the single write transaction. Throws if one is already active (the engine serialises writers). */
  beginWrite(): WriteTxn {
    if (this.writer) throw new TransactionError("a write transaction is already active");
    this.writer = new WriteTxn(this.pager, this.pager.readMeta());
    return this.writer;
  }

  /**
   * Commits: persist the free list, flush dirty pages, fsync, write the other meta slot, fsync.
   * A crash before the second fsync leaves the previous meta page (and so the previous snapshot) valid.
   */
  commit(txn: WriteTxn): void {
    this.checkWriter(txn);
    const pager = this.pager;
    const freelistHead = pager.freelist.persist(pager, txn);
    pager.flush();
    pager.sync();
    const base = pager.readMeta();
    pager.writeMeta({
      formatVersion: base.formatVersion,
      pageSize: base.pageSize,
      txnId: txn.txnId,
      masterRoot: txn.masterRoot,
      freelistHead,
      pageCount: pager.pageCount,
    });
    pager.sync();
    txn.state = "committed";
    this.writer = null;
    this.recomputeBound();
  }

  /** Discards the transaction: drops its pages from the cache and returns them to the free list. */
  rollback(txn: WriteTxn): void {
    this.checkWriter(txn);
    const pager = this.pager;
    for (const id of txn.allAllocated()) {
      pager.discard(id);
      if (id < txn.startPageCount) pager.free(id, 0);
    }
    pager.freelist.removeTagged(txn.txnId);
    pager.truncate(txn.startPageCount);
    txn.state = "rolledBack";
    this.writer = null;
    this.recomputeBound();
  }

  private checkWriter(txn: WriteTxn): void {
    if (txn.state !== "active") throw new TransactionError(`transaction ${txn.txnId} is ${txn.state}`);
    if (txn !== this.writer) throw new StorageError("transaction does not belong to this manager");
  }

  /** Free pages are reusable once every live reader's snapshot is at least as new as the freeing txn. */
  private recomputeBound(): void {
    let bound = this.pager.readMeta().txnId;
    for (const t of this.readers.keys()) if (t < bound) bound = t;
    this.pager.setReusableBound(bound);
  }
}
