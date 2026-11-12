# opfs-lsm design

--------------------------------------------------------------------------------------------------

`@opfs-lsm/kv` is an embedded key-value store for the browser. Keys and values are byte arrays.
It is a log-structured merge tree (LSM). Writes go to a write-ahead log (WAL) in IndexedDB.
Sorted, immutable SST files in the Origin Private File System (OPFS) hold the data once it has
been flushed out of the log.

Every tab of an origin can open the same database. Each tab appends to the shared log, keeps its
own memtable of the writes that are not yet in an SST, and answers reads on its main thread. One
SharedWorker, the host, turns the log into SST files and compacts them.

The design ranks its goals in this order:
1. Read and write latency.
2. Consistency. Every read sees the state after one prefix of the log.
3. Persistence. An acked write should survive, but the engine trades this away before the first
   two.

This document covers the kv engine only. The packages built on it are not described here.

All multi-byte integers are stored in little-endian order.

# Storage layout

A database named `<name>` lives in two stores:

```
IndexedDB  "opfs-lsm-wal/<name>"
  ├── wal    seq -> bytes              one record per acked batch
  └── meta   "head"            -> seq  a floor for the head, written by recovery
             "ingestedThrough" -> seq  every seq <= this is in an SST
             "generation"      -> n    the manifest tabs read
             "topGeneration"   -> n    highest manifest number recovery has seen
             "destroyedTop"    -> n    manifests numbered up to this predate a destroy

OPFS  opfs-lsm/<name>/
  ├── m/<generation, 16 digits>.mft    manifests
  ├── l0/<firstSeq>-<lastSeq>.sst      flushed runs, may overlap
  ├── l1/c<generation>.<i>.sst         compacted runs, disjoint within a level
  └── l2/...
```

* A **seq** is the position of a batch in the log. Seqs start at 1 and have no gaps, except
  where a power loss lost them from both stores. A seq is never handed out twice.
* A **run** is one SST file. A run path is written once and never rewritten, so a tab caches a
  parsed run by its path with no invalidation.
* A **generation** is one numbered manifest that lists the live runs. A manifest number never
  names two different manifests.
* The **recorded generation** is the one in `meta.generation`. Tabs read it, and not the newest
  file in `m/`.

# Write-ahead log

## WAL records

Each acked `put`, `delete`, `batch` or `update` is one record in the `wal` store. The key is the
seq. The value is one `ArrayBuffer` that holds the ops of the batch back to back:

```
| u8 type         0 = put, 1 = delete                                        |
| u32 key length                                                             |
| key                                                                        |
| u32 value length                                    (puts only)            |
| value                                               (puts only)            |
```

A row that is not an `ArrayBuffer`, or that ends inside an op, is rejected as corrupt.

## Append

`put`, `delete` and `batch` append by group commit. A tab has at most one append transaction
open. Appends that arrive while it is active join it, and appends that arrive while it commits
form the next group. A group is one `readwrite` transaction over `wal` and `meta`:

1. Read the `head` floor from `meta`.
2. `add` each record of the group, in call order, with no key. The key generator of the store
   assigns each its seq.
3. If a seq is not past the floor, abort, and each write of the group appends again on its own
   at an explicit key, `head + 1`.

The records are the only writes. A group commits or aborts as a whole, and a failed group fails
every write in it. The head, the seq of the last committed batch, is the last key in
`wal`, or the `head` floor when that is higher. Only recovery writes the floor, so step 3 aborts
only after a recovery.

A tab still running an older build reads that stored floor as the head. It does not see records
this build appends, and reloading it does not change that, because the floor stays where
recovery left it. A later `put`, `delete` or `batch` on the older build stores its new key as
the floor, and the next read then sees those records. Until then they stay in the WAL. The
older adopt and truncation delete only up to the floor, and every record appended here is past
the floor, so the older build cannot drop them. Its `update` rejects while the floor is behind,
because `appendAfter` would write `floor + 1` onto a key this build already took.

IndexedDB serializes `readwrite` transactions on the same stores, so two tabs cannot take the
same seq. An aborted transaction reverts the key generator, so committed seqs stay gapless.

`update(keys, body)` reads the tail, applies it to the memtable, runs the synchronous `body` and
adds the batch at `head + 1`, all in one transaction. It cannot conflict with another writer.

