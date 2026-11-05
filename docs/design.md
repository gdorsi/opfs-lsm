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

Runs use SST version 6. The wasm module writes it (`crates/engine-core/src/sst.rs`). The
TypeScript reader in `packages/kv/src/store/sst.ts` reads it, and there is a byte-compatible
TypeScript encoder for when wasm doesn't load. That encoder writes only raw blocks.

The layout follows the LevelDB and RocksDB convention. Data blocks come first, the bloom filter
and block index follow them, and a fixed-size footer at the end of the file says where each
section is. A writer can produce the sections in that order without knowing the key count up
front, and a reader can find the footer as the last 44 bytes of any file.

A run is four sections, back to back. N is the block count.

```
================================== SST file ==================================
| data block 0                                                               |
| data block 1                                                               |
| ...                                                                        |
| data block N-1                                                             |
------------------------------------------------------------------------------
| bloom bits                                                                 |
------------------------------------------------------------------------------
| index entry 0          (describes data block 0)                            |
| ...                                                                        |
| index entry N-1        (describes data block N-1)                          |
------------------------------------------------------------------------------
| footer                 (44 bytes)                                          |
==============================================================================
```

The data, bloom and index sections vary in size. The footer records where each one starts and
how long it is. A reader rejects the file unless the sections are contiguous, meaning the bloom
filter ends where the index starts and the index ends where the footer starts.

### Data block

A block holds the records for a run of keys, about 4 KiB of them.

```
| u32 record count                                                           |
| record 0                                                                   |
| ...                                                                        |
| record count - 1                                                           |
```

The footer's codec says how every block in the file is stored. With codec 0 (raw) a block is
stored as above. With codec 1 (LZ4) it is stored packed:

```
| u32 unpacked length                                                        |
| LZ4 block-format bytes of the block above                                  |
```

Index offsets and lengths, the bloom offset and the CRC all refer to the stored bytes.

### Record

```
| u8 tag          1 = put, 2 = delete                                        |
| u64 seq         the WAL seq that wrote the key                             |
| u32 key length                                                             |
| key             key length bytes                                           |
| u32 value length                                    (puts only)            |
| value           value length bytes                  (puts only)            |
```

### Index entry

There is one index entry per data block, in the same order as the blocks.

```
| u32 first key length                                                       |
| first key       the block's smallest key                                   |
| u32 last key length                                                        |
| last key        the block's largest key                                    |
| u32 block offset                                    from the start of file |
| u32 block length                                                           |
```

### Footer (44 bytes)

Every footer field is a u32, so each one sits at a fixed position from the end of the file.

```
<----------------------------------- 4 bytes ----------------------------------->
| entry count                                                                   |  end - 44
| block count                                                                   |  end - 40
| bloom offset    also the length of the data section                           |  end - 36
| bloom length                                                                  |  end - 32
| bloom hash count                                                              |  end - 28
| index offset                                                                  |  end - 24
| index length                                                                  |  end - 20
| codec           0 = raw, 1 = LZ4                                              |  end - 16
| crc32 (IEEE) of every byte before this field                                  |  end - 12
| version = 6                                                                   |  end - 8
| magic "OLST" (0x4f4c5354)                                                     |  end - 4
```

Entries are sorted by key, with one entry per key. Blocks are cut at about 4 KiB of records. The
bloom filter uses 10 bits per key and 7 hashes, which gives about a 1% false-positive rate. Its
hashes are FNV-1a and a 32-bit mix of it, combined by double hashing.

Versions 1 to 5 still decode. Version 5 is version 6 without the codec field, so its footer is
40 bytes and its blocks are raw. Versions 1 to 4 keep the magic and version in the first 8 bytes
and a header before the data, and they end with a bare CRC:
- Version 1 is a single block with no bloom filter.
- Version 2 added blocks, the bloom filter and the block index.
- Version 3 added the per-record seq.
- Version 4 widened the bloom header fields to u32, so a filter can pass 64 KiB.
- Version 5 moved the bloom filter and index behind the data and the metadata into the footer.
- Version 6 added the codec field.

A reader checks the last 8 bytes first. In a version 2 to 4 file, those bytes are the last
block's length and the CRC. A block length is 4 or at least 9, never 5 or 6, so these files
can't be mistaken for version 5 or 6. A version 1 file ends with record bytes and the CRC, so it
would be misread only if its CRC happened to equal the magic, a 1 in 2^32 chance.

