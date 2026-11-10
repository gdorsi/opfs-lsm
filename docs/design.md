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
             "topGeneration"   -> n    highest manifest number recovery has seen

OPFS  opfs-lsm/<name>/
  ├── m/<generation, 16 digits>.mft    manifests, newest wins
  ├── l0/<firstSeq>-<lastSeq>.sst      flushed runs, may overlap
  ├── l1/c<gen>.<i>.sst                compacted runs, disjoint within a level
  ├── l2/...
  └── ...
```

A **run** is one SST file. A **generation** is one numbered manifest that lists the live runs. A
**seq** is the position of a batch in the log. Seqs start at 1 and have no gaps, except where a
power loss lost them from both stores (see [Recovery](#recovery)). A seq is never handed out
twice, and a manifest number never names two different manifests.

Run paths are immutable. A path is written once and never rewritten with different contents.
This lets every tab cache a parsed run by its path, with no invalidation.

The manifest records each run's byte size and key range, so the compaction planner sizes levels
without opening any file. The level is in the path. L0 names carry the seq range, and a compacted
run's name carries the generation that wrote it and its position in that step's output.

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

After an ingest, the host sets `ingestedThrough` and `generation`, lowers `pendingBytes` by the
bytes it folded, and deletes every record at or below the *previous* `ingestedThrough`, all in
one transaction. So the WAL holds the seqs that are not yet in an SST, plus the seqs the last
ingest folded. Those stay until the next ingest: under a power loss this commit can survive
while the new run and manifest do not, and then recovery replays them over the previous
manifest (see [Recovery](#recovery)). They cost IndexedDB space, about one `maxWalBytes`, and
nothing else: no read touches a record at or below `ingestedThrough`.

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

Before the first read, `openDb` pairs the WAL with a manifest (see [Recovery](#recovery)).

`getAllRecords` returns keys and values in one request, but Chrome deserializes each value when
`.value` is first read. The time it saves comes back in decode, so the engine does not use it.
On a 250k-row Yjs benchmark (since removed) the ranged `getAll` read takes about 360 to 520 ms with object
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

`SstWriter` takes entries in key order and appends the file to a buffer the caller owns, one
data block at a time. Its `finish` appends the bloom filter, the index and the footer, and returns
the run's end: entry count, size, and first and last key. Both encoders report it, and it is what
the manifest records. Encoding a slice of entries is a loop over the same writer.

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
a benchmark script that has since been removed. It was the largest stride whose LZ4 gets
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
A reader also rejects a footer that names more than 32 bloom hashes, or more blocks than the index
has room for at 16 bytes each, before either sets a loop count or an allocation.

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

An LZ4 block unpacks to at most 255 bytes per compressed byte, so both decoders reject a block
whose u32 size claims more (plus 16) before they allocate for it. Reads decode LZ4 blocks in wasm once the module loads. `openDb` starts loading it without
waiting. Before it loads, and wherever wasm doesn't load, a TypeScript decoder in `lz4.ts` does
the work about 3x slower. A wasm trap (a panic, or an allocation wasm memory cannot grow to)
does not unwind, so after one the context drops wasm and uses the TypeScript codec.

Measured with a since-removed range benchmark (todo-shaped layout in memory, Node) against raw L2 runs:

| | 100k todos, raw | 100k todos, LZ4 | 1M todos, raw | 1M todos, LZ4 |
|---|---|---|---|---|
| Run bytes per tab | 27.6 MiB | 10.1 MiB | 275.7 MiB | 99.5 MiB |
| `openDb` | 6.9 ms | 4.7 ms | 290 ms | 87 ms |
| Get that hits L2, p50 | 5.9 µs | 7.4 µs | 6.5 µs | 7.9 µs |
| Page of 256 todos, p50 | 113 µs | 125 µs | 111 µs | 135 µs |

Gets that miss cost the same, because the bloom filter rejects them before any block is read.


## Reading a run

A tab holds each run of its installed generation open and reads it on demand
(`SstReader` in `store/sst-reader.ts`). Opening a run reads nothing. The first read loads the
footer, the bloom filter and the block index, and each later read loads the 32 KB page of whole
blocks it needs. All of it lives in one per-tab `PageCache` capped by `openDb({ memoryBudget })`
(256 MiB by default). A read is synchronous while its bytes are cached and returns a `Miss`
otherwise. The caller awaits it and reads again. A point get:

1. Rejects the key if it falls outside the run's first and last keys.
2. Rejects it if the bloom filter says no.
3. Binary-searches the block index for the one block that could hold the key, unpacking it
   first if the run uses LZ4.
4. Checks the block's prefix against the key once. Then it binary-searches the offset table,
   comparing suffixes in place, and walks at most 4 records from the last one not past the key.
   It copies out only the record that matches.

A get used to decode the whole block into objects and then search them. Walking it in place
cut a get that hits L2 from 7.7 µs to 4.0 µs, measured at 100k todos with a benchmark script that has since been removed.

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
u64 through
u32 run count
per run:
  u16 path length, path (UTF-8, relative to the database root)
  u32 bytes                  size of the run's file
  u8  has range
  if has range: u32 length, smallest key, u32 length, largest key
u32 crc32 of every byte before it
```