The ack is the `complete` event of the transaction, at the default IndexedDB durability. The
writes of a group are acked in seq order. A
commit survives a tab crash. It may not survive a power loss. The record joins the memtable of
the tab before the ack resolves. If its seq is not the next one, another tab appended first, and
the tab reads the tail before it resolves. At the ack, the writer sees its own write and every
earlier one.

## Reading the tail

`openDb`, `sync`, a catch-up after an append, and ingest read the same way. One transaction
reads the head and `ingestedThrough`, then every record in `(max(since, ingestedThrough), head]`,
where `since` is the `appliedThrough` of the caller. An open starts at 0, so it replays the
whole uningested WAL. `maxWalBytes` bounds that replay.

Seqs are gapless above `ingestedThrough`, so the position of a record in its range gives its
seq. A range that returns fewer records than it spans throws `wal gap`.

## Truncation

An ingest sets `ingestedThrough` and `generation` and deletes every record at or below the
*previous* `ingestedThrough`, in one transaction. The WAL therefore holds the uningested seqs
plus the seqs the last ingest folded. Recovery needs the second group when a power loss keeps
this commit and loses the new run. No read touches them.

# Memtable

Each tab holds one memtable. It holds the WAL records in `(ingestedThrough, appliedThrough]`,
where `ingestedThrough` is that of the installed generation, folded to one row per key:

```
MemRow = { key, seq, kind: "put" | "del", value? }
```

Rows are kept in key order, in chunks of 512 to 1024 rows. Records apply in seq order with no
gaps. A record that skips a seq is refused, and the tab reads the WAL tail instead. The memtable
is therefore always one exact prefix of the log. Every read depends on this.

A `view` pins the memtable without copying it. The pin copies the array of chunk references and
marks every chunk as shared. The live table copies a shared chunk before its next write to it.

When the installed generation moves forward, the memtable drops the rows that the newly ingested
seqs wrote.

## Backpressure

`bytes` is the sum over live rows of the key bytes, the value bytes and 256 bytes for the row.
`openDb({ memtableBytes })` bounds it, 16 MiB by default, with two thresholds:

| State | Entered | Effect |
|---|---|---|
| below | Under 7/8 of the limit | None. |
| requested | At 7/8 | The tab asks the host for one flush and keeps writing. |
| waiting | At the limit | A write waits for that flush before it appends. |

One flush is in flight per tab. If the flush fails, or returns without moving the generation,
the write goes on, and the tab asks again after the memtable grows by another 1/8 of the limit.
A host that cannot help does not stop writes. The thresholds are checked only on a write.

# SST file format

A run is data blocks, a bloom filter, a block index and a fixed-size footer, back to back. A
writer produces the sections in that order without knowing the key count up front. A reader
finds the footer as the last 44 bytes of the file.

```
================================== SST file ==================================
| data block 0                                                               |
| ...                                                                        |
| data block N-1                                                             |
------------------------------------------------------------------------------
| bloom bits                                                                 |
------------------------------------------------------------------------------
| index entry 0                                                              |
| ...                                                                        |
| index entry N-1                                                            |
------------------------------------------------------------------------------
| footer (44 bytes)                                                          |
==============================================================================
```

Entries are sorted by key, with one entry per key. A reader rejects a file whose sections are
not contiguous.

## Data block

```
| u32 record count                                                           |
| varint prefix length                                                       |
| prefix                                                                     |
| record 0                                                                   |
| ...                                                                        |
| record count - 1                                                           |
| u16 offset of record 4                              from the block start   |
| u16 offset of record 8                                                     |
| ...                                                                        |
```

`prefix` is the longest prefix that every key in the block shares. A key is the prefix followed
by the suffix of its record. A block with one key stores the whole key as its prefix.

`offset` entries, one per 4th record after record 0, let a reader binary-search the block. Every
record holds a whole suffix, so a reader compares any record from its offset alone.

A block ends before the record that would take its encoded size past 4 KiB. A block of one
record can be larger, and it has no offset table.

Varints are unsigned LEB128, at most 5 bytes.

With codec 1 (LZ4), each block is stored packed. Index offsets, the bloom offset and the CRC
refer to the stored bytes.

