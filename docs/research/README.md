# Research notes

Each note answers one question and keeps the evidence for the answer: what was measured, what was tried and rejected, and the browser or prior-art facts a decision used. A note is dated evidence. It does not describe the product. [design.md](../design.md), [verification.md](../verification.md), [bench/README.md](../../bench/README.md) and the package READMEs say what the code does now.

Read the row before the note. Each row states the learning, so open a note only for its numbers or its reasons.

A note's `Status:` line starts with one of four words:

- `shipped`: the change is in the code, and the note links to the doc that describes it.
- `rejected`: tried or studied, and not adopted. The note says why.
- `open`: a proposal or a question that nothing has settled. Nothing is built.
- `reference`: facts that no single decision owns, such as a browser probe.

## kv writes and open

| Note | Status | Learning |
|---|---|---|
| [kv-wal-optimization.md](kv-wal-optimization.md) | shipped, 2026-11-08 | Reading the WAL costs per row, not per byte. One `ArrayBuffer` per batch and ranged `getAll` took a 250,000-row open from 847 to 351 ms. `getAllRecords()` gained nothing. `maxWalBytes` went to 1 MiB. |
| [conditional-write-round-trips.md](conditional-write-round-trips.md) | shipped, 2026-11-13 | Calling `commit()` early saves about 40 µs a write. Posting rows in 4 ms windows lifted kv `fillsync` from 0.69 to 0.78 of tuned IndexedDB to 0.82 to 0.94. |
| [open-path-round-trips.md](open-path-round-trips.md) | shipped, 2026-11-22 | A cold open is a chain of 0.3 to 0.9 ms browser calls. Overlapping its steps took a fresh-tab open from 4.99 to 3.78 ms. Not done: run layouts read at open, fewer folder levels, stored file handles. |
| [batch-size-caps-prior-art.md](batch-size-caps-prior-art.md) | shipped, 2026-11-11 | Embedded engines cap one write by bytes or memory, never by op count. kv dropped its 10,000-op cap and counts 256 bytes per op in a fixed 8 MiB batch limit. |
| [hot-path-profile-pass.md](hot-path-profile-pass.md) | rejected, 2026-11-24 | The memtable insert is the only hot spot left on kv writes. A keys array saved about 2% of a write for 135 gzip bytes, so it was rejected. The `sync` write tail at 200,000 issues is open. |

## kv reads

| Note | Status | Learning |
|---|---|---|
| [coalesced-page-reads.md](coalesced-page-reads.md) | shipped, 2026-11-11 | One read per span of neighbouring pages took a cold `getMany` of 3,000 random ids from 38.8 to 40.7 ms down to 12.6 to 14.6 ms. A read costs about as much as 128 to 256 KiB of extra bytes. |
| [scan-read-ahead.md](scan-read-ahead.md) | shipped, 2026-11-16 | A cold scan reads ahead in a window that doubles up to 32 pages. The read before the board opened went from 32.6 to 15.6 ms at size `large`. |
| [page-cache-size.md](page-cache-size.md) | rejected, 2026-11-23 | A 64 MiB cache made random reads at size `large` 2 to 83 times slower, for 15 to 26% less memory at peak. `cacheBytes` stays 256 MiB. |
| [worker-read-only-handles.md](worker-read-only-handles.md) | rejected, 2026-11-15 | A dedicated WebWorker with read-only sync access handles cut a page read from 160 µs to 20 µs. Only Chromium has those handles, and an open of a database with data got 2.4 to 4.8 ms slower. |

## kv compaction

| Note | Status | Learning |
|---|---|---|
| [bounded-compaction-memory.md](bounded-compaction-memory.md) | shipped, 2026-11-20 | A streaming merge under one budget, `compactionMemoryBytes`. At 32 MiB the SharedWorker's live set held at 0.81 times the budget and writes stayed as fast. Holds the prior art from other LSM engines (R1 to R10) and what is not built. Its wasm figures predate the AssemblyScript engine. |

## kv correctness

