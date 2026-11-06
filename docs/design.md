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
  ├── wal    seq -> bytes              one record per acked batch
  └── meta   "head"            -> seq  last committed batch
             "ingestedThrough" -> seq  every seq <= this is in an SST
             "pendingBytes"    -> n    op bytes of the records above ingestedThrough
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

The WAL is the IndexedDB database `opfs-lsm-wal/<name>`, schema version 1
(`packages/kv/src/idb/wal.ts`).

## WAL records

Each acked `put`, `delete`, `batch`, or `update` appends exactly one record to
the `wal` store. The record's key is its seq. Its value is one `ArrayBuffer` holding the
batch's ops back to back, little-endian:

```
per op:  u8 type (0 put, 1 del) | u32 keyLen | key | put only: u32 valueLen | value
```

Reading a WAL row costs per row and per JS object IndexedDB deserializes. One buffer per row is
the fewest objects a row can be. The decoder hands out keys and values as views into the row's
buffer. A row holds one batch, so the views keep nothing else alive. Nothing decoded from the
WAL is sent with `postMessage`, where a view would clone its whole buffer. A row that is not an
`ArrayBuffer`, or ends inside an op, throws `corrupt wal row`.

## Append

`put`, `delete`, and `batch` append without reading the tail. One `readwrite` transaction over
`wal` and `meta`:

1. Read `head`.
2. `add` the encoded ops with no key. The store's key generator assigns the seq.
3. If that key is not past `head`, abort. The caller then appends with `appendAfter`, which
   writes an explicit key and moves the generator forward.
4. Otherwise `put` the new `head`, and `put` `pendingBytes` raised by the op bytes of the batch.

IndexedDB serializes `readwrite` transactions on the same stores, so two tabs cannot take the
same key. Aborting a transaction reverts the key generator, so an append that aborts does not
consume a seq. Committed seqs stay gapless.

The record joins this tab's memtable after `complete`, and the ack resolves only after that.
If the seq is not the next one, another tab appended first: the tab reads the WAL tail, applies
every record through its own, and then resolves. At the ack, the writer sees its own write and
every earlier one.

`update` still uses `appendAfter`. That transaction reads the tail, applies it to the memtable,
runs the synchronous body, and `add`s the batch at `head + 1`. The read and the write stay in
one transaction.

The ack is the transaction's `complete` event. The write is durable from that point, at the
durability IndexedDB gives the transaction. The engine uses the browser's default durability. In
Chrome, that measured the same as `relaxed`, so a commit survives a tab crash but maybe not a
power loss.

## Truncation

After an ingest, the host deletes every record at or below the new `ingestedThrough`, sets
`ingestedThrough` and `generation`, and lowers `pendingBytes` by the bytes it folded, all in one
transaction. So the WAL holds only seqs that are not yet in an SST.

## Reading the tail