```
| u32 unpacked length                                                        |
| LZ4 block-format bytes of the block above                                  |
```

## Record

```
| u8 tag          1 = put, 2 = delete                                        |
| u64 seq         the WAL seq that wrote the key                             |
| varint suffix length                                                       |
| suffix          the key after the block prefix                             |
| varint value length                                 (puts only)            |
| value                                               (puts only)            |
```

## Index entry

One entry per data block, in block order.

```
| u32 first key length                                                       |
| first key       the smallest key of the block                              |
| u32 last key length                                                        |
| last key        the largest key of the block                               |
| u32 block offset                                    from the start of file |
| u32 block length                                                           |
```

## Footer (44 bytes)

```
<----------------------------------- 4 bytes ----------------------------------->
| entry count                                                                   |
| block count                                                                   |
| bloom offset                                                                  |
| bloom length                                                                  |
| bloom hash count                                                              |
| index offset                                                                  |
| index length                                                                  |
| codec                                                                         |
| crc32                                                                         |
| version                                                                       |
| magic                                                                         |
```

`bloom offset` is also the length of the data section.

`codec` is 0 for raw blocks and 1 for LZ4.

`crc32` is the IEEE CRC-32 of every byte before the field.

`version` must be 1. Any other version is rejected.

`magic` must be `OLST` (0x4f4c5354).

A reader also rejects a footer that names more than 32 bloom hashes, or more blocks than the
index has room for, before either sets a loop count or an allocation.

## Bloom filter

The filter uses 10 bits per key and 7 hashes, about a 1% false-positive rate. The hashes are
FNV-1a and a 32-bit mix of it, combined by double hashing.

## Compression

Runs in L2 and deeper use LZ4. L0 and L1 runs stay raw. L0 and L1 hold the recent writes, and
an LZ4 block costs a decompress on every read of it. The deeper levels hold nearly all of the
bytes.

A decoder rejects a block whose unpacked length claims more than LZ4 can produce from the
stored bytes, before it allocates.

## Reading a run

A tab holds each run of its installed generation open and reads it on demand. The first read
loads the footer, the bloom filter and the block index. Each later read loads the 32 KB page of
whole blocks that it needs. All of it lives in one page cache per tab, capped by
`openDb({ cacheBytes })`, 256 MiB by default.

A read is synchronous while its bytes are cached. Otherwise it returns a miss, and the caller
awaits the load and reads again. A point get:

1. Rejects the key if it falls outside the first and last keys of the run.
2. Rejects it if the bloom filter says no.
3. Binary-searches the block index for the one block that could hold the key.
4. Binary-searches the offset table of the block, then walks at most 4 records in place.

Tabs do not check the CRC. The host checks it when it reads a run as a compaction input.

# Manifest format

A manifest, `m/<generation>.mft`, lists the runs of one generation. Its byte layout is in
[manifest-format.md](manifest-format.md).

`through` is the seq the runs reach. The runs hold the fold of every seq up to it and no seq
past it. An ingest sets it to the last seq it folded. A compaction keeps the value of its base.

A new manifest takes a number one past the highest in use: the newest file in `m/`, the
recorded generation and `meta.topGeneration`. Numbers can skip.

# Reads

`get` reads the memtable first. On a miss, it asks the levels of the installed generation,
newest first, and stops at the first that holds the key. Each L0 run is a level of its own. A
deeper level binary-searches the key ranges of its runs and asks one run. A get touches neither
IndexedDB nor the host.

`range` merges one cursor per source with a min-heap, ordered by key and then by source, newest
first. The sources are the memtable, each L0 run, and each deeper level as a whole. For each key
the newest source wins, and tombstones are dropped. A level cursor opens one run at a time, in
key order, and only the runs the scan reaches. `reverse` returns the same keys in descending
order. Bloom filters play no part in a scan.

`range({ valueContains })` keeps the live puts whose current value holds every pattern. Each
source filters on its own, one block at a time, and only the hits are copied out. A newer source
that holds the key with a non-matching value or a tombstone drops the older hit.

A `view` pins `appliedThrough`, the installed generation and the memtable chunks. Writes that
commit during the callback are invisible to it. `rangeJoin` scans a range and point-reads one
key per entry under one such pin.

# Multi-tab coordination

## Seeing other tabs' writes

