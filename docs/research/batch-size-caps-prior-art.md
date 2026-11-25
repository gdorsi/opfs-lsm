# Caps on one atomic write: prior art for kv's batch limits

Status: shipped. On 2026-11-11 kv dropped its 10,000-op cap and kept one fixed 8 MiB batch limit
that counts 256 bytes per op, as recommended here ([Limits](../design.md#limits)). design.md
still gives no reason for 8 MiB, which this note also asked for.

Date: 2026-11-11. A survey of source code and documentation fetched that day, read at each
project's default branch. Nothing was run.

## Question

kv limited a batch to 8 MiB of key plus value bytes, and to 10,000 ops until PR 180 removed the op
cap. Neither cap had a recorded reason. How do other storage engines cap one atomic write, what
reasons do they give, and which option fits kv: keep 8 MiB fixed, add a per-op charge, make the
cap configurable or derived from `compactionMemoryBytes`, split a large batch across several WAL
records, or remove the cap?

## Verdict

1. Keep the op cap removed. Firestore and TiDB did the same, and no embedded engine has one.
2. Keep one fixed byte cap, and count each op as its key bytes, its value bytes and a fixed 256
   bytes, the same figure the memtable charges per row. This is the Pebble pattern.
3. Leave the figure at 8 MiB unless a measurement says otherwise, and record the reason in
   design.md: one record must fit in a flush run at the smallest budget, and the memtable may
   overshoot by one batch.
4. Do not add an `openDb` option that can raise the cap. If a knob is wanted, make it lower-only,
   as FoundationDB does.
5. Do not split batches across records and do not remove the cap.

Items 1, 2, 4 and 5 match the code. Item 3 did not ship. On 2026-11-12 the separate 16 MiB value
limit went too, because a `put` is a batch of one op.

Evidence that would change this: a measurement showing the per-op object cost in Chrome is far
from 256 bytes (change the charge, not the design); a real workload that needs more than about
32,000 small ops in one atomic batch (then weigh a lower charge or record splitting); or a finding
that the flush fold needs much more than one record's bytes of memory at the 8 MiB budget (then
lower the cap or raise the minimum budget).

## Why a per-op charge

On 2026-11-11 the memtable charged 256 bytes per row and the batch cap charged nothing per op. With
the op cap gone, the byte cap did not bound op count in any useful way (arithmetic, not measured):
8 MiB of 4-byte-key deletes is 2,097,152 ops. That is an 18 MiB WAL record (9 bytes each), about
370 MiB of op objects per context at 185 bytes, and up to 520 MiB of memtable charge at 260 bytes
per row if the keys are distinct. With the old cap of 10,000 ops the memtable charge of one batch's
overhead was at most 2.4 MiB. A batch of deletes of the empty key counted zero bytes at any length.

At 256 bytes per op an 8 MiB cap admits at most 32,768 empty ops, three times the old op cap, and
the bound "memtable at most `memtableBytes` plus one batch" holds in the memtable's own unit.

The batch cap, not `flushRunBytes`, bounds the largest flush run: a run takes at least one record,
and 8 MiB is larger than `flushRunBytes` at every budget ([Memory
budget](../design.md#memory-budget)). Against the minimum `compactionMemoryBytes` of 8 MiB, one
maximal record equals the whole budget. That argues against raising the cap.

## Rejected options

- **A cap per `openDb`, or one derived from `compactionMemoryBytes`.** Configurable caps elsewhere
  are operator settings on one authority. In kv the log is shared: a tab that opens with a large
  cap writes a record that a host running at another tab's smaller `compactionMemoryBytes` must
  fold, and that every other tab must apply. A derived cap has the same problem, because the budget
  is the minimum over open tabs and changes as tabs come and go. A lower-only option would be safe.
- **Splitting a batch across WAL records in one IndexedDB transaction.** IndexedDB would make the
  append atomic, but kv assumes one record is one atomic batch: tabs apply the tail record by
  record, and a flush run may end after any record. A split batch needs a group marker that the
  tail reader, the fold and the flush boundary all honour. It would bound flush memory per record,
  so it is the right direction if large atomic writes are ever required. Nothing surveyed suggests
  they are. The usual answer for a write over the cap is to chunk it and hide partial work behind an
  indirection or a "building" state.
- **No cap.** kv persists a record before any tab or the host applies it, so an oversized record
  would fail every later fold and every later open: the death loop Pebble describes for RocksDB.
  Chromium would also reject the row near 127 MiB with an `UnknownError` instead of kv's
  `ConstraintError`.

## Facts from other systems

| System | What is capped | Default | Configurable | Counts per-op overhead | Path for larger writes |
|---|---|---|---|---|---|
| FoundationDB | Bytes of the commit request; time | 10,000,000 bytes; 5 s | Lower only | No. Conflict range keys are counted | Many small transactions plus an indirection |
| RocksDB | Encoded batch bytes | None | Yes, `max_bytes`, `max_write_batch_size` | Framing only | Write-unprepared flush; experimental memtable bypass |
| LevelDB | Nothing | None | No | Not applicable | Not applicable |
| Pebble | Format limit only | 4 GB | No | Yes, in the large-batch test | Flushable batch above half the memtable size |
| CockroachDB | Encoded Raft command | 64 MB | Cluster setting | Yes, encoded size | Loop over row-limited batches |
| SQLite | Statement bytes; parameter count | 1e9; 32,766 | Compile time, lower at run time | Not applicable | Cache spill |
| LMDB | Dirty pages in memory; map size | 131,071 pages | Compile time; map size at open | Yes, unit is pages | Page spill |
| Firestore | Request bytes; time | 10 MiB; 270 s | No | Yes, request encoding | Chunk. Op cap of 500 removed in 2023 |
| DynamoDB | Ops and item bytes | 100; 4 MB | No | Unconfirmed | `BatchWriteItem` loop, not atomic |
| Spanner | Commit bytes and mutations | 100 MiB; 80,000 | No | Count is per cell and per index entry | Partitioned DML, not atomic |
| TiDB | Session memory; was key-value bytes, and before v4.0 also 300,000 entries | Memory quota; was 100 MB | Yes | Yes since v6.5 | Pipelined DML; non-transactional DML |
| etcd | Ops and request bytes | 128; 1.5 MiB | Flags | Yes, request encoding | None stated |

- No embedded engine surveyed has an op-count cap. Op-count caps appear only where an op is a unit
  of metered or replicated server work (etcd, DynamoDB, Spanner), and no page read states a reason
  for one.
- Firestore removed its 500-write cap on 2023-03-29 and kept the request size and time limits
  ([release notes](https://cloud.google.com/firestore/docs/release-notes)). TiDB removed its
  300,000-entry cap in v4.0, then replaced its byte cap with a session memory quota in v6.5,
  because memory ran "two to three times or more of the transaction size"
  ([transaction overview](https://raw.githubusercontent.com/pingcap/docs/master/transaction-overview.md),
  [configuration](https://raw.githubusercontent.com/pingcap/docs/master/tidb-configuration-file.md)).
- Pebble sizes a batch by the skiplist node each entry will take in the memtable, and wraps a batch
  of at least half the memtable size in a `flushableBatch` that skips the memtable. Its notes
  describe a RocksDB process killed while applying a 1 GB batch, then killed again on every WAL
  replay ([docs/rocksdb.md](https://raw.githubusercontent.com/cockroachdb/pebble/master/docs/rocksdb.md),
  `open.go`, `batch.go`, `mem_table.go`).
- FoundationDB's `size_limit` transaction option can only lower the 10,000,000-byte limit. A
  lower value "can help prevent the client from accidentally degrading the cluster's performance"
  ([fdb.options](https://raw.githubusercontent.com/apple/foundationdb/main/fdbclient/vexillographer/fdb.options),
  [known limitations](https://raw.githubusercontent.com/apple/foundationdb/main/documentation/sphinx/source/known-limitations.rst)).
- Chromium refuses one IndexedDB `put` near 127 MiB, from the 128 MB IPC message size less 1 MB,
  and stores values over 64 KiB (`kIDBWrapThreshold`) as blobs
  ([indexeddb.mojom](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/public/mojom/indexeddb/indexeddb.mojom)).
  Firefox refuses near 255 MiB, also from its IPC message size
  ([IndexedDatabaseManager.cpp](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/indexedDB/IndexedDatabaseManager.cpp)).
  The [IndexedDB specification](https://raw.githubusercontent.com/w3c/IndexedDB/main/index.bs)
  sets no size limit and names only `QuotaExceededError`. So IndexedDB
  does not force kv's 8 MiB, which sits 16 times under the tightest per-value limit found.

## Not verified

- The per-op object cost in Chrome. 256 bytes is an estimate. The 185 bytes per op object came from
  a Node measurement in the task brief and was not re-measured.
- Any per-transaction size limit in IndexedDB. None was found in the Chromium renderer files or the
  Firefox files read. The browser-side back ends and Chromium's SQLite back end were not read.
- That Chromium's 64 KiB wrap applies to a bare `ArrayBuffer` value. The threshold is confirmed and
  the path was not traced.
- Any engine-level size limit on a `BroadcastChannel` message. The HTML standard states none.
- WebKit's per-value limit. Only a quota check was found.
