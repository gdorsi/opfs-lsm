# opfs-lsm design

--------------------------------------------------------------------------------------------------

`@opfs-lsm/kv` is an embedded key-value store for the browser. Keys and values are byte arrays.
It is a log-structured merge tree (LSM). Writes go to a write-ahead log in IndexedDB. Sorted,
immutable SST files in the Origin Private File System (OPFS) hold the data once it has been
flushed out of the log.

Every tab of an origin can open the same database. Each tab writes to the shared log, keeps its
own in-memory table of the writes that are not yet in an SST, and answers reads from memory. One
SharedWorker turns the log into SST files and compacts them. A SharedWorker is a single script
that every tab of the origin shares. It isn't a dedicated WebWorker or a ServiceWorker.

`@opfs-lsm/collections` builds tables and secondary indexes on top of the kv API. This document
covers only the kv engine.

The design ranks goals in this order (see `AGENTS.md`):
1. Read and write latency.
2. Consistency. Every read sees the state after one prefix of the log.
3. Persistence. A write that was acked should survive, but the engine trades this away before
   the first two.

All multi-byte integers on disk are little-endian.

# Storage layout

A database named `<name>` lives in two places:

```
IndexedDB  "opfs-lsm-wal/<name>"
  ├── wal    seq -> { ops, at }        one record per acked batch
  └── meta   "head"            -> seq  last committed batch
             "ingestedThrough" -> seq  every seq <= this is in an SST
             "generation"      -> n    the manifest tabs should read

OPFS  opfs-lsm/<name>/
  ├── m/<generation, 16 digits>.mft    manifests, newest wins
  ├── l0/<firstSeq>-<lastSeq>.sst      flushed runs, may overlap
  ├── l1/c<gen>.<i>-<bytes>.sst        compacted runs, disjoint within a level
  ├── l2/...
  └── ...
```

A **run** is one SST file. A **generation** is one numbered manifest that lists the live runs. A
**seq** is the position of a batch in the log. Seqs start at 1 and have no gaps.

Run paths are immutable. A path is written once and never rewritten with different contents.
This lets every tab cache a parsed run by its path, with no invalidation.

The size in a compacted run's name lets the compaction planner size levels without opening any
file. L0 names carry the seq range instead.

# Write-ahead log

The WAL is the IndexedDB database `opfs-lsm-wal/<name>`, schema version 6
(`packages/kv/src/idb/wal.ts`).

## WAL records

Each acked `put`, `delete`, `batch`, `transaction` or `update` appends exactly one record to
the `wal` store. The record's key is its seq. Its value is:

```
{
  ops: [ { type: "put", key: ArrayBuffer, value: ArrayBuffer }
       | { type: "del", key: ArrayBuffer } ],
  at:  number          // Date.now() at append, for debugging
}
```

The engine copies each key and value into its own `ArrayBuffer` before the write. The browser's
structured clone stores them as they are.

## Append

An append is one `readwrite` transaction over `wal` and `meta`:

1. Read `head`, `generation` and `ingestedThrough`, plus every record above the tab's
   `appliedThrough`.
2. Apply those records to the tab's memtable, so the tab is caught up before it decides.
3. Run the caller's plan synchronously. A transaction's conflict check runs here.
4. `add` the batch at `head + 1` and `put` the new `head`.

IndexedDB serializes `readwrite` transactions on the same stores. So no other tab can append
between step 1 and step 4, and seqs stay gap-free without any other coordination.

The ack is the transaction's `complete` event. The write is durable from that point, at the
durability IndexedDB gives the transaction. The engine uses the browser's default durability. In
Chrome, that measured the same as `relaxed`, so a commit survives a tab crash but maybe not a
power loss.

## Truncation

After an ingest, the host deletes every record at or below the new `ingestedThrough` and sets
`ingestedThrough` and `generation`, all in one transaction. So the WAL holds only seqs that are
not yet in an SST.

# Memtable

Each tab holds a memtable (`packages/kv/src/store/memtable.ts`). It holds the WAL records above
the installed generation's `ingestedThrough`, up to `appliedThrough`, folded to one row per key:

```
MemRow = { key, seq, kind: "put" | "del", value? }
```

Rows are kept in key order, in chunks of 512 to 1024 rows. An insert moves at most one chunk. A
chunk splits in two when it passes 1024 rows.