Runs are listed with L0 first, newest first. Every deeper level follows in order, with its runs
sorted by smallest key. Reads use that order directly, so the first hit wins.

`tombstoneSeq` is the highest seq of any delete that a bottom-level compaction dropped. A key
that has no entry at all may have been deleted at any seq up to it.

`through` is the seq the manifest's runs reach: they hold the fold of every seq of the log up to
it, and no seq past it. An ingest sets it to the last seq it folded, and a compaction keeps its
base's. Recovery uses it to pair a manifest with the WAL.

`bytes` is the size the encoder reported when it wrote the run. Planning sums it per level and
reads no file. Nothing at runtime checks it against the file.

Version 3 added `bytes`. A reader rejects any other version as corrupt, and a database written
with an earlier version does not open.

The generation the tabs should read is the one recorded in IndexedDB `meta.generation`, not
the newest file in `m/`. A manifest becomes visible only once IndexedDB records it. New
manifests number one past the highest number in use, meaning the newest file in `m/`, the
recorded generation, and `meta.topGeneration`. Numbers can skip.

# Reads

`get` reads the memtable first. On a miss, it asks the installed levels newest first
(`pointGetSst` in `store/merge.ts`) and stops at the first one that holds the key. Each L0 run
is a level of its own. A deeper level binary-searches its runs' key ranges and asks only the one
run whose range holds the key, so a get costs one probe per level, not one per run. It doesn't
touch IndexedDB, and it doesn't wait on the SharedWorker.

`range` merges a cursor over the memtable with one cursor per scan source, using a min-heap
ordered by key (descending with `reverse`) and then by source, newest first. For each key the newest source wins, and
tombstones are dropped. Each L0 run is its own source, because L0 runs overlap. Each deeper
level is one source (`RunLevel` in `store/merge.ts`): its runs never overlap, so the level
cursor binary-searches the runs' largest keys for the start key and opens one run at a time,
in key order, stopping at the first run that starts at or past the end key. Routing uses the key
ranges in the manifest, so a scan only pays for the runs it reaches. The merge peeks every source
before it awaits, so a cold scan loads all its first pages in one parallel round. It seeks to the
start key with the block's offset table, then walks records in place and copies out each one
when it reaches it.

`range({ reverse: true })` returns the same keys in descending order, and `limit` keeps the
largest. Direction is chosen once, where a cursor or the heap is built. A level opens the last
run that starts below the end key and steps to the run before. A run starts at the last block
whose separator is below the end key and stops before a block whose keys all sit below the start
key, so the first block read is the one that holds the end bound. Records have no back pointers,
so a block is walked forward once, noting where each record starts, and read from the last. That
is one header-only pass over a block of about 4 KiB. The file format and the wasm engine don't
change: `scan_block_contains` returns a block's hits in key order and the reader reverses them.

The bloom filters play no part in a scan. They answer whether one exact key is present.

A `view` pins `appliedThrough`, the installed generation, the memtable chunks and the
levels. Writes that commit during the callback are invisible to it.

