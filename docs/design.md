# opfs-lsm design

--------------------------------------------------------------------------------------------------

`@opfs-lsm/kv` is an embedded key-value store for the browser. Keys and values are byte arrays.
It is a log-structured merge tree (LSM). All of it lives in the Origin Private File System
(OPFS). Each tab appends its writes to its own write-ahead log. Sorted, immutable SST files hold
the data once it has been folded out of the logs.

Every tab of an origin can open the same database. Each tab writes to its own log through a
dedicated WebWorker, reads the other tabs' logs, keeps its own in-memory table of the writes
that are not yet in an SST, and answers reads from memory. One SharedWorker turns the logs into
SST files and compacts them. A SharedWorker is a single script that every tab of the origin
shares. It isn't a dedicated WebWorker or a ServiceWorker.

`@opfs-lsm/collections` builds tables and secondary indexes on top of the kv API. This document
covers only the kv engine. The reasoning behind the per-tab logs, and the designs they replaced,
are in `architecture/wal-opfs/04-per-tab-logs.md`.

The design ranks goals in this order (see `AGENTS.md`):
1. Read and write latency.
2. Consistency. Every tab sees the other tabs' writes as one prefix of one order, the same order
   in every tab, with its own writes on top.
3. Persistence. An acked write survives a crash of the tab or one of its workers. A crash of the
   whole browser, like a power loss, can lose the writes a tab acked since its last flush.

All multi-byte integers on disk are little-endian.

# Storage layout

A database named `<name>` lives in one OPFS directory:

```
OPFS  opfs-lsm/<name>/
  ├── w/<tab>/<firstN>.<prevStamp>.wal one tab's log, one segment per file
  ├── m/<generation, 16 digits>.mft    manifests, the newest intact one wins
  ├── l0/<firstSeq>-<lastSeq>.sst      flushed runs, may overlap
  ├── l1/c<gen>.<i>-<bytes>.sst        compacted runs, disjoint within a level
  ├── l2/...
  └── ...
```

A **tab** is one open `Db`, with a random 16-hex-digit id. A **stamp** orders its writes among
every tab's (see [The order](#the-order)). A **run** is one SST file. A **generation** is one
numbered manifest that lists the live runs. Its **cut** is the stamp it folded through: the runs
hold every log record stamped at or below it, from every tab's log. A **seq** is the position of
a record in the order. Every tab numbers the records above the cut from the generation's
`through + 1`, so every tab gives each record the same seq.

Run paths are immutable. A path is written once and never rewritten with different contents.
This lets every tab cache a parsed run by its path, with no invalidation.

The size in a compacted run's name lets the compaction planner size levels without opening any
file. L0 names carry the seq range instead.

# Logs

Each tab writes its own log under `w/<tab>/` (`packages/kv/src/log/`). Only that tab ever writes
it, so an append takes no lock and waits for no other tab.

## Frames

A log is a chain of segment files. A segment is a run of frames:

```
u32 bodyLen | u32 crc(kind, stamp, n, body) | u8 kind | u64 stamp | u32 n | body
```

A RECORD frame holds one batch. `n` counts the tab's records from 1 with no gaps. A SEAL frame
ends a segment. The body is the batch's ops back to back:

```
per op:  u8 type (0 put, 1 del) | u32 keyLen | key | put only: u32 valueLen | value
```

A frame is part of the log when it is whole, its CRC holds, its `n` is the previous one + 1, and
its stamp is above the previous one. Readers stop at the first frame that breaks this, so a torn
tail is invisible and every read of a log is a prefix of it. A frame whose stamp is not a safe
integer ends the prefix too.

A segment's name holds the `n` of its first record and the stamp of the last record before it
(`<firstN, 10 digits>.<prevStamp, 16 digits>.wal`). So a reader can go on after reclaimed
segments, and recovery can check that the logs still cover a manifest's cut.

The decoder hands out keys and values as views into the bytes read. A frame whose CRC holds but
whose body ends inside an op throws `CommitError` (`corrupt log record`).

## Append