Records apply in seq order with no gaps. A record that skips a seq is refused, and the tab
re-reads the WAL tail. This is the invariant every read depends on. The memtable is always one
exact prefix of the log.

A `view` pins the memtable without copying it. The pin takes a copy of the array of chunk
references and marks every chunk as shared. The live table copies a shared chunk before its
next write to it. That makes a pin cost about 0.25 µs at 130k rows, and each later write that
lands in a shared chunk pays for one chunk copy.

When the installed generation moves past some seqs (`advanceTo`), the memtable drops the rows
those seqs wrote and rebuilds its chunks. If nothing new was ingested, it returns without
scanning.

# SST file format

Runs use SST version 4. The wasm module writes it (`crates/engine-core/src/sst.rs`). The
TypeScript reader in `packages/kv/src/store/sst.ts` reads it, and there is a byte-compatible
TypeScript encoder for when wasm doesn't load.

```
<------------------------------------------- 4 bytes ------------------------------------------->
============================================ Header ==============================================
| magic "OLST" (0x4f4c5354)                                                                      |
| version = 4                                                                                    |
| entry count                                                                                    |
| block count                                                                                    |
| data length                                                                                    |
| bloom hash count                                                                               |
| bloom byte length                                                                              |
============================================= Bloom ==============================================
| bloom bits (bloom byte length bytes)                                                           |
========================================== Data blocks ===========================================
| block 0: u32 record count, then records                                                        |
| block 1 ...                                                                                    |
========================================== Block index ===========================================
| per block: u32 first key length | first key | u32 last key length | last key                   |
|            u32 block offset (from the start of the data section) | u32 block length            |
============================================ Footer ==============================================
| crc32 (IEEE) of every byte before it                                                           |
==================================================================================================
```

A record is:

```
u8  tag          1 = put, 2 = delete
u64 seq          the WAL seq that wrote it
u32 key length,   key bytes
u32 value length, value bytes      (puts only)
```

Entries are sorted by key, with one entry per key. Blocks are cut at about 4 KiB of records. The
bloom filter uses 10 bits per key and 7 hashes, which gives about a 1% false-positive rate. Its
hashes are FNV-1a and a 32-bit mix of it, combined by double hashing.

Versions 1 to 3 still decode. Version 1 is a single block with no bloom filter. Version 2 added
blocks and the bloom filter. Version 3 added the per-record seq. Version 4 widened the bloom
header fields to u32, so a filter can pass 64 KiB.

## Reading a run

A tab reads a whole run file into memory once, and keeps it for as long as the run stays in its
installed generation. `SstReader` parses only the header, the bloom filter and the block index.
A point get:

1. Rejects the key if it falls outside the run's first and last keys.
2. Rejects it if the bloom filter says no.
3. Binary-searches the block index, decodes that one block and searches it.

Tabs don't check the CRC when they read. That check runs in the SharedWorker, which decodes
every input run in full before compacting it. Skipping it on the main thread cut tab open time
from 354 ms to 76 ms with a 100k-key database.

# Manifest format

A manifest (`m/<generation>.mft`, `packages/kv/src/store/generation.ts`) lists the live runs of
one generation:

```
u32 magic "OLGN" (0x4f4c474e)
u32 version = 3
u64 generation
u64 tombstoneSeq
u32 run count
per run:
  u16 path length, path (UTF-8, relative to the database root)
  u8  has range
  if has range: u32 length, smallest key, u32 length, largest key
u32 crc32 of every byte before it
```

Runs are listed with L0 first, newest first. Every deeper level follows in order, with its runs
sorted by smallest key. Reads use that order directly, so the first hit wins.

`tombstoneSeq` is the highest seq of any delete that a bottom-level compaction dropped. A key
that has no entry at all may have been deleted at any seq up to it. Transactions use it for
conflict checks (see **Transactions**).

The generation the tabs should read is the one recorded in IndexedDB `meta.generation`, not
the newest file in `m/`. A manifest becomes visible only once IndexedDB records it.

# Reads

`get` reads the memtable first. On a miss, it walks the installed runs in manifest order
(`pointGetSst` in `store/merge.ts`). It doesn't touch IndexedDB, and it doesn't wait on the
SharedWorker.