After its append commits, a tab posts `{ kind: "row", seq, record, bytes }` on the BroadcastChannel
`opfs-lsm-layers/<name>`: the WAL row it appended, and the key and value bytes of its ops. Every
other tab applies the record to its memtable. If the record does not follow the `appliedThrough`
of that tab, the tab reads the WAL tail instead.

A tab therefore sees the write of another tab a moment after its ack. `db.sync()` closes the
gap: it reads the WAL tail and applies everything acked before the call. The broadcast is an
optimization. The WAL tail is the source of truth.

## Installing a generation

A tab installs a generation only when the WAL tail tells it to, during `sync` or an append. The
installed generation never holds a seq past `appliedThrough`. If the tail names a generation the
tab has not loaded, the tab loads the manifest and opens its runs outside the transaction, then
reads the tail again.

After a flush or a compaction step, the host posts `{ kind: "ingest" }` on the channel, and
tabs call `sync`.

## Loading a generation under churn

The host removes the runs of a replaced generation once no tab holds them open, and a tab holds
a run only once its open returns. A slow tab could therefore lose every load to a newer
generation. The tab and the host share the Web Lock `opfs-lsm-reclaim/<name>` to prevent this:

* The first try of a tab takes no lock. After a try finds a file missing, every later try holds
  the lock **shared**, from the tail read to the last run open.
* The host removes files only while it holds the lock **exclusively**, and it asks with
  `ifAvailable`. When a tab holds the lock, the host skips the removal and tries on a later pass.

Under the lock, no removal can run, so the manifest and every run of the recorded generation are
on disk and the load succeeds. The host never waits for the lock, so no tab can stall a flush or
a compaction. A tab can only delay the removal of garbage.

