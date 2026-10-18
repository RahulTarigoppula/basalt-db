# Basalt storage design notes

This note explains *why* the storage layer looks the way it does. `ARCHITECTURE.md` is the contract;
this is the reasoning behind it, plus a worked byte-level example of the on-disk formats.

## 1. Copy-on-write pages + two meta pages (no WAL)

A Basalt file is an array of 4 KB pages. Pages 0 and 1 are **meta pages**; everything else is a
B+tree page, an overflow page or a free-list trunk page. The meta page names the root of the master
catalog tree, the head of the free list, the logical page count and the txn id that produced it, and
it carries a CRC32.

A write transaction never modifies a page that is reachable from the committed meta page. The first
time it touches such a page it copies it to a fresh page id (`WriteTxn.allocate()` → free list or
file extension), modifies the copy, and the parent's child pointer is updated on the way back up the
tree — which copies the parent too, and so on, until the root. The root id therefore changes on the
first write of every transaction, and the new root is an entirely private tree that shares all
*untouched* subtrees with the committed one. Pages the transaction allocated itself are modified in
place (`WriteTxn.owns(pageId)`), so a long transaction pays the copy only once per page.

Commit is four steps: write every dirty page; `fsync`; write the meta page into the slot that is
**not** currently valid; `fsync`. If the process dies anywhere in that sequence the file still
contains the previous meta page, whose tree is intact because nobody overwrote any of its pages.
On open, `selectMeta` takes the slot with a valid checksum and the higher txn id. There is no redo
log to replay and no undo to apply: recovery is "read a meta page".

Rollback is equally cheap: drop the transaction's pages from the cache, return the page ids it
allocated to the free list and un-free the pre-image pages it had marked free. Nothing on disk that
matters was changed. The buffer pool may even have written dirty pages through to disk early (CLOCK
eviction does this) — they live at page ids that no committed snapshot references, so they are
invisible garbage until a meta page points at them.

### Trade-off versus WAL + undo/redo

| | COW + double meta (Basalt, LMDB) | WAL + undo/redo (SQLite WAL, Postgres) |
|---|---|---|
| Commit cost | Rewrite the root-to-leaf path for every touched leaf (≈ depth pages per distinct leaf) | Append log records; data pages written later (checkpoint) |
| Recovery | None: pick the valid meta page | Replay redo, undo losers; needs checksums per record |
| Readers vs writer | Never block each other; readers cost nothing | Readers may block checkpoints; need page-level latches or MVCC versions |
| Space | Pre-image pages are only reclaimable once old readers finish; small random updates amplify writes (path copy) | Log grows until checkpoint; in-place updates keep the file compact |
| Concurrency | One writer at a time | Multiple writers with row locks |
| Code size | Small; one place where atomicity lives | Large; logging touches every write path |

For an embedded engine with a single writer, the COW design buys crash safety and snapshot isolation
for a few hundred lines, at the cost of write amplification on scattered small updates and the
inability to run concurrent writers. That is the right trade for Basalt (browser + Node, one process).

## 2. Snapshot isolation for free

A read transaction is just the committed meta: `{txnId, masterRoot, freelistHead}`. Because no
committed page is ever modified, a reader that keeps using `masterRoot` sees exactly the state at
the time it started, no matter how many commits happen meanwhile. Readers never take locks and never
see torn pages. The only coordination is `TransactionManager.endRead()`, which exists solely so the
free list knows when old pages can be recycled.

Writers are serialised (`beginWrite()` throws if one is active; the engine queues statements).
Within a writer, **savepoints** are modelled as copy-on-write *epochs*: after `savepoint()`, pages the
transaction allocated earlier count as not-owned again, so later writes copy them. `rollbackTo()` then
only needs to drop the pages allocated since the savepoint, un-free the pages freed since, and restore
the root — no page contents are ever snapshotted. `release()` merges the epoch back into its parent.

## 3. Free-list reclamation with live readers