`openDb`, `sync`, a catch-up after an append, and ingest all read the same way: one transaction
reads `head` and `ingestedThrough` from `meta`, then every record in `(max(since,
ingestedThrough), head]`. `since` is the caller's `appliedThrough`, 0 on open, so every open
replays the whole uningested WAL into a new memtable on the tab's main thread. `maxWalBytes`
bounds that replay (see [When it runs](#when-it-runs)).

The read issues one `getAll` per 25,000 seqs, all in flight in the same transaction. Seqs are
gapless above `ingestedThrough`, so a value's position in its range gives its seq and no
`getAllKeys` pass is needed. A range that returns fewer values than it spans has a gap, and the
read throws `wal gap` rather than shift the seqs after it.

`getAllRecords` returns keys and values in one request, but Chrome deserializes each value when
`.value` is first read. The time it saves comes back in decode, so the engine does not use it.
On the yjs bench (250k rows) the ranged `getAll` read takes about 360 to 520 ms with object
rows. The old `getAllKeys` plus `getAll` pair took about 670 ms, and byte rows cut the open by
another third. The measurements are in `docs/research/kv-wal-optimization.md`.

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

Runs use SST version 1. The wasm module writes it (`crates/engine-core/src/sst.rs`). The
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

A block holds the records for a run of keys, at most 4 KiB of them.

```
| u32 record count                                                           |
| varint prefix length                                                       |
| prefix          prefix length bytes                                        |
| record 0                                                                   |
| ...                                                                        |
| record count - 1                                                           |
| u16 offset of record 4                              from the block start   |
| u16 offset of record 8                                                     |
| ...             one per 4th record after record 0, (count - 1) / 4 of them |
```

The prefix is the longest one that every key in the block shares. Keys are sorted, so it is the
common prefix of the first and last key. A block with one key stores the whole key as its prefix.
A key is the prefix followed by its record's suffix.

The offset table lets a reader binary-search a block. Every record holds a whole suffix against
the one block prefix, so a reader can compare any record from its offset alone. A reader finds
the table from the record count and the block's length. Offsets are u16 because a block of two
or more records is at most 4 KiB. A block of one record can be larger, and it has no table.
The stride of 4 came from a sweep over 1, 4, 8, 16 and 32 with
`pnpm --filter @opfs-lsm/collections bench:index-runs`. It was the largest stride whose LZ4 gets
on UUID ids matched a run that stored every key in full. Stride 8 saves 1.4% of the index bytes and made those gets about
5% slower.

The shared prefix is for collections' index keys. Each one starts with `i/`, the table and the
index name, so neighbours repeat about 20 bytes. One prefix per block keeps nearly all of that
saving. LevelDB-style restart points every 16 keys saved less on the same data, because the
part that repeats is the same for the whole block.

Varints are unsigned LEB128 and at most 5 bytes.

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
| varint suffix length                                                       |
| suffix          the key after the block's prefix                           |
| varint value length                                 (puts only)            |
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
| version = 1                                                                   |  end - 8
| magic "OLST" (0x4f4c5354)                                                     |  end - 4
```

Entries are sorted by key, with one entry per key. A block ends before the record that would
take its encoded size, offset table included, past 4 KiB. Adding a key can shorten the prefix,
which lengthens every suffix, so the writer recomputes the size from running sums of key lengths
and other record bytes. It sizes each suffix length varint from the whole key, so the Rust and TypeScript
encoders cut blocks in the same places. The bloom filter uses 10 bits per key and 7 hashes, which gives about a 1% false-positive rate. Its
hashes are FNV-1a and a 32-bit mix of it, combined by double hashing.

A reader requires the last 8 bytes to be version 1 and the magic. Any other version is rejected.

## Compression

Runs in L2 and deeper use LZ4. L0 and L1 runs stay raw. `codecForLevel` in `levels.ts` makes
the choice. L0 and L1 hold the recent writes, and an LZ4 block costs a decompress on every read
of it. L2 and below hold nearly all of the data, so they are where the bytes are. Encode cost
is not the reason. A 4.3 MB flush run encodes in 51.7 ms raw and 52.7 ms with LZ4.

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

Measured with `pnpm --filter @opfs-lsm/kv bench:range` (todo-shaped layout in memory, Node) against raw L2 runs:

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
4. Checks the block's prefix against the key once. Then it binary-searches the offset table,
   comparing suffixes in place, and walks at most 4 records from the last one not past the key.
   It copies out only the record that matches.

A get used to decode the whole block into objects and then search them. Walking it in place
cut a get that hits L2 from 7.7 µs to 4.0 µs, measured with `pnpm --filter @opfs-lsm/kv bench:follow` at 100k todos.

Tabs don't check the CRC when they read. That check runs in the SharedWorker, which decodes
every input run in full before compacting it. Skipping it on the main thread cut tab open time
from 354 ms to 76 ms with a 100k-key database.

# Manifest format

A manifest (`m/<generation>.mft`, `packages/kv/src/store/generation.ts`) lists the live runs of
one generation:

```
u32 magic "OLGN" (0x4f4c474e)
u32 version = 1
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
that has no entry at all may have been deleted at any seq up to it.

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
in key order, stopping at the first run that starts at or past the end key. A run cursor reads
its first block as soon as it is created, so a scan only pays for the runs it reaches. It seeks to the
start key with the block's offset table, then walks records in place and copies out each one
when it reaches it.

The bloom filters play no part in a scan. They answer whether one exact key is present.

A `view` pins `appliedThrough`, the installed generation, the memtable chunks and the
levels. Writes that commit during the callback are invisible to it.

`view.scanRuns(range, filter)` is a read for callers that only filter. It returns one key-ordered
scan of live puts per source (the memtable, each L0 run, each deeper level), and does not merge
them. A key can appear in several scans, and an older scan can hold a value that a newer source
overwrote or deleted, so the caller confirms a hit with `get` on the same view. In exchange, it
skips the merge heap. With a `filter` of `valueContains` byte strings, a run keeps only the puts
whose value holds all of them. With wasm loaded, each block is matched there
(`scan_block_contains_js`, `store/block-scan.ts`), and only the hits cross back. An LZ4 block is
unpacked in that call; a raw block is read in place. Without wasm, the run's cursor does the same
work key by key.

`db.rangeFollow(range, follow)` scans a range and point-reads the key that `follow` returns for
each entry. Every read sees the same state, because the scan and the reads run in one task with no
await between them.

# Multi-tab coordination

## Seeing other tabs' writes

After its own append commits, a tab posts `{ kind: "append", seq, ops }` on the BroadcastChannel
`opfs-lsm-layers/<name>`. Every other tab applies the record to its memtable when the message
arrives. If the record doesn't follow that tab's `appliedThrough`, the tab reads the WAL tail
instead. The ingest host listens on the same channel and counts those op bytes.

So a tab sees another tab's write a moment after that write's ack, not at it. `db.sync()` closes
that gap. It reads the WAL tail in one transaction and applies everything acked before the call.
A blind append does that catch-up after its own commit, before its ack, when its seq is not the
next one. `update` catches up inside its transaction, before the body runs. If `close()` runs
after the commit and before the broadcast, the put still resolves: the channel is already closed,
other tabs catch up on `sync`, and the host measures the WAL again on the next open.

## Installing a generation

A tab installs a generation only when the IndexedDB tail tells it to, during `sync` or an
append. `catchUp` keeps one rule: the installed generation never holds a seq past
`appliedThrough`. If the tail names a generation the tab hasn't loaded, the tab loads its
manifest and runs outside the transaction, then tries again, up to 8 times. A run file can
disappear between the manifest read and the run read, when a newer compaction reclaims it. A
retry picks up the newer generation.

After a flush that it started itself or a compaction step, the host posts `{ kind: "ingest" }`
on the same channel. After `db.ingest()`, the calling tab posts it if the generation moved. Tabs
respond by calling `sync`.

# Ingest

Ingest moves WAL records into an L0 run. It runs in the SharedWorker's `EngineHost`
(`packages/kv/src/host/engine-host.ts`, `host/ingest.ts`).

## When it runs

The ingest host owns the trigger. Per database it keeps an `IngestWatch`:

- `maxWalBytes`, the smallest limit any open tab asked for
- `pendingBytes`, op bytes heard on the broadcast or read from the WAL's `pendingBytes`
  counter, and not yet folded
- `triggerAt`, the `pendingBytes` level that starts an ingest
- `state`, `idle` or `ingesting`
- `watchers`, how many tabs hold the watch

`openDb` sends `watch` with the tab's `IngestPolicy`. The call resolves once the host is
listening. The host then reads the WAL's `pendingBytes` counter in the background and
ingests if it is at the limit, so a database left over the limit by a closed or busy tab
catches up on open. A database with no counter yet is scanned once and the result stored. `close` sends `unwatch`. At zero watchers the host closes its
channel and drops the watch. Until then it keeps the smallest limit it has seen.

Each append broadcast adds the key and value bytes of its ops to `pendingBytes`. When
`pendingBytes` reaches `triggerAt` and the watch is idle, the host folds every uningested
record. One ingest runs at a time. When it finishes, the host subtracts the folded bytes and
checks again. The default limit is 1 MiB (`maxWalBytes` in `ingest-policy.ts`). Every
open replays the WAL up to the limit, so the limit is an open-time budget.

The count is the bytes of the ops as written. Overwrites and deletes grow it the same way new
keys do, so the WAL that every open replays stays near the limit whatever the batch shape.
IndexedDB stays the source of truth. The count only decides when to ingest, and every ingest
reads the WAL. A missed broadcast, or an `unwatch` that arrives before a tab's last append,
delays the fold until the next crossing or the next open, which reads the counter again. A fold that
finds nothing waiting sets `pendingBytes` back to 0, so a count that ran ahead of the WAL does
not ingest in a loop.

A failed ingest is logged. `triggerAt` becomes `pendingBytes + maxWalBytes`, so the retry waits
for another limit of writes. The next `watch` sets `triggerAt` back to the limit and reads
the counter, so opening the database retries at once.

`db.ingest()` asks the host to fold through the end of the log and waits for the
compaction that starts. A request for seqs that are already ingested writes nothing.

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
each CRC. It merges the decoded inputs with a min-heap on key and then on run, so the newest run wins
each key and a later entry for a key in one run wins over an earlier one. It drops tombstones
if the plan is `bottom`. Then it cuts the output into runs of `TARGET_RUN_BYTES`, 4 MiB of records
counted as tag, seq, and u32 key and value lengths: the key and value plus 17 bytes. A run closes on the
first entry that takes it to 4 MiB or more. On-disk records use varints and a shared prefix, so
a full raw run is under 4 MiB on disk when its blocks share long prefixes, as index keys do. LZ4
runs are smaller again. The last run of a merge holds whatever is left over.

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

# Updates

`db.update(keys, body)` reads and writes inside one IndexedDB transaction, so it can't conflict.
`body` must be synchronous.

`db.changes(listener)` reports every append and every ingest, from this tab and from other tabs.
It is fed by the same BroadcastChannel and by the tab's own commits (`changes.ts`).

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
| Unpack an LZ4 block, match a filtered scan inside a block | Each tab's main thread | wasm, with TypeScript fallbacks |
| Fold WAL into L0, encode SSTs | SharedWorker | TypeScript fold, wasm encode |
| Compaction merge and split | SharedWorker | wasm |
| CRC-32 check on decode | SharedWorker | wasm (slicing-by-8, 4 streams) |

The tab reads with TypeScript so a `get` never posts a message. A get that lands in an LZ4 block
calls wasm to unpack that one block. The bulk byte work, meaning encode, decode and merge, runs in
wasm off the main thread. If the wasm module fails to load, TypeScript fallbacks for all of them
run instead, except that encode then writes raw blocks only.

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
  Seq assignment depends on this. Aborting a transaction reverts the WAL store's key generator,
  which keeps a blind append gapless when it aborts.
- An OPFS `createWritable().close()` publishes the whole file atomically, and never shows a
  partial file to readers.
- A SharedWorker with the same URL and name is shared by every tab of the origin. `openDb` names
  it `opfs-lsm:<name>`, so each database gets its own. If two different URLs serve one database,
  the Web Locks keep them from writing manifests at the same time.
- BroadcastChannel delivers messages in order from one sender, but may deliver them late. The
  engine tolerates lost or late messages, because the WAL tail is always the source of truth.

# Known limits of this design

- Each tab keeps every live run file in memory. Tab memory grows with the size of the database.
- The leftover run of a merge can be tiny, and the planner rarely picks a tiny run on its own,
  so small runs can stay around.
- A tab sees another tab's writes over BroadcastChannel, so its reads can lag the ack by a
  message hop until it calls `sync`.