A try that finds a file missing under the lock reconciles (see [Recovery](#recovery)). After 8
such tries the tab throws `CorruptDatabaseError`. On a healthy database, `sync`, `update` and
appends always succeed, however compaction is scheduled.

A tab skips a tail that names a generation below its installed one, unless that tail is ahead of
its memtable. A stale tail never is. A tail that is ahead comes from a recovery that recorded an
older manifest and emptied the WAL, and the tab installs that generation.

# Ingest

Ingest moves WAL records into L0 runs. It runs in the host.

## Trigger

Per database, the host keeps `pendingBytes`, the key and value bytes of the ops that are not yet
folded. Each append broadcast adds its `bytes`. When it reaches `maxWalBytes`, 1 MiB by default, the
host flushes. The limit is the smallest any open tab asked for, and each tab asks for at most
7/8 of its `memtableBytes`.

`openDb` registers the tab with the host. The host then measures the uningested records, so a
database left over the limit catches up on open. The count only decides when to flush. Every
flush reads the WAL, so a missed broadcast delays a flush and loses nothing.

After a failed flush, the host waits for another `maxWalBytes` of writes or the next open.

`ingest(db)` from `@opfs-lsm/kv/testing` flushes through the end of the log and waits for the compaction it starts.

## Flush

A flush folds the WAL as it stands when it starts, oldest records first, into one L0 run per
`flushRunBytes` of op bytes (see [Memory budget](#memory-budget)). One flush runs at a time per database. Records acked
after it starts wait for the next one.

For each run, under the exclusive section for the database, the host:

1. Reconciles (see [Recovery](#recovery)). The recorded generation is `G`, and the highest
   manifest number in use is `top`.
2. Reads the WAL records above `ingestedThrough`, oldest first, up to `flushRunBytes`. A run
   takes at least one record.
3. Folds them to the last op per key, in key order, keeping the seq of each op.
4. Writes `l0/<first>-<last>.sst`.
5. Writes manifest `top + 1` with `through = <last>`, listing the new run in front of the runs
   of manifest `G`.
6. In one IndexedDB transaction, sets `ingestedThrough = <last>`, raises `generation` to
   `top + 1` and truncates the WAL.
7. Deletes the manifests older than the recorded generation, unless a tab holds the reclaim
   lock.

The exclusive section is a promise chain in the host plus the Web Lock `opfs-lsm-ingest/<name>`,
which covers two SharedWorkers that serve the same database. A compaction install can take the
section between two runs.

OPFS files are written with `createWritable` and `close`. The browser swaps the file into place
on `close`, so a reader sees a file whole or not at all.

## L0 stop

At `l0StopRuns` L0 runs, a flush publishes nothing and waits for the next compaction step to
install. The stop is one less than the source limit of a merge, so one step can take all of L0. If the compaction
pass ends without an install, the flush publishes its run anyway. A compaction that cannot help
delays a flush by one pass and never blocks it.

# Compaction

Compaction keeps a leveled layout.

| Level | Runs | Budget |
|---|---|---|
| L0 | Overlap, newest first | 4 runs |
| L1 | Disjoint, sorted by key | 40 MiB |
| Ln | Disjoint, sorted by key | 40 MiB × 10^(n−1) |

Levels are created as they fill, with no maximum depth. Budgets count bytes on disk.

## Planning

The planner reads only the manifest. It scores each level and serves the highest score above 1.
On a tie the shallower level wins.

* L0 scores its run count over 4. Its step merges the oldest L0 runs, at most `l0StopRuns`,
  with the L1 runs whose ranges overlap them.
* A deeper level scores its bytes over its budget. Its step picks the run whose overlapping
  bytes in the next level are the smallest fraction of its own size, and merges it with those
  runs into the next level.

Scoring lets L0 pass 4 runs while a deeper level is further over budget. If L0 always went
first, L1 would never be pushed down.

A plan is `bottom` when no run below the output level overlaps the inputs. Only a bottom merge
drops tombstones.

## Merging

A step reads its inputs as sources, newest first. Each L0 run is one source. The overlapped runs
of the next level, which are disjoint, are one source together. A step has at most `maxSources`
sources.

The merge is a session that the host pumps. The session owns every offset. Each pump stops
between two keys and asks the host for one thing:

| Stop | The host |
|---|---|
| NEED | reads the listed byte ranges of the inputs and feeds them in |
| WRITE | writes the bytes to the open output run |
| RUN_END | finishes that file and records its size and key range |
| YIELD | gives the event loop a turn |
| DONE | installs the outputs |

For a key, the newest source wins. The session checks the CRC of every input run before it uses
the last entries of that run. It cuts the output into runs of about 4 MiB of records, named
`c<top + 1>.<i>`.

The memory a step holds does not depend on the size of its inputs: about one read window of
blocks per source, plus the open output block and its bloom and index rows. If any input is corrupt, or any
read or write fails, the host deletes every output and installs nothing.

## Memory budget

`openDb({ compactionMemoryBytes })`, 32 MiB by default and at least 8 MiB, is the memory the
host may spend on flushing and compacting one database. It covers the wasm heap and the run
data in flight. The host uses the smallest value any open tab passed. The other figures follow
from it:

| Budget | `flushRunBytes` | `maxSources` | `l0StopRuns` | Read window | Recycle at |
|---|---:|---:|---:|---:|---:|
| 16 MiB | 0.875 MiB | 44 | 43 | 64 KiB | 8 MiB |
| 32 MiB | 1.75 MiB | 49 | 48 | 128 KiB | 16 MiB |
| 64 MiB | 3.5 MiB | 49 | 48 | 256 KiB | 32 MiB |

Past 64 MiB only the recycle threshold grows. The budget counts live memory. Garbage that the
browser has not collected yet comes on top of it.

Merges take turns across the databases of one SharedWorker, because the wasm module holds one
merge session. A flush does not wait for a merge. It runs between the pumps of the session.

Wasm memory never shrinks. After a flush run or a compaction step, if no merge session is open
and the instance holds more than the recycle threshold, the host replaces the instance.

## Installing

The merge holds the Web Lock `opfs-lsm-compact/<name>` and its turn among merges, and not the
exclusive section, so flushes go on while it runs. A flush adds L0 runs in front of the inputs, which leaves the plan valid. To install,
under the exclusive section, the host:

1. Reconciles, and checks that every input is still in the recorded manifest `G`.
2. Writes manifest `top + 1`, with the inputs replaced by the outputs, `tombstoneSeq` raised to
   the highest dropped tombstone, and the `through` of `G`.
3. Raises `meta.generation` to `top + 1`.
4. Reclaims: deletes the older manifests, and the input runs that no tab holds open. While a tab
   holds the reclaim lock, it deletes nothing and tries again on the next pass.

A pass runs up to 8 steps. A request that arrives during a pass starts another pass.

# Destroy

`db.dangerousDestroy()` and `destroyDb(name)` empty the database. Seen from the log, a destroy
is one entry that deletes every key: the writes acked before it are gone, and the writes after
it land in the empty database. `destroyDb` does not open the database, so it also empties one
that `openDb` refuses as corrupt. The host:

1. Takes the compaction lock, then the ingest lock: the order a compaction pass takes them in.
   No flush or merge publishes while it holds them, and a merge already running stops after its
   current step.
2. Commits in one IndexedDB transaction at durability `"strict"`, which completes only once it
   is on disk. It drops every WAL record and records generation 0, with `head` and
   `ingestedThrough` one past every seq the WAL or a manifest on disk names, and
   `topGeneration` and `destroyedTop` at the highest manifest number in use.
3. Posts `{ kind: "ingest" }`. Each tab installs generation 0 at its next `sync` or append, as
   it would any generation, and its memtable drops every row. Handles stay open, and each
   reports a `gap` change event.
4. Removes every manifest, then sweeps: against generation 0, every run is retired. Both skip
   while a tab holds the reclaim lock, and the sweep skips each run a tab still holds open, as
   any sweep does. A tab holds its runs until it installs generation 0, or until a `view` that
   started before the destroy ends, and that view reads the old data meanwhile.

`dangerousDestroy` then syncs its own tab, which lets go of its runs, and asks the host for a
flush, whose compaction pass sweeps them. The runs other tabs held go at a later pass.

The transaction is the commit point. After it, recovery adopts no manifest on disk, now or
after later flushes: rule 1 needs a `through` past `head`, rule 2 keeps the recorded generation,
and rule 3 skips every manifest numbered up to `destroyedTop`. So the files are garbage whether
or not step 4 finishes. Since the commit is on disk before step 4 starts, no power loss keeps a
remove and loses the commit.

# Change events

`db.changes(listener)` reports each WAL record that a handle applies to its memtable, with its
ops, whichever path brought it: its own commit, a broadcast or a catch-up read.

* Every applied seq is announced once, in seq order, after reads can see it.
* The promise of `put`, `delete` or `batch` resolves with its seq, after its record was announced.
* `gap` replaces the records that a handle skipped because a flush folded them before it read
  them. A listener reads again.
* `ingest` says that a flush moved rows to OPFS without changing what reads return.
* `closed` is the last event.

# Recovery

Writes go to two stores, and nothing orders one against the other on disk. No OPFS `close` and no
IndexedDB commit is an fsync, except the commit of a destroy. After a power loss, each store keeps
a prefix of its own completed writes, and the two prefixes are independent. Acked writes may be lost. The database
must still open, and read the fold of one prefix of the log.

## The invariant

A manifest is **intact** when every run it lists is on disk. The write order keeps two facts
true at every prefix of each store:

1. **Every intact manifest is a log prefix.** Its runs hold the fold of exactly the seqs
   `1..through`. A run is written before any manifest lists it, and run paths are never reused.
2. **WAL records are log entries.** `head` never moves down, and recovery moves it past every
   seq that any manifest on disk names. New manifests number past `topGeneration`.

So any intact manifest, followed by the WAL records `through + 1..head` with no gap, is a log
prefix. Without those records, the manifest alone is one.

## The rule

`reconcile` picks the manifest to record:

1. **OPFS kept seqs that IndexedDB lost.** The newest intact manifest that is numbered past the
   recorded one and whose `through` is past `head`. It is a longer prefix than the WAL.
2. **Otherwise the recorded manifest**, if it is intact.
3. **Otherwise IndexedDB recorded a manifest that OPFS lost.** The newest intact manifest
   numbered past `destroyedTop`, or the empty generation 0. A manifest file that is missing or
   empty counts as lost.

In a running database only rule 2 applies. A manifest newer than the recorded one is a leftover
of a crash between a publish and its IndexedDB commit. Its seqs are still in the WAL, so it is
ignored.

## Recording a manifest

Recording is one IndexedDB transaction. It writes only if `meta` still reads what reconcile
read. It pairs the manifest with the WAL:

* If `through` is at or past `ingestedThrough`, `ingestedThrough` becomes `through`.
* If `through` is below `ingestedThrough` and the WAL holds every seq above `through`, those
  seqs are uningested again.
* Otherwise every record is dropped and `ingestedThrough` moves to the new `head`. The database
  is the manifest alone.

The same transaction moves `head` past the highest `through` of any manifest on disk, and
`topGeneration` past every manifest number seen.

## Corruption is not a power loss

OPFS publishes a file whole, and the host removes a run only after every manifest that lists it.
A power loss therefore never leaves a manifest that fails to decode, or the recorded manifest on
disk with a run missing. Those states are corruption. Recovery throws `CorruptDatabaseError` and
writes nothing, so the database stays as it is on disk.

* The recorded manifest does not decode: refuse.
* The recorded manifest lists a run that is gone: an intact manifest whose `through` is at or
  past `ingestedThrough` may stand in. Otherwise refuse.
* Rule 3 meets a manifest that does not decode before it meets an intact one: refuse.

## Who reconciles

* `openDb`, before the first sync. Every tab writes only after its open reconciled.
* `sync` and appends, when the recorded generation does not load under the reclaim lock.
* The host, at the start of every flush, compaction install and sweep, under the exclusive
  section.

# Crash behavior

Each step writes new files before anything points at them, and deletes files only after nothing
points at them.

A **process crash** keeps every completed write of both stores. Every acked write survives.

| Crash after | State on reopen |
|---|---|
| Append, before `complete` | The batch is not in the WAL. The caller got no ack. |
| L0 run written, before its manifest | The run is garbage. The records are in the WAL. |
| Manifest written, before the IndexedDB commit | The manifest is ignored. The records are in the WAL, and the next flush folds them again. |
| IndexedDB commit, before reclaim | Old manifests and runs stay until a later pass removes them. |
| Compaction outputs written, before install | The outputs are garbage. |
| Destroy's transaction, before its removes finish | The database is empty. The files left are garbage. |

The first sweep of a new host removes every run that the recorded manifest does not list.

A **power loss** keeps a prefix of the commits of IndexedDB and a prefix of the file operations
of OPFS, independently.

| IndexedDB kept | OPFS kept | Reopen |
|---|---|---|
| The commit of a flush | Not its run or manifest | Rule 3. The previous manifest is intact, and the WAL still holds the seqs that flush folded. Nothing is lost. If OPFS lost more than one flush, the WAL is dropped. |
| Not the commit of a compaction | Its manifest and its removals | Rule 3. The new manifest is intact and has the same `through`. Nothing is lost. |
| Some appends, not the flush after them | The manifest of that flush | Rule 1. `head` moves to its `through`. |
| Nothing | Some manifests | Rule 3 records the newest intact one, and `head` moves past its seqs. |
| A destroy's transaction | Any prefix of its removes and of later ops | No manifest from before the destroy is adopted. The database holds a prefix of the writes after it, or none. |
| Not a destroy's transaction | None of its removes | The commit was not on disk, so no remove had started. As if the destroy had not run. |

# Limits

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
| Append, memtable, point get, range merge, bloom checks | Tab main thread | TypeScript |
| Unpack an LZ4 block, filter a scan inside a block | Tab main thread | wasm |
| Fold the WAL into L0, encode SSTs | SharedWorker | TypeScript fold, wasm encode |
| Compaction merge, CRC check | SharedWorker | wasm session, pumped by TypeScript |

A tab reads in TypeScript so that a `get` never posts a message. The wasm module is required:
`openDb` rejects with `StorageUnavailableError` when it does not load.

# Assumptions about the platform

1. IndexedDB serializes `readwrite` transactions that share a store, across tabs and workers.
   An aborted transaction reverts the key generator of the store.
2. An OPFS `createWritable().close()` publishes the whole file atomically.
3. Each store keeps the order of its own completed writes across a power loss, so a prefix of
   them survives. Nothing orders IndexedDB against OPFS, except that an IndexedDB transaction
   at durability `"strict"` completes only once it is on disk.
4. A SharedWorker with the same URL and name is shared by every tab of the origin.
5. Web Locks are shared by the tabs and workers of an origin, and the browser releases the
   locks of a context when it goes away.
6. BroadcastChannel delivers the messages of one sender in order. Messages may arrive late or
   not at all.