`range` merges a cursor over the memtable with one cursor per scan source, using a min-heap
ordered by key and then by source, newest first. For each key the newest source wins, and
tombstones are dropped. Each L0 run is its own source, because L0 runs overlap. Each deeper
level is one source (`RunLevel` in `store/merge.ts`): its runs never overlap, so the level
cursor binary-searches the runs' largest keys for the start key and opens one run at a time,
in key order, stopping at the first run that starts at or past the end key. A run cursor decodes
its first block as soon as it opens, so a scan only pays for the runs it reaches.

The bloom filters play no part in a scan. They answer whether one exact key is present.

A `view` pins `appliedThrough`, the installed generation, the memtable chunks and the run
readers. Writes that commit during the callback are invisible to it.

# Multi-tab coordination

## Seeing other tabs' writes

After its own append commits, a tab posts `{ kind: "append", seq, ops }` on the BroadcastChannel
`opfs-lsm-layers/<name>`. Every other tab applies the record to its memtable when the message
arrives. If the record doesn't follow that tab's `appliedThrough`, the tab reads the WAL tail
instead.

So a tab sees another tab's write a moment after that write's ack, not at it. `db.sync()` closes
that gap. It reads the WAL tail in one transaction and applies everything acked before the call.
Every append already catches the tab up inside its own transaction, so a transaction's conflict
check always runs against the latest state.

## Installing a generation

A tab installs a generation only when the IndexedDB tail tells it to, during `sync` or an
append. `catchUp` keeps one rule: the installed generation never holds a seq past
`appliedThrough`. If the tail names a generation the tab hasn't loaded, the tab loads its
manifest and runs outside the transaction, then tries again, up to 8 times. A run file can
disappear between the manifest read and the run read, when a newer compaction reclaims it. A
retry picks up the newer generation.

After a flush or a compaction step, the host posts `{ kind: "ingest" }` on the same channel.
Tabs respond by calling `sync`.

# Ingest

Ingest moves WAL records into an L0 run. It runs in the SharedWorker's `EngineHost`
(`packages/kv/src/host/engine-host.ts`, `host/ingest.ts`).

## When it runs

Every tab applies every record. So every tab sees the same record push the memtable past a
limit, and each one asks the host to flush through that seq. The limits are in
`ingest-policy.ts`:
- `maxBytes` defaults to 4 MiB of key and value bytes.
- `maxBatches` defaults to 10,000 records.

A request for seqs that are already ingested does nothing. So however many tabs ask for the
same flush, it runs once. A later multiple of a limit retries a flush that failed.

## Steps

Under the exclusive section for the database:

1. Read every WAL record above `ingestedThrough`.
2. Fold them to the last op per key, in key order, keeping each op's seq.
3. Write `l0/<first>-<last>.sst`.
4. Write manifest `N + 1`, listing the new run in front of the runs of manifest `N`.
5. In one IndexedDB transaction, delete the records through `<last>`, set
   `ingestedThrough = <last>` and raise `generation` to `N + 1`.
6. Delete the manifests older than the recorded generation.

The exclusive section is a promise chain inside the host plus a Web Lock named
`opfs-lsm-ingest/<name>`. The lock covers the case of two SharedWorkers serving the same
database, for example two builds with different script URLs.

OPFS writes go through `createWritable` and `close`. The browser swaps the new file into place
on `close`, so other readers see a file whole or not at all.

# Compaction

Compaction keeps a leveled layout (`packages/kv/src/store/levels.ts`, `host/compact.ts`).

| Level | Runs | Budget |
|---|---|---|
| L0 | Overlap each other, newest first | Compacts at 4 runs |
| L1 | Disjoint, sorted by key | 40 MiB |
| Ln | Disjoint, sorted by key | 40 MiB × 10^(n−1) |

Levels are created as they fill. There is no maximum depth.

## Planning

`planCompaction` reads only the manifest. It picks the first rule that applies:
1. When L0 has 4 runs or more, merge every L0 run with the L1 runs whose ranges overlap.
2. Otherwise, take the first level from L1 down that is over budget. Pick the run whose
   overlapping bytes in the next level are the smallest fraction of its own size. Merge it with
   those runs into the next level.

A plan is marked `bottom` when no run below the output level overlaps the inputs. Only then may
the merge drop tombstones, because no older value is left for them to hide.

## Merging

The merge runs in wasm (`crates/engine-core/src/compact.rs`). It decodes every input and checks
each CRC. It folds the inputs into a `BTreeMap`, with newer runs winning, and drops tombstones if
the plan is `bottom`. Then it cuts the output into runs of `TARGET_RUN_BYTES`, 4 MiB of records.
A run closes on the first entry that takes it to 4 MiB or more. So full runs are a little over
4 MiB on disk once the bloom filter and block index are added, and the last run of a merge holds
whatever is left over.