`put`, `delete` and `batch` take the next stamp, encode the ops, and send the frame to the tab's
dedicated WebWorker (`log/log-worker.ts`), named `opfs-lsm-log:<name>`. The worker holds the
tab's segments as SyncAccessHandles in the default, exclusive mode, which every browser supports.
The appends of one task go out as one message and one write. The ack is that write: the frame is
in the file, not yet flushed. The tab reads its own write at once (see
[Own writes](#own-writes)).

With an fs that keeps segments in process (MemoryFs, in tests), the writer runs in the tab's
thread instead.

## Flush

A SyncAccessHandle flush costs about 0.4 ms in Chrome, ten times a write, and blocks the next
write. So flushes are lazy. One flush covers every record written before it starts, and it
runs:

- at once, when another tab asks for a stamp that an unflushed record holds back (`advance`, see
  [The watermark](#the-watermark))
- 2 ms after a write while other tabs are live
- 100 ms after a write while the tab is alone
- before the tab asks for an ingest, and before `close`

A tab broadcasts a record only once it is flushed. So after a power loss, no other tab's state
and no ingest depends on a record that was lost.

## Segments

A segment is sealed once it reaches `maxWalBytes` (`ingest-policy.ts`, 1 MiB by default): the
writer appends a SEAL frame, flushes, and closes it. The next segment is created at the next
write. So only a tab's last segment can end in a torn frame. A reader that finds a bad frame in
a segment with a later one, or a next segment that does not follow on (its `firstN` and
`prevStamp`), throws `CorruptDatabaseError` rather than drop the records past it.

A tab never reopens a log. A new `Db` starts a new tab id and a new log.

## Reading a log

Tabs and the ingest host read logs with plain `AsyncFs` reads (`log/reader.ts`), with no lock and
no worker, from where the last read stopped. In Chrome a read of a file that its writer changes
meanwhile can throw `NotReadableError`; the read tries again, up to 8 times. A frame being
written fails its CRC and ends the read.

Records at or below a floor, the installed generation's cut, are passed over without decoding
them or checking their CRC: the ingest that folded them checked it.

## Reclaim

The host removes a segment once a generation covers it: a sealed segment whose records are all
at or below the cut, and the last segment of a dead tab once its records are too. A live tab's
open segment is never removed.

A dead tab's last segment gives way to a tombstone: an empty segment named past its last record,
as the tab's next segment would be. The log then reads as reclaimed through that stamp, the same
signal as a reclaimed first segment, for recovery (an older manifest stands in only if it covers
it) and for a tab that missed those records (it waits for a generation that does). Without it,
the whole log would vanish and both would take the dead tab for one that never wrote. The host
removes the tombstone and the directory once every manifest on disk covers it. A reclaim cut
short between creating the tombstone and removing the segment before it leaves both: an unsealed
segment followed by an empty last one that follows on from it, which readers accept.

A tab that missed records (lost broadcasts, a missed `ingest`) can find their segments
reclaimed. The next segment's name gives the `n` and stamp before it, so the read goes on. But
the tab hands out nothing more until it installs a generation whose cut reaches that stamp, or
it would number what follows too low. It loads the newest. If even that does not reach the
stamp, the records are gone, and the tab fails every wait and write with `CorruptDatabaseError`.

# Memtable

Each tab holds a memtable (`packages/kv/src/store/memtable.ts`). It holds the stable records
(see [The watermark](#the-watermark)) above the installed generation's `through`, up to
`appliedThrough`, folded to one row per key:

```
MemRow = { key, seq, kind: "put" | "del", value? }
```

Rows are kept in key order, in chunks of 512 to 1024 rows. An insert moves at most one chunk. A
chunk splits in two when it passes 1024 rows.

Records apply in seq order with no gaps. The tab numbers each stable record one past
`appliedThrough` as it applies it, so the memtable is always one exact prefix of the order.

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
| u64 seq         the log seq that wrote the key                             |
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
u64 through                  version 2 and later
u64 cut                      version 3
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

`cut` is the stamp the manifest's runs reach: they hold every log record stamped at or below it,
from every tab's log, and none above it. `through` counts those records: the runs hold the fold
of seqs `1..through`. An ingest sets both. A compaction keeps its base's. Older manifests read
with the missing fields as 0.

Publishing a manifest commits it. The **committed generation** is the newest manifest whose runs
are all on disk (see [Recovery](#recovery)). New manifests number one past the highest number in
`m/`. Numbers can skip.

# Reads

`get` reads the tab's own unstable writes first, then the memtable. On a miss, it asks the
installed levels newest first (`pointGetSst` in `store/merge.ts`) and stops at the first one that
holds the key. Each L0 run is a level of its own. A deeper level binary-searches its runs' key
ranges and asks only the one run whose range holds the key, so a get costs one probe per level,
not one per run. It doesn't read a log, and it doesn't wait on the SharedWorker.

`range` merges a cursor over the memtable with one cursor per scan source, using a min-heap
ordered by key and then by source, newest first. For each key the newest source wins, and
tombstones are dropped. Each L0 run is its own source, because L0 runs overlap. Each deeper
level is one source (`RunLevel` in `store/merge.ts`): its runs never overlap, so the level
cursor binary-searches the runs' largest keys for the start key and opens one run at a time,
in key order, stopping at the first run that starts at or past the end key. Routing uses the key
ranges in the manifest, so a scan only pays for the runs it reaches. The merge peeks every source
before it awaits, so a cold scan loads all its first pages in one parallel round. It seeks to the
start key with the block's offset table, then walks records in place and copies out each one
when it reaches it.

The bloom filters play no part in a scan. They answer whether one exact key is present.

A `view` pins `appliedThrough`, the installed generation, the memtable chunks, the tab's own
unstable writes and the levels. Writes that land during the callback are invisible to it.

`range({ valueContains })` keeps only live puts whose current value holds every pattern, each
key once, newest source first. Each source filters on its own: the memtable in JavaScript, each
run inside the wasm engine one block at a time (`scan_block_contains_js`, `store/block-scan.ts`),
and only the hits cross back. An LZ4 block is unpacked in that call; a raw block is read in
place. A newer source that holds the key with a non-matching value or a tombstone drops the
older hit. Without wasm, the run's cursor does the same filter key by key.

`db.rangeFollow(range, follow)` scans a range and point-reads the key that `follow` returns for
each entry. Every read sees the same state: the scan and the reads share one pin of the rows and
the installed levels.

# Multi-tab coordination

Each tab's side of the protocol is a `LogSession` (`packages/kv/src/log/session.ts`). The merge
of every tab's records is a `Merger` (`log/merger.ts`).

## The order

Every record has a stamp from its tab's hybrid logical clock (`log/hlc.ts`):

```
stamp = microseconds since 2025 × 4 + counter          a safe integer until 2096
stamp = max(wall clock stamp, highest stamp seen + 1)
```

The order of all records is (stamp, tab). A write made after a tab saw another tab's write sorts
after it. Writes of tabs that never saw each other sort by wall clock, to `performance.now()`'s
resolution (5 to 100 µs in browsers), then by tab id. Correctness does not rest on the clocks
agreeing.

## The watermark

A tab's **promise** is a stamp it will write nothing at or below. The **watermark** is the lowest
promise among the tabs that may still write: the live tabs, and the dead tabs whose log has not
been read to the end. A live tab this one has not heard from yet holds it at −∞. Records at or
below the watermark are **stable**: no tab can write anything that sorts before them. So every
tab hands out the same prefix in the same order, numbers it the same way, and applies it to its
memtable.

A tab is **live** while it holds the Web Lock `opfs-lsm-tab/<name>/<tab>`, which it takes at open
and keeps until close (`log/liveness.ts`). The browser releases the lock when the tab or its
worker goes away, crash included. A dead tab's log is final: once it is read to the end, the tab
holds nothing back. If its log is gone, reclaim removed it after a generation took its records,
which this tab may never have seen: the tab installs the newest generation first.

A tab whose log write or flush fails (out of quota, say) can't go on past the lost record, and
can't promise past what it wrote either, which would hold every other tab's watermark. It
leaves as on close: it says `bye`, releases its liveness lock, and every later write fails with
the error. The other tabs retire it by reading its log to its end. Under an OPFS quota, Chrome's
`SyncAccessHandle.flush()` can block the log worker for good, so a flush that has not finished in
5 s counts as a failure too: the tab terminates its log worker and leaves. Only flushes get this
limit. A flush adds no record and the writes queued behind it never run, so nothing lands in the
log after the others retired it; a write that finished late could.

Tabs talk on the BroadcastChannel `opfs-lsm-log/<name>`:

| Message | Meaning |
|---|---|
| `rec` | One record with its ops, sent once it is flushed. It is also a promise of its stamp. Its `n` lets a receiver that missed one see the gap and read the sender's log instead. |
| `advance(s)` | A tab waits for stamp `s`. Each tab answers with a promise up to what it has flushed, and flushes at once when an unflushed record holds the answer back. |
| `promise(stamp, n)` | The answer to `advance`. |
| `hello`, `welcome` | A new tab joins (see [Open](#open)). |
| `bye` | A tab closes. The others read the rest of its log and stop waiting for it. |

A stalled tab asks again every 50 ms, marked `again`. Each tab answers a repeat with its last
promise even when it promised nothing new, because a lost promise is in no file. On the same
tick the stalled tab lists the live tabs and retires the dead ones. Log reads are the fallback
for a gap, a join and a dead tab.

So a tab sees another tab's write a moment after that write's ack: after the writer's flush (2 ms
when other tabs are live) and a message hop. `db.sync()` closes that gap. It reads every log, and
waits until every record it saw from another tab, and every record this tab wrote, is stable.
Reads after it are one prefix of the order, with nothing of this tab's on top, so they include
any write of another tab ordered before this tab's own.

## Own writes

A tab's own write is not stable at its ack: another tab may still write below it. Until it is,
it sits in the tab's **overlay**, a small table that reads see over the memtable. So the tab
reads its own writes at once. The overlay drops a record once it is stable or a generation holds
it.

## Open

`openDb` starts these at once:

- Read the newest manifest, for its cut.
- Take the liveness lock, and read every other tab's log. The reads wait for the cut only to
  scan, and pass over the records at or below it.
- Load and install the generation (see [Installing a generation](#installing-a-generation)).

Then it lists the live tabs. The query comes after the reads, so a tab whose log was read and
that is not live died before the query: its log is read again from where the first read stopped,
and then it holds nothing back. If the manifest's runs turn out to be gone and an older
generation stands in, the logs are read again above its lower cut.

No record is handed out before the generation is installed, because their seqs count on from its
`through`. Then the tab broadcasts `hello`. Each live tab answers `welcome` with its stable stamp
and its promise, and holds its watermark below the new tab until the new tab promises. The new
tab starts its clock above every stamp it saw, promises, and waits until every record it read is
stable.

## Update

`db.update(keys, body)` holds the next stamp `t`, and waits until every record below `t` is
stable. While it holds `t`, this tab promises only `t − 1`, so nothing ordered after `t` becomes
stable. It reads `keys`, runs `body` once, synchronously, and appends the result at `t`. The read
is exactly the state the write lands on, so there is no conflict and no retry, and it takes no
lock. Two concurrent updates serialize by stamp. They can't deadlock: a tab waiting to write at
`t₂` can still promise `t₂ − 1`.

## Changes

`db.changes(listener)` reports every append and every ingest, from this tab and from other tabs
(`changes.ts`). The tab's own write is reported at its ack, with its seq only if it was already
stable then. Another tab's write is reported when it becomes stable here, with its seq. An
ingest is reported when the message below arrives, or when this tab's `db.ingest()` moved the
generation.

## Installing a generation

The host and `db.ingest()` post `{ kind: "ingest", generation }` on the BroadcastChannel
`opfs-lsm-layers/<name>` when a generation moves. A tab installs the newest generation then, at
open, on `sync`, and when a log read finds segments reclaimed past what it has seen. The newest
is the one a message named, or else the newest manifest in `m/`.

Installing is synchronous, so reads never see half a switch. The memtable drops the rows at or
below the generation's `through`, and the session drops the stable records and overlay rows at
or below its `cut`.

## Loading a generation under churn

A tab holds a run only once its open returns, and the host's reclaim removes every run of an
old generation that no tab holds. So without more, a tab whose opens are slow can lose every
try: before each open returns, the host publishes a newer generation and reclaims the one the
tab is opening. The guarantee is:

**On a healthy database, open and `sync` always install a generation, however compaction is
scheduled. `CorruptDatabaseError` means a file of the committed generation is really gone.**

The tab and the host share a Web Lock, `opfs-lsm-reclaim/<name>`:

- The tab's first try takes no lock, so a sync on a quiet database costs nothing more. When that
  try finds a file missing, every later try holds the lock **shared**, from the manifest read to
  the last run open (`holdingFiles` in `host/protocol.ts`).
- The host removes files only while it holds the lock **exclusively**, and asks with
  `ifAvailable`: when a tab holds it, the host skips the removal and does not wait. This covers
  the run sweep (`EngineHost.reclaim`) and the deletion of old manifests after a flush or a
  compaction install. Skipped runs stay retired and the next pass tries again; old manifests go
  with the next flush or reclaim.

Under the lock, no removal can run, so the newest manifest and every run it lists stay on disk
until the try returns. The try under the lock checks that the manifest is intact, and looks past
one whose runs are gone to the newest intact one (see [Recovery](#recovery)). A try that still
finds a file missing under the lock counts, and after 8 such tries the tab throws
`CorruptDatabaseError`. A healthy database never reaches that count.

Liveness, tab side: a try under the lock waits only for a removal already running, and a
removal never waits for anything but its own file calls. Every try under the lock then succeeds
unless the files are really gone.

Liveness, host side: the host never waits for the lock, so no tab can stall a flush, a
compaction or an install, even one that holds the lock forever. Such a tab only delays the
removal of retired runs and old manifests, which is safe: they are garbage. A tab takes the lock
only after a try without it failed, almost always because a removal broke it, and lets go once
it catches up; a skipped removal breaks no try. So removals are skipped only while some tab is
retrying, and the browser frees a tab's locks when the tab or worker goes away.

# Ingest

Ingest moves log records into an L0 run. It runs in the SharedWorker's `EngineHost`
(`packages/kv/src/host/engine-host.ts`, `host/ingest.ts`).

## When it runs

The tabs own the trigger. Each tab counts the key and value bytes of the stable records above
the installed generation's cut. Once they pass its `maxWalBytes`, it flushes its own records and
posts `{ kind: "ingest-request", cut }` on `opfs-lsm-layers/<name>`. The cut is the stable stamp,
held below any record of this tab that is not yet flushed. Every tab sees the same stable order,
so several tabs may ask for the same cut. A tab asks again only once another `maxWalBytes` is
waiting, which retries a lost request or a failed ingest without hammering the host.

The default limit is 1 MiB (`maxWalBytes` in `ingest-policy.ts`). Every open decodes the log
records above the cut, so the limit is an open-time budget. The count is the bytes of the ops as
written: overwrites and deletes grow it the same way new keys do.

`openDb` sends `watch` to the host, and `close` sends `unwatch`. While a database has watchers,
the host listens on that channel and keeps the highest cut asked for. One ingest runs at a time;
when it finishes, it starts another if a higher cut arrived meanwhile. A failed ingest is
logged. At zero watchers the host closes its channel and drops the watch.

`db.ingest()` waits until this tab's records are flushed and every record it has seen is
stable, asks the host to fold through that cut, and waits for the compaction that starts. A cut
the committed generation already reaches writes nothing. A host ingest with no cut (tests,
tools) picks one itself: it reads the logs' last stamps first and lists the live tabs after,
and takes the lowest last stamp among them. A live tab with no record in what it read holds the
cut where it is.

Every record at or below a cut is flushed in some log: the asking tab passed its watermark, so
every other tab promised past it, and tabs promise only what they flushed.

## Steps

Under the exclusive section for the database:

1. Find the committed generation (see [Recovery](#recovery)), its cut, and `top`, the highest
   manifest number in `m/`.
2. Read every tab's log, and keep the records above the committed cut and at or below the new
   one.
3. Sort them by (stamp, tab), and number them from the committed `through + 1`.
4. Fold them to the last op per key, in key order, keeping each op's seq, and write
   `l0/<first>-<last>.sst`.
5. Write manifest `top + 1` with the new `through` and `cut`, listing the new run in front of
   the committed runs. This commits the ingest.
6. Remove the log segments the new cut covers (see [Reclaim](#reclaim)).
7. Delete the manifests older than the new one, unless a tab holds the reclaim lock (see
   [Loading a generation under churn](#loading-a-generation-under-churn)).

The exclusive section is a promise chain inside the host plus a Web Lock named
`opfs-lsm-ingest/<name>`. The lock covers the case of two SharedWorkers serving the same
database, for example two builds with different script URLs.

OPFS run and manifest writes go through `createWritable` and `close`. The browser swaps the new
file into place on `close`, so other readers see a file whole or not at all.

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

1. Finds the committed generation, and checks that every input is still in it.
2. Writes manifest `top + 1`, with the inputs replaced by the outputs, `tombstoneSeq` raised
   to the highest dropped tombstone, and the committed `through` and `cut`. This commits the
   step.
3. Reclaims: deletes the manifests older than `top + 1` and the input runs that the new
   manifest doesn't list and no tab holds open. While a tab holds the reclaim lock, it deletes
   nothing and tries again on the next pass.

The merge plans on the committed generation too, and names its outputs
`c<top + 1>.<i>`, past every manifest number in use, so an output never overwrites a run that a
manifest on disk lists.

A pass runs up to 8 steps, and a request that arrives during a pass starts another one.

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
| Stamps, encode ops, merge the logs, memtable, point get, range merge, SST reader, bloom checks | Each tab's main thread | TypeScript |
| Write and flush the tab's log | Each tab's dedicated WebWorker | TypeScript |
| Unpack an LZ4 block, match a filtered scan inside a block | Each tab's main thread | wasm, with TypeScript fallbacks |
| Fold the logs into L0, encode SSTs | SharedWorker | TypeScript fold, wasm encode |
| Compaction merge and split | SharedWorker | wasm |
| CRC-32 check on decode | SharedWorker | wasm (slicing-by-8, 4 streams) |

The tab reads with TypeScript so a `get` never posts a message. A get that lands in an LZ4 block
calls wasm to unpack that one block. The bulk byte work, meaning encode, decode and merge, runs in
wasm off the main thread. If the wasm module fails to load, TypeScript fallbacks for all of them
run instead, except that encode then writes raw blocks only.

# Recovery

Publishing a manifest commits an ingest or a compaction step. Every manifest is the fold of the
logs through its cut. So the database is the **committed generation**, the newest manifest whose
runs are all on disk, plus every log record above its cut, in (stamp, tab) order, numbered on
from its `through` (`recoverGeneration` in `src/recover.ts`). There is no other state to pair
with it, and nothing to repair.

A **process crash** (a tab, its dedicated WebWorker or the SharedWorker killed, with the browser
still up) loses no acked write: the ack is the write into the log file. A frame being written
when the tab died is torn, and readers stop at it.

A **browser crash** (the whole browser killed) counts as a power loss for the logs. The kill loop
in real Chrome sees it drop the last acked writes of a tab that were not yet flushed ("kept 1499
of 1501 acked writes"), so the ack is not durable against it. Those writes were never broadcast,
so the result is the same as below.

A **power loss** keeps each log's writes through its last flush and any prefix of the rest.
OPFS's `close()` swaps a file into place with no fsync, so a manifest or a run can be gone or
empty, with no order against the logs. So:

- A tab loses the writes it acked since its last flush. It never broadcast them, so no other
  tab's state and no ingest's cut depends on them. Each log keeps a prefix of its records, and
  the database reopens as the merge of those prefixes.
- The newest manifest may be gone or empty, which counts as missing, or list a run that never
  reached the disk. Then an older intact manifest stands in, but only while the logs still hold
  every record above its cut: reclaim removes a segment once a manifest covers it. Recovery
  checks this from the segment names: each tab's oldest segment must start at or below the cut.
  Otherwise records would be missing from the middle of the order, and recovery throws
  `CorruptDatabaseError` rather than open a state that never existed.

## Corruption is not a power loss

A power loss cannot tear a manifest, because OPFS publishes a file whole. It cannot break a log
anywhere but at the end of its last segment, because a segment is sealed and flushed before the
next one is made. So these are corruption, and the engine throws `CorruptDatabaseError` and
writes nothing:

- A manifest that is there and does not decode (bad CRC, magic or length). Only a missing or
  empty file is skipped.
- A newest manifest that lists a run that is gone, when the logs no longer hold what an older
  one would need.
- A bad frame in a segment with a later one, or a next segment that does not follow on.
- Records a tab needs that were reclaimed, with no generation that holds them (a deleted first
  segment, say).

The database stays as it is on disk, for an app or a person to recover.

## Who recovers

- `openDb`. It trusts the newest manifest, because loading the generation opens its runs anyway.
  Only the retries under the reclaim lock check the runs, where a missing run means it never
  reached the disk.
- The host, at the start of every ingest, compaction install and sweep, under the ingest lock.
  It checks a manifest's runs once and then trusts the generations it published itself. A sweep
  keeps only the committed manifest's runs. A newer manifest lists a run that is gone: nothing
  builds on it.

# Crash behavior

Each step writes new files before it points anything at them, and deletes files only after
nothing points at them. After a process crash:

| Crash after | State on reopen |
|---|---|
| Append, before the frame is in the file | The batch isn't in the log. The caller never got an ack. |
| Append written, before its flush | The record is in the log, and the reopen reads it. |
| L0 run written, before its manifest | The run is in no manifest and is garbage. The records are still in the logs. |
| Manifest written, before the log reclaim | The ingest is committed. The covered segments stay until a later ingest removes them; reads pass over their records. |
| Compaction outputs written, before install | The outputs are in no manifest. They are garbage. |
| Manifest written, before the run reclaim | Old manifests and input runs stay on disk until a later ingest or compaction removes them. |

A new host's first sweep removes every run file that the committed manifest doesn't list.

`tests/sim/crash-enum.test.ts` checks both crash models on the real code: every process crash
point, and up to thousands of power-loss states per workload, including logs that chain, seal
and are reclaimed by segment. `tests/sim/multi-handle.test.ts` checks that no acked write is
lost across tabs.

# Assumptions about the platform

- A SyncAccessHandle in the default mode is exclusive, and exists only in a dedicated
  WebWorker. Each tab's worker holds its own log files for the tab's life; no other context
  writes them. Other contexts read them with `getFile()`.
- A SyncAccessHandle `flush()` makes its writes durable. Writes not yet flushed may be lost on a
  power loss or a crash of the whole browser, and the frame CRC and `n` chain end the log at the
  first one lost.
- An OPFS `createWritable().close()` publishes the whole file atomically, and never shows a
  partial file to readers. It does not fsync.
- A SharedWorker with the same URL and name is shared by every tab of the origin. `openDb` names
  it `opfs-lsm:<name>`, so each database gets its own. If two different URLs serve one database,
  the Web Locks keep them from writing manifests at the same time.
- Web Locks are shared by the tabs and workers of an origin, and the browser releases a
  context's locks when it goes away. Liveness depends on this: a tab that died stops holding the
  watermark only once its lock is released. A tab holds `opfs-lsm-reclaim/<name>` only while it
  retries a load. The host never waits for it, so the guarantee of
  [Loading a generation under churn](#loading-a-generation-under-churn) does not depend on the
  release; only the removal of garbage does. Without Web Locks, liveness falls back to an
  in-process registry, and a retry is unprotected.
- BroadcastChannel delivers messages in order from one sender, but may deliver them late or
  drop them. A lost `rec` shows up as a gap in `n`, and a lost promise is asked for again.

# Known limits of this design

- A frozen live tab holds every other tab's watermark until its lock is released. Its own writes
  keep working, but other tabs stop seeing new writes, and `update` waits.
- Without BroadcastChannel, a second tab waits forever: promises travel only on the channel.
- Each tab keeps every live run file in memory. Tab memory grows with the size of the database.
- The leftover run of a merge can be tiny, and the planner rarely picks a tiny run on its own,
  so small runs can stay around.
- A tab sees another tab's writes only once they are stable, a flush and a message hop after
  their ack, until it calls `sync`.