`range({ valueContains })` keeps only live puts whose current value holds every pattern, each
key once, newest source first. Each source filters on its own: the memtable in JavaScript, each
run inside the wasm engine one block at a time (`scan_block_contains_js`, `store/block-scan.ts`),
and only the hits cross back. An LZ4 block is unpacked in that call; a raw block is read in
place. A newer source that holds the key with a non-matching value or a tombstone drops the
older hit. Without wasm, the run's cursor does the same filter key by key.

`db.rangeFollow(range, follow)` scans a range and point-reads the key that `follow` returns for
each entry. Every read sees the same state, because the scan and the reads use one pinned memtable
and one held generation. A page load can make them wait, and writes that land meanwhile are not
seen.

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
manifest and runs outside the transaction, then tries again. A run file or the manifest can
disappear between the tail read and the run open, when the host reclaims a generation that a
newer one replaced. The next section says how the retry still makes progress.

## Loading a generation under churn

A tab holds a run only once its open returns, and the host's reclaim removes every run of an
old generation that no tab holds. So without more, a tab whose opens are slow can lose every
try: before each open returns, the host records a newer generation and reclaims the one the tab
is opening. The guarantee is:

**On a healthy database, `sync`, `update` and a blind append that needs a catch-up always
succeed, however compaction is scheduled. `CorruptDatabaseError` means a file of the recorded
generation is really gone.**

The tab and the host share a Web Lock, `opfs-lsm-reclaim/<name>`:

- The tab's first try takes no lock, so a sync on a quiet database costs what it did. When that
  try finds a file missing, every later try holds the lock **shared**, from the tail read to the
  last run open (`holdingFiles` in `host/protocol.ts`).
- The host removes files only while it holds the lock **exclusively**, and asks with
  `ifAvailable`: when a tab holds it, the host skips the removal and does not wait. This covers
  the run sweep (`EngineHost.reclaim`) and the deletion of old manifests after a flush or a
  compaction install. Skipped runs stay retired and the next pass tries again; old manifests go
  with the next flush or reclaim.