All the inputs are in memory at once. The fixed run size is what bounds one step to about
11 runs at a level ratio of 10.

## Installing

The merge itself runs without the ingest lock. It holds only `opfs-lsm-compact/<name>`, so
flushes keep going while it runs. A flush meanwhile only adds L0 runs in front of the inputs, so
the plan stays valid. To install, under the exclusive section, the host:

1. Checks that every input is still in the latest manifest.
2. Writes manifest `N + 1`, with the inputs replaced by the outputs and `tombstoneSeq` raised
   to the highest dropped tombstone.
3. Raises IndexedDB `generation` to `N + 1`.
4. Deletes the input runs that the new manifest doesn't list.

A pass runs up to 8 steps, and a request that arrives during a pass starts another one.

# Transactions

`db.transaction` is optimistic (`packages/kv/src/transaction.ts`). The snapshot is the tab's
`appliedThrough` at the start. Reads see the latest acked value, and writes are buffered. At
commit, inside the append's IndexedDB transaction and after the catch-up, the tab checks every
key the transaction read or wrote. If any of those keys was last written at a seq above the
snapshot, the commit throws `ConflictError`. The last-write seq of a key comes from the
memtable, then the runs. A key with no entry at all reports `tombstoneSeq`.

`db.update(keys, body)` reads and writes inside one IndexedDB transaction, so it can't conflict.
`body` must be synchronous.

# Limits

From `packages/kv/src/check.ts`:

| Limit | Value |
|---|---|
| Key | 8 KiB |
| Value | 16 MiB |
| Ops per batch | 10,000 |
| Bytes per batch | 8 MiB |
| Database name | `[A-Za-z0-9_-]{1,64}` |

# Where code runs

| Work | Thread | Language |
|---|---|---|
| Append, memtable, point get, range merge, SST reader, bloom checks | Each tab's main thread | TypeScript |
| Fold WAL into L0, encode SSTs | SharedWorker | TypeScript fold, wasm encode |
| Compaction merge and split | SharedWorker | wasm |
| CRC-32 check on decode | SharedWorker | wasm (slicing-by-8, 4 streams) |

The tab reads with TypeScript so a `get` never crosses into wasm or posts a message. The bulk
byte work, meaning encode, decode and merge, runs in wasm off the main thread. If the wasm module
fails to load, TypeScript fallbacks for all of them run instead.

# Crash behavior

Each step writes new files before it points anything at them, and deletes files only after
nothing points at them:

| Crash after | State on reopen |
|---|---|
| Append, before `complete` | The batch isn't in the WAL. The caller never got an ack. |
| L0 run written, before its manifest | The run is in no manifest and is garbage. The records are still in the WAL. |
| Manifest written, before the IndexedDB update | `generation` still names the old manifest, so tabs ignore the new one, and the records are still in the WAL. The next ingest builds on the newest manifest file, so the orphaned L0 stays listed under a new L0 that holds the same rows at the same seqs. If no record arrived in between, both runs have the same path and the manifest lists it twice. Reads stay correct either way. |
| IndexedDB updated, before reclaim | Old manifests and input runs stay on disk until a later ingest or compaction removes them. |
| Compaction outputs written, before install | The outputs are in no manifest. They are garbage. |

Files that no manifest lists are never deleted on startup today. They only take up space.

# Assumptions about the platform

- IndexedDB serializes `readwrite` transactions that share a store, across tabs and workers.
  Seq assignment depends on this.
- An OPFS `createWritable().close()` publishes the whole file atomically, and never shows a
  partial file to readers.
- A SharedWorker with the same URL and name is shared by every tab of the origin. If two
  different URLs serve one database, the Web Locks keep them from writing manifests at the same
  time.
- BroadcastChannel delivers messages in order from one sender, but may deliver them late. The
  engine tolerates lost or late messages, because the WAL tail is always the source of truth.

# Known limits of this design

- Each tab keeps every live run file in memory. Tab memory grows with the size of the database.
- The leftover run of a merge can be tiny, and the planner rarely picks a tiny run on its own,
  so small runs can stay around.
- A tab sees another tab's writes over BroadcastChannel, so its reads can lag the ack by a
  message hop until it calls `sync`.