## Compression

Runs in L2 and deeper use LZ4. L0 and L1 runs stay raw. `codecForLevel` in `levels.ts` makes
the choice, and only compaction writes L2 runs, so flushes never pay to compress. L2 and below
hold nearly all of the data, so they are where the bytes are.

The reason is memory. Every tab holds every run's bytes, and blocks stay packed in memory until a
read reaches them. LZ4 decodes fast enough that a get barely notices. It also adds the least
code to the wasm module of the pure-Rust codecs we tried. On todo-shaped data, a 4 KiB block:

| Codec | Ratio | Decode | Added to wasm, gzipped |
|---|---|---|---|
| LZ4 (`lz4_flex`) | 3.25x | 0.8 µs | 5 KB |
| Snappy (`snap`) | 3.49x | 1.4 µs | 6 KB |
| Deflate (`miniz_oxide`) | 4.84x | 8 µs | 18 KB |
| Zstd (`ruzstd`) | 3.62x | 8 µs | 58 KB |

Reads decode LZ4 blocks in wasm once the module loads. `openDb` starts loading it without
waiting. Before it loads, and wherever wasm doesn't load, a TypeScript decoder in `lz4.ts` does
the work about 3x slower.

Measured with `pnpm bench:range` (todo-shaped layout in memory, Node) against raw L2 runs:

| | 100k todos, raw | 100k todos, LZ4 | 1M todos, raw | 1M todos, LZ4 |
|---|---|---|---|---|
| Run bytes per tab | 27.6 MiB | 10.1 MiB | 275.7 MiB | 99.5 MiB |
| `openDb` | 6.9 ms | 4.7 ms | 290 ms | 87 ms |
| Get that hits L2, p50 | 5.9 µs | 7.4 µs | 6.5 µs | 7.9 µs |
| Page of 256 todos, p50 | 113 µs | 125 µs | 111 µs | 135 µs |

Gets that miss cost the same, because the bloom filter rejects them before any block is read.


## Reading a run

A tab reads a whole run file into memory once, and keeps it for as long as the run stays in its
installed generation. `SstReader` parses only the footer, the bloom filter and the block index.
A point get:

1. Rejects the key if it falls outside the run's first and last keys.
2. Rejects it if the bloom filter says no.
3. Binary-searches the block index for the one block that could hold the key, unpacking it
   first if the run uses LZ4.
4. Walks that block's records, comparing each key in place, and copies out only the record
   that matches. It stops at the first key past the one it wants.

A get used to decode the whole block into objects and then search them. Walking it in place
cut a get that hits L2 from 7.7 µs to 4.0 µs, measured with `pnpm bench:follow` at 100k todos.

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

`get` reads the memtable first. On a miss, it asks the installed levels newest first
(`pointGetSst` in `store/merge.ts`) and stops at the first one that holds the key. Each L0 run
is a level of its own. A deeper level binary-searches its runs' key ranges and asks only the one
run whose range holds the key, so a get costs one probe per level, not one per run. It doesn't
touch IndexedDB, and it doesn't wait on the SharedWorker.

`range` merges a cursor over the memtable with one cursor per scan source, using a min-heap
ordered by key and then by source, newest first. For each key the newest source wins, and
tombstones are dropped. Each L0 run is its own source, because L0 runs overlap. Each deeper
level is one source (`RunLevel` in `store/merge.ts`): its runs never overlap, so the level
cursor binary-searches the runs' largest keys for the start key and opens one run at a time,
in key order, stopping at the first run that starts at or past the end key. A run cursor decodes
its first block as soon as it opens, so a scan only pays for the runs it reaches.

The bloom filters play no part in a scan. They answer whether one exact key is present.

A `view` pins `appliedThrough`, the installed generation, the memtable chunks and the
levels. Writes that commit during the callback are invisible to it.

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

Levels are created as they fill. There is no maximum depth. Budgets count bytes on disk, which
are packed from L2 down, so an LZ4 level holds about 3x more records than its budget in raw
bytes.

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
A run closes on the first entry that takes it to 4 MiB or more. So full raw runs are a little
over 4 MiB on disk once the bloom filter and block index are added. LZ4 runs hold the same
4 MiB of records in fewer bytes. The last run of a merge holds whatever is left over.

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