| Note | Status | Learning |
|---|---|---|
| [corruption-hardening-test-suite.md](corruption-hardening-test-suite.md) | shipped, 2026-11-08 | Ten techniques that keep corruption out of kv, each with its prior art and where it lives in the suite. Not built: a deterministic simulator, StrykerJS, coverage. Two prefix-check failures of the 2026-11-08 kill loop are still open. |

## Browsers and devices

| Note | Status | Learning |
|---|---|---|
| [opfs-worker-probes.md](opfs-worker-probes.md) | reference, 2026-11-09 | In Chrome, a busy worker's Web Lock was freed 2 to 2.7 s after `terminate()`, and a SharedWorker's read of a file being written failed. Safari kept a page in bfcache while it held a lock and a handle. |
| [android-device-run.md](android-device-run.md) | reference, 2026-11-13 | In Chromium 160 on a Pixel 4a, kv passed every proof and lost no acked write. WebView 154 has no SharedWorker. A background tab or a locked phone runs on two small cores. |

## docstore

| Note | Status | Learning |
|---|---|---|
| [derived-index-prior-art.md](derived-index-prior-art.md) | shipped, 2026-11-06 | Derive index entries above the engine, at write time, from the old row read in the same transaction, and write only the difference. Derivation inside the engine (Tarantool vinyl, Cassandra, RocksDB) was rejected. |
| [document-store-prior-art.md](document-store-prior-art.md) | shipped, 2026-11-09 | The prior art behind docstore's layout: a catalog with short ids, tuple-encoded values, one index range per query. Holds the rejected options and the lessons from the deleted `collections` package. Not built: reads inside `update`, live queries matched by key range. |

## TanStack DB

| Note | Status | Learning |
|---|---|---|
| [tanstack-backends.md](tanstack-backends.md) | reference, 2026-11-13 | A spike of one app model on three backends. opfs-lsm reached its first 50 rows in 35 to 71 ms, against 1.04 to 2.05 s on TanStack DB's SQLite and IndexedDB persistence. |
| [tanstack-db-drop-in.md](tanstack-db-drop-in.md) | open, 2026-11-23 | A drop-in for TanStack DB on docstore could keep most of the API at an estimated 15 to 20 kB gzip, against 77.5 kB. docstore lacks four things for it. Nothing is built. |

## Bench suite

| Note | Status | Learning |
|---|---|---|
| [benchmark-prior-art.md](benchmark-prior-art.md) | shipped, 2026-11-07 | How LSM engines, browser stores and CRDT libraries benchmark themselves, and the byte counters behind kv's write, read and space amplification. Not built: per-level W-Amp, a measured Read-Amp per get. |
| [goal-driven-benchmarks.md](goal-driven-benchmarks.md) | shipped, 2026-11-16 | A replayed tracker history plus goals replaced the app benchmarks, with one owning workload per access pattern, after TPC-H and LDBC. The first run showed that docstore lacked `offset` and index values. |
| [sqlite-covering-indexes.md](sqlite-covering-indexes.md) | rejected, 2026-11-24 | Covering indexes made the SQLite contender's card lists up to 1.33× faster, the sprint close 1.50× slower and the database 1.33× larger. The contender keeps plain indexes. |

## Write or change a note

- Answer one question per note. Open with the `Status:` line, then a `Date:` line with the browser, the machine, the commit and the noise, when the note has measurements.
- Keep what no other doc records: the numbers with the command that reproduces them, what was tried and rejected with the reason, a browser or prior-art fact with its source, and what was not measured.
- Cut what another doc owns. When a change ships, the doc that describes the behavior gets the description, and the note keeps a link and the evidence.
- Write the code of the note's date in the past tense. A present-tense sentence about the code goes stale without a sign.
- Change the `Status:` line and the row above in the same PR that changes the verdict. A later finding replaces the text it overturns. Do not append a dated section.
- Delete a note when its question no longer exists. Git keeps it.
- Keep each file at 20 KB or less, and keep raw runs out. `pnpm check:docs` checks the size, the status line, the row above and every relative link.

## Text that was cut

The notes were compacted on 2026-11-24. `git show df257487:docs/research/<file>` prints a file as it was before: the full surveys, `lsm-compaction-memory-prior-art.md` (now "Prior art" in bounded-compaction-memory.md), and the raw runs under `page-cache-size/`.