Under the lock, the generation the tail names was recorded while no removal could run, so its
manifest and every run are on disk. Its load succeeds, and the try catches up. A try under the
lock can still fall behind when another load of the same tab installed a newer generation
meanwhile; that is not counted, and the next tail names the newer one. A try that finds a file
missing under the lock counts. The tab reconciles (see [Recovery](#recovery)), which records a
whole manifest after a power loss, and after 8 such tries it throws
`CorruptDatabaseError`. A healthy database never reaches that count.

Liveness, tab side: a try under the lock waits only for a removal already running, and a
removal never waits for anything but its own file calls. Every try under the lock then
succeeds unless the files are really gone. `update` and appends can still retry when another
tab writes and the host flushes between the tail read and the append, as any optimistic write
does, but each retry needs new writes from another tab.

Liveness, host side: the host never waits for the lock, so no tab can stall a flush, a
compaction or an install, even one that holds the lock forever. Such a tab only delays the
removal of retired runs and old manifests, which is safe: they are garbage. A tab takes the lock
only after a try without it failed, almost always because a removal broke it, and lets go once
it catches up; a skipped removal breaks no try. So removals are skipped only while some tab is
retrying, and the browser frees a tab's locks when the tab or worker goes away.

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

A flush folds the WAL as it stands when it starts, oldest records first, into one L0 run per
`flushRunBytes` of op bytes (2 MiB). A backlog becomes several runs, so a flush holds one run's
worth in memory, not the backlog. Each run is its own pass through the steps below and holds the
exclusive section for that pass only, so a compaction install can land between two runs. A host
runs one flush at a time per database, and a flush asked for meanwhile waits for it. Records acked
after a flush starts wait for the next one, so a steady writer cannot keep a flush going.

Under the exclusive section for the database, once per run:

1. Reconcile (see [Recovery](#recovery)). In a running database this reads `meta` and lists
   `m/`, and changes nothing. The recorded generation is `G`, and the highest number in use is
   `top`.
2. Read the WAL records above `ingestedThrough`, oldest first, until their op bytes reach
   `flushRunBytes`. A run takes at least one record and never one that would take it past the
   cap, so a record larger than the cap becomes a run of its own.
3. Fold them to the last op per key, in key order, keeping each op's seq.
4. Write `l0/<first>-<last>.sst`.
5. Write manifest `top + 1` with `through = <last>`, listing the new run in front of the runs
   of manifest `G`. It builds on the recorded generation, never on a newer manifest file: one
   that IndexedDB has not recorded was left by a crash.
6. In one IndexedDB transaction, set `ingestedThrough = <last>`, raise `generation` to
   `top + 1`, and delete the records at or below the previous `ingestedThrough`.
7. Delete the manifests older than the recorded generation, unless a tab holds the reclaim
   lock (see [Loading a generation under churn](#loading-a-generation-under-churn)).

The exclusive section is a promise chain inside the host plus a Web Lock named
`opfs-lsm-ingest/<name>`. The lock covers the case of two SharedWorkers serving the same
database, for example two builds with different script URLs.

**L0 stop.** Step 1 also counts the L0 runs of manifest `G`. At 15 runs, with records waiting,
the flush publishes nothing and releases the section. 15 is one less than the 16 sources of a
merge, so one compaction step can take all of L0. The flush asks for a compaction pass if none
runs, then waits for the next step to install, outside the section so the install can take it.
After the install it tries again. If the pass ends without an install, because nothing was left to
merge or because it failed, the flush publishes its run anyway and checks again before the next
one. A compaction that cannot help delays the flush by one pass and never blocks it for good.
`HostStats.l0Stops` counts the waits.

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

`planCompaction` reads only the manifest. It scores each level and serves the highest score
above 1; on a tie the shallower level wins:
- L0, once it has 4 runs or more, scores its run count over 4. Its step merges the oldest L0
  runs, at most 15, with the L1 runs whose ranges overlap them. The newer L0 runs wait for the
  next step, still newer than all of L1.
- L1 and below score their bytes over their budget. The step picks the run whose overlapping
  bytes in the next level are the smallest fraction of its own size, and merges it with those
  runs into the next level.

If L0 always went first, steady writes would keep it at 4 runs and L1 would never be pushed
down: it would grow past its budget and every L0 merge would rewrite all of it. Scoring lets L0
pass 4 runs for a while, which adds read layers, until its score wins again.

A plan is marked `bottom` when no run below the output level overlaps the inputs. Only then may
the merge drop tombstones, because no older value is left for them to hide.

## Merging

A step reads its inputs as sources, newest first. A source is runs read back to back as one
key-ordered stream: each L0 run is a source of its own, and the next level's overlapped runs,
which never overlap each other, are one source together. So a step has at most 16 sources.

The merge is a session in wasm (`crates/engine-core/src/merge.rs`, ABI in
`crates/engine-abi.md`) that the host pumps (`pumpMerge` in `host/compact.ts`). Each pump stops
between two keys and asks the host for one thing:

| Stop | The host |
|---|---|
| NEED | reads the listed byte ranges of the inputs, in parallel, and feeds them in |
| WRITE | copies the bytes out and writes them to the open output run, `c<top + 1>.<i>` |
| RUN_END | finishes that file and records its size and key range |
| YIELD | gives the event loop a turn, after about 1 MiB of input |
| DONE | installs the outputs: every input was read and every CRC matched |

The session owns every offset and asks for whole blocks only. It reads each run's last 128 KiB
first, which holds the footer and usually the whole bloom and index, then the rest of them if
the tail missed it, then the data blocks in order, up to 256 KiB a read. While the host reads for
one source, every source holding under half a read asks for its next one too. The CRC of a run
covers its data and then its meta, but the meta comes first: the data's CRC streams in as blocks
arrive and combines with the meta's, and it is checked before the last block's entries are used.

For a key, the newest source wins and, within a source, the last duplicate wins, across block,
read and run boundaries: each source holds the entry it would give (`cur`) and the one read after
it (`look`), and gives `cur` only once `look` has a greater key. It drops the tombstones that win
if the plan is `bottom`, and keeps the highest seq it dropped. It cuts the output into runs of
`TARGET_RUN_BYTES`, 4 MiB of records counted as tag, seq, and u32 key and value lengths: the key
and value plus 17 bytes. A run closes on the first entry that takes it to 4 MiB or more. On-disk
records use varints and a shared prefix, so a full raw run is under 4 MiB on disk when its blocks
share long prefixes, as index keys do. LZ4 runs are smaller again. The last run of a merge holds
whatever is left over.

What a step holds no longer depends on its inputs' size: per source about 256 KiB of blocks
(512 KiB while reading ahead), one unpacked block and two entries, plus the open output run's
block, bloom hashes and index rows, and up to 256 KiB of output not yet written. The session
reserves that at open and returns an error, never a trap, when memory cannot grow. If any input
is corrupt, or any read or write fails, the host deletes every output the step wrote and installs
nothing.

Without wasm, or while another step holds the module's one session, the TypeScript session
(`store/merge-ts.ts`) runs the same protocol. It decodes each read's blocks at once and gathers
an output run's entries before it encodes them, so it holds about 8 MiB more than the reads, and
its runs are raw.

## Installing

The merge itself runs without the ingest lock. It holds only `opfs-lsm-compact/<name>`, so
flushes keep going while it runs. A flush meanwhile only adds L0 runs in front of the inputs, so
the plan stays valid. To install, under the exclusive section, the host:

1. Reconciles, and checks that every input is still in the recorded manifest `G`.
2. Writes manifest `top + 1`, with the inputs replaced by the outputs (each with the size and key
   range its encoder reported), `tombstoneSeq` raised to the highest dropped tombstone, and `G`'s
   `through`.
3. Raises IndexedDB `generation` to `top + 1`.
4. Reclaims: deletes the manifests older than `top + 1` and the input runs that the new
   manifest doesn't list and no tab holds open. While a tab holds the reclaim lock, it deletes
   nothing and tries again on the next pass.

The merge plans on the recorded generation too, and names its outputs
`c<top + 1>.<i>`, past every manifest number in use, so an output never overwrites a run that a
manifest on disk lists.

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
| Compaction merge and split | SharedWorker | wasm session, pumped by TypeScript |
| CRC-32 check on decode | SharedWorker | wasm (slicing-by-8, 4 streams) |

The tab reads with TypeScript so a `get` never posts a message. A get that lands in an LZ4 block
calls wasm to unpack that one block. The bulk byte work, meaning encode, decode and merge, runs in
wasm off the main thread. If the wasm module fails to load, TypeScript fallbacks for all of them
run instead, except that encode then writes raw blocks only.

# Recovery

Writes go to two stores, and nothing orders one against the other on disk. IndexedDB commits
with the default (relaxed) durability, so `complete` means the OS has the write, not the disk.
OPFS's `close()` swaps a file into place with no fsync. After a power loss, each store keeps a
prefix of its own completed writes, and the two prefixes are independent. Acked writes may be
lost (see the goals at the top). The database must still open, and read the fold of one prefix
of the log.

## The invariant

The write order keeps two facts true at every prefix of each store:

1. **Every intact manifest is a log prefix.** A manifest is intact when every run it lists is
   on disk. An intact manifest's runs hold the fold of exactly the seqs `1..through` of the log,
   leaving out seqs that a power loss lost from both stores. A run is written before any
   manifest lists it, and run paths are never reused for other writes, so an intact manifest
   always shows the runs it was written with.
2. **WAL records are log entries.** `head` never moves down, so a seq is never handed out
   twice. Recovery moves `head` past every seq that any manifest on disk names, so a manifest
   that is not intact now cannot become intact later with other writes in its runs. New
   manifests number past `topGeneration`, so a number IndexedDB still holds after a later power
   loss never names a different manifest.

So any intact manifest `M`, followed by WAL records `through + 1..head` with no gap, is a log
prefix: `fold(log[1..head])`. Without those records, `M` alone is `fold(log[1..through])`.

## The rule

`reconcile` (`src/recover.ts`) picks the manifest to record:

1. **OPFS kept seqs that IndexedDB lost.** The newest intact manifest numbered past the recorded
   one whose `through` is past `head`. It is a longer prefix than the WAL. Recording it moves
   `head` to its `through` before any of its seqs can be handed out again.
2. **Otherwise the recorded manifest**, if it is intact.
3. **Otherwise IndexedDB recorded a manifest that OPFS lost**, or recorded none: the newest
   intact manifest, or the empty generation 0. A manifest file that is missing or empty counts
   as lost: OPFS can leave a file created and never closed.

### Corruption is not a power loss

A power loss cannot tear a manifest, because OPFS publishes a file whole. OPFS also keeps its
own writes in order, and the host removes a run only after every older manifest that lists it,
and never a run of the recorded manifest. So a power loss never leaves the recorded manifest on disk with a run missing, or a manifest that fails to
decode. Those states are corruption. Recovery refuses them rather than lose data that is still
on disk: it throws `CorruptDatabaseError` and writes nothing, so no WAL record is dropped and no
sweep runs against a stand-in.

- **The recorded manifest is there but does not decode** (bad CRC, magic or length): refuse.
  Only a missing or empty file takes rule 3.
- **The recorded manifest decodes but lists a run that is gone:** an intact manifest whose
  `through` is at or past `ingestedThrough` may stand in, because it and the WAL still hold every
  seq (the old manifest of a compaction, or its new one). Otherwise refuse.
- **Rule 3 meets a manifest that does not decode before an intact one:** refuse. It may be the
  newest state.

`openDb`, a tab's repair, and the host's ingest, compaction install and sweep all reconcile
first, so each of them refuses too, and the database stays as it is on disk for an app or a person
to recover. A leftover manifest numbered past an intact recorded one is still ignored when it
does not decode (rule 1 skips it).

Recording a manifest (`IdBWal.adopt`) is one IndexedDB transaction, and it writes only if
`meta` still reads what reconcile read. The transaction pairs the manifest with the WAL:

- If `through` is at or past `ingestedThrough`, the manifest holds every folded seq.
  `ingestedThrough` becomes `through`.
- If `through` is below `ingestedThrough` and the WAL still holds every seq above `through`,
  those seqs are uningested again. These are the records [Truncation](#truncation) keeps.
- Otherwise no record can follow the manifest. Every record is dropped, and `ingestedThrough`
  moves to `head`. The database is the manifest alone, and the seqs between are lost.

In the same transaction, `head` moves past the highest `through` of any manifest on disk, and
`topGeneration` past every manifest number seen.

In a running database neither rule 1 nor rule 3 applies. A manifest's `through` is at most the
head when it is written, and `head` never moves down. Reclaim never removes the recorded
manifest or its runs. A manifest newer than the recorded one exists only between a publish and
its IndexedDB commit, or after a crash between them. Its seqs are still in the WAL, so it is
ignored, and the next ingest or compaction numbers past it.

## Who reconciles

- `openDb`, before the first sync. It trusts the recorded manifest's runs, because the sync
  opens them anyway. On a healthy database this costs one `meta` read, which replaces the
  `generation` read open already did, and one listing of `m/`.
- `sync` and appends, when the recorded generation does not load while the tab holds the
  reclaim lock. Then no reclaim can explain the missing file: after a power loss, reconcile
  records a manifest that loads.
- The host, at the start of every ingest, compaction install and sweep, under the ingest lock.
  The host checks a recorded manifest's runs once and then trusts the generations it published
  itself. A sweep keeps only the recorded manifest's runs. A newer manifest is a crash leftover:
  nothing builds on it, and recovery only records a manifest whose runs are all on disk.

Every tab writes only after its open reconciled, so no new seq can collide with a seq that a
manifest holds.

# Crash behavior

Each step writes new files before it points anything at them, and deletes files only after
nothing points at them. A **process crash** (a tab or the SharedWorker killed, the OS keeps
every completed write) stops both stores at one point of the global order:

| Crash after | State on reopen |
|---|---|
| Append, before `complete` | The batch isn't in the WAL. The caller never got an ack. |
| L0 run written, before its manifest | The run is in no manifest and is garbage. The records are still in the WAL. |
| Manifest written, before the IndexedDB update | `generation` still names the old manifest, so tabs ignore the new one, and the records are still in the WAL. Its `through` is at most `head`, so reconcile leaves it. The next ingest builds on the recorded manifest and numbers past the leftover. It re-folds the same seqs, usually into the same path with the same bytes. The next sweep removes the leftover's other runs, and reclaim removes the manifest once a newer one is recorded. |
| IndexedDB updated, before reclaim | Old manifests and input runs stay on disk until a later ingest or compaction removes them. |
| Compaction outputs written, before install | The outputs are in no manifest. They are garbage. |

Every acked write survives a process crash. A new host's first sweep removes every run file that
the recorded manifest doesn't list.

Under a **power loss**, IndexedDB keeps commits `1..i` and OPFS keeps file operations `1..o`,
for any `i` and `o`:

| IndexedDB kept | OPFS kept | Reopen |
|---|---|---|
| An ingest's commit | Not its run or manifest | The recorded manifest is gone (rule 3). The previous manifest is intact, and the WAL still holds the seqs that ingest folded, so they are uningested again. Nothing is lost. If OPFS lost more than one ingest, the WAL is dropped, and the database is the newest intact manifest. |
| Not a compaction's `generation` raise | Its new manifest, and the removal of the old one and its inputs | The recorded manifest is gone. OPFS removed it only after publishing the new one, which is intact and has the same `through` (rule 3). Nothing is lost. |
| Some appends, not the ingest that followed | That ingest's manifest, or later ones | The manifest holds seqs past `head` (rule 1). It is recorded and `head` moves to its `through`. The database is a longer prefix than the WAL held. |
| Nothing (a new IndexedDB) | Some manifests | Rule 3 records the newest intact one, and `head` moves past its seqs, so new writes never reuse a seq or a run path. |
| Commits past what OPFS kept, in any mix | Any prefix | One of the rows above. The database opens as an intact manifest plus the WAL records that follow it with no gap. |

`pnpm --filter @opfs-lsm/kv formal:power-loss` checks the rule on a model of both stores. It
covers every workload of up to six appends, ingests and compactions, every pair of prefixes,
and a second power loss at every pair of the recovery's own writes. No power-loss state reaches a
refusal. It also removes each run of the recorded manifest after every workload: open refuses
and nothing writes, unless a manifest holds every ingested seq, which then stands in with every
acked write.
`tests/sim/crash-enum.test.ts` checks every pair on the real code.

# Assumptions about the platform

- IndexedDB serializes `readwrite` transactions that share a store, across tabs and workers.
  Seq assignment depends on this. Aborting a transaction reverts the WAL store's key generator,
  which keeps a blind append gapless when it aborts.
- An OPFS `createWritable().close()` publishes the whole file atomically, and never shows a
  partial file to readers.
- Each store keeps the order of its own completed writes across a power loss, so what survives
  is a prefix of them. Nothing orders IndexedDB against OPFS (see [Recovery](#recovery)). Both
  are inferred, not documented (`docs/research/corruption-hardening-test-suite.md`,
  "Browser durability facts").
- A SharedWorker with the same URL and name is shared by every tab of the origin. `openDb` names
  it `opfs-lsm:<name>`, so each database gets its own. If two different URLs serve one database,
  the Web Locks keep them from writing manifests at the same time.
- Web Locks are shared by the tabs and workers of an origin, and the browser releases a
  context's locks when it goes away. A tab holds `opfs-lsm-reclaim/<name>` only while it
  retries a load. The host never waits for it, so the guarantee of
  [Loading a generation under churn](#loading-a-generation-under-churn) does not depend on the
  release; only the removal of garbage does. Without Web Locks, a retry is unprotected.
- BroadcastChannel delivers messages in order from one sender, but may deliver them late. The
  engine tolerates lost or late messages, because the WAL tail is always the source of truth.

# Known limits of this design

- Each tab keeps every live run file in memory. Tab memory grows with the size of the database.
- The leftover run of a merge can be tiny, and the planner rarely picks a tiny run on its own,
  so small runs can stay around.
- A tab sees another tab's writes over BroadcastChannel, so its reads can lag the ack by a
  message hop until it calls `sync`.