Every freed page is tagged with the txn id that freed it. A page freed by txn `T` is still part of
every snapshot with `txnId < T`, so it may be reused only when **every live reader has a snapshot
`>= T`**. `TransactionManager` recomputes the watermark on `beginRead`, `endRead`, `commit` and
`rollback` as `min(live reader snapshot ids)` (or the last committed txn id when nobody is reading),
and `FreeList.setBound()` moves eligible entries into the *ready* set that `allocate()` serves.

The in-flight writer's own pre-images carry its (uncommitted, hence `> bound`) txn id, so a writer
can never recycle a page that the crash-fallback snapshot still needs. Pages a transaction allocated
*and* freed itself carry tag `0` and are reusable immediately. The list is persisted at commit into
FREELIST trunk pages (`[pageId u32][txnId u64]` per entry, chained through the header's `right`
field); the previous trunk pages are freed with the committing txn id and appear in the new list, so
the free list itself is copy-on-write and the crash-fallback snapshot's free list is never
overwritten. A rolled-back transaction that extended the file leaves a longer file than the meta's
`pageCount`; the next extension simply reuses that tail.

## 4. Formats, with a worked example

### Key encoding (`core/encoding.ts`)

Keys must sort as `compareValues` does with plain `memcmp`, so an index can serve `ORDER BY` and range
scans without decoding. Each value is a tag byte plus payload:

| Value | Bytes | Why |
|---|---|---|
| `42n` | `06 80 00 00 00 00 00 00 2a 00` | tag `06`, int64 big-endian with the sign bit flipped (so negatives sort first), flag `00` = integral |
| `-1n` | `06 7f ff ff ff ff ff ff ff 00` | `0xFFFF…FF ^ 0x8000…00` |
| `2.5` | `06 80 00 00 00 00 00 00 02 01 c0 04 00 00 00 00 00 00` | `floor = 2`, flag `01`, then the IEEE bits of 2.5 (`4004 0000 0000 0000`) with the sign bit set so all finite doubles order as unsigned bytes |
| `-2.5` | `06 7f ff ff ff ff ff ff fd 01 3f fb ff ff ff ff ff ff` | `floor = -3`; negative doubles have all bits inverted |
| `"a\0b"` | `09 61 00 ff 62 00 00` | tag `09`, bytes with `00 → 00 ff`, terminator `00 00` |
| `[null, true]` | `01 02 01` | composite keys simply concatenate |

Reading the table: `2n < 2.5 < 3n` holds because `2.5` shares the floor bucket of `2` and the flag
byte `01` sorts after `00`, while `3n`'s bucket is larger. `5n` and `5.0` encode identically — exactly
what `compareValues` demands — which is why `decodeKey` returns `5n` for both; exact types live in
the record format. Numbers outside the int64 range, `±Infinity` and `NaN` use neighbouring tags
`03..08` so they still sort correctly against in-range values (`NaN` first, matching `compareValues`).
Text is encoded per UTF-16 code unit (CESU-8), so the byte order equals JavaScript's string order.

### Record format

`encodeRecord([42n, "hi", null, 2.5, true])` →

```
05                      5 columns
03 08 02 00 07 02       type codes: INT8, TEXT(len 2), NULL, REAL, TRUE
2a                      42
68 69                   "hi"
40 04 00 00 00 00 00 00 2.5
```

NULL and booleans occupy only their type code; integers use 1/2/4/8 bytes (`300n` → `04 01 2c`).

### Pages

```
offset  0  type u8        1  flags u8    2  cellCount u16  4  freeStart u16  6  freeEnd u16
        8  right u32 (interior: rightmost child; overflow/freelist: next page; leaf: 0)
       12  fragBytes u16  14 reserved
       16  cell pointers (u16 each) ...                     ... cells (growing down from 4096)
```

Interior cell `[child u32][keyLen varint][key]`; leaf cell `[keyLen varint][valueLen varint][key][value]`,
or `[…][key][overflowPage u32]` when the cell would exceed 1000 bytes — then the value lives in a
chain of OVERFLOW pages (4080 payload bytes each). A separator key in an interior page is the first
key of the subtree to its right, so a lookup descends to the first child whose separator is greater
than the search key. Leaves have no sibling pointers: under copy-on-write a copied leaf would leave
its left neighbour's pointer stale, so cursors keep the root-to-leaf path and climb to move between
leaves.
