# How storage engines and browser libraries benchmark themselves

Status: shipped. The suite this survey planned is `bench/`, described in bench/README.md. Not built: per-level W-Amp, a measured Read-Amp per get, a reader racing a rate-limited writer, and size-limit or tachometer as tools.

Date: 2026-11-07, sources fetched that day. Nothing was measured. The plan was checked against `bench/` on 2026-11-24, at commit `df257487`.

## Question

How do LSM engines, browser storage libraries and CRDT libraries benchmark themselves? How do they define write, read and space amplification, and how should bundle size be measured? The answer designed a suite, from scratch, that compares kv and its adapters with the IndexedDB libraries apps use, and reports absolute kv numbers.

## What the suite took from it

bench/README.md describes each of these.

- db_bench's shape: named scenarios run in a fixed order on one database, with LevelDB's 16-byte keys and 100-byte values that compress to half. Reads run before compaction settles (`readrandom-unsettled`) and after it (`readrandom`), as LevelDB reports them.
- A cold open in fresh tabs, from RxDB's "time to first insert".
- YCSB A and F, zipfian, in `kv/ycsb-a`.
- W-Amp engine, W-Amp total, the compaction ratio, structural Read-Amp and Space-Amp, with the raw byte counters next to them. See [Byte counters for kv](#byte-counters-for-kv).
- Each baseline on its library's fast path, with its durability printed next to its numbers.
- kv against a hand-written IndexedDB store, and the Automerge and Yjs adapters against their IndexedDB adapters, replaying the LaTeX editing trace of crdt-benchmarks and automerge-perf.
- Runs interleaved across contenders, a fresh browser profile per run, the median with its min–max range, and latency percentiles pooled over runs.
- Bundle size per import row, raw, gzip and brotli, at import and after open, with the SharedWorker chunk and the `.wasm` counted.

## What the suite did not build

- Per-level W-Amp, moved bytes, and a measured Read-Amp per get (runs probed, bytes read, Bloom negatives). kv reads from memory after open, so there is no per-read disk count.
- `live_logical` by a full scan. The workload's model computes the live bytes.
- `readwhilewriting`, a reader racing a rate-limited writer. `kv/two-tabs` times a second tab that opens a held store and catches up with the first tab's writes instead.
- A second value size of 400 bytes under 20-byte keys, as in RocksDB's `benchmark.sh`. `kv/large-values` covers 8 KiB values instead.
- YCSB B to E and `overwrite` were built, then removed because another workload made the same calls. [goal-driven-benchmarks.md](goal-driven-benchmarks.md) gives each reason.
- The comparison of a `collections` package with Dexie on RxDB's operations. That package is gone. `tracker/goals` compares docstore with Dexie and SQLite on a dataset and goals instead.
- tachometer and a 95% confidence interval. `compare` runs an exact rank-sum test on the runs of two files. There are no headed spot checks and no micro-benchmark library.
- size-limit and esbuild. `pnpm bench:size` measures what Vite emits for each row.

## Amplification as the sources define it

- The RocksDB Tuning Guide defines write amplification as "the ratio of bytes written to storage versus bytes written to the database", read amplification as "the number of disk reads per query", and space amplification as "the ratio of the size of database files on disk to data size" [https://github.com/facebook/rocksdb/wiki/RocksDB-Tuning-Guide].
- RocksDB's headline W-Amp leaves the WAL out. Its compaction stats report "Cumulative WAL" apart from ingest, and a level's W-Amp is the bytes written to level N+1 over the bytes read from level N [https://github.com/facebook/rocksdb/wiki/Compaction-Stats-and-DB-Status]. `benchmark.sh` reports `w_amp` as compaction bytes over flush bytes [https://raw.githubusercontent.com/facebook/rocksdb/main/tools/benchmark.sh].
- Pebble's `WriteAmp()` divides flushed and compacted table bytes by the bytes in, and L0's bytes in are the bytes written to the WAL. `ReadAmp()` is the L0 sublevels plus the non-empty levels below L0 [https://github.com/cockroachdb/pebble/blob/master/metrics.go].
- Lim et al. (FAST '16) count the WAL once per inserted byte (`WA = 1; // mem -> log`) and leave reads out of write amplification [https://www.usenix.org/system/files/conference/fast16/fast16-papers-lim.pdf].
- Callaghan defines each amplification as the work per logical operation, and counts the redo log as a write cost that is not deferred [https://smalldatum.blogspot.com/2015/11/read-write-space-amplification-pick-2_23.html].
- Dong et al. (CIDR '17) find that LSM space amplification "is mostly determined by how much stale data is yet to be garbage-collected". With a full last level and a fanout of 10, the worst case is 1.111…. A larger level multiplier lowers space and read amplification and raises write amplification [https://www.cidrdb.org/cidr2017/papers/p82-dong-cidr17.pdf].

## Byte counters for kv

kv counts at its own I/O seams, the OPFS file layer and the IndexedDB WAL store. It does not use `navigator.storage.estimate()`, which MDN calls "not exact" because of compression, deduplication and obfuscation [https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate]. The counters are in bytes:

- `user_in`: the key and value bytes of every put and the key bytes of every delete, as `Db` accepts them. It is the same idea as RocksDB's ingest and Pebble's `WAL.BytesIn`.
- `wal_written`: the bytes of WAL records handed to IndexedDB, as kv encodes them.
- `flush_written`: the bytes of L0 SST files that ingest writes.
- `compact_written`: the bytes of SST files that compaction writes into deeper levels.
- `live_logical`: the key and value bytes of the newest version of every live key.
- `disk_bytes`: the OPFS file bytes plus the WAL still in IndexedDB. The suite has only `navigator.storage.estimate()` for the WAL part.

| Metric | Formula | Matches | Built |
|---|---|---|---|
| W-Amp engine | (flush_written + compact_written) / user_in | Pebble's `WriteAmp`, the Tuning Guide without the WAL | yes |
| W-Amp total | (wal_written + flush_written + compact_written) / user_in | Lim et al. (WAL = 1), the Tuning Guide's "bytes written to storage" | yes, with manifest bytes added |
| W-Amp per level | compact_written[L+1] / compact_read[L] | RocksDB compaction stats | no |
| Compaction ratio | compact_written / flush_written | `benchmark.sh` `w_amp` | yes |
| Read-Amp, structural | L0 runs + non-empty deeper levels | Pebble's `ReadAmp` | yes |
| Read-Amp, measured | runs probed and bytes read per get, hits and misses apart | the Tuning Guide's disk reads per query, Callaghan's work per read | no |
| Space-Amp | disk_bytes / live_logical | the Tuning Guide, Callaghan, Dong et al. | yes, over OPFS bytes only |

## Facts about other suites

- RocksDB's db_bench names its scenarios `fillseq`, `fillrandom`, `overwrite`, `fillsync` (N/100 values, synced), `readrandom`, `readseq`, `seekrandom` (a seek, then `seek_nexts` nexts), `readwhilewriting` and `deleterandom`, and runs them in order on one database. Its published runs state the hardware, the cache size and an fio baseline [https://github.com/facebook/rocksdb/wiki/Benchmarking-tools, https://github.com/facebook/rocksdb/wiki/Performance-Benchmarks].
- LevelDB prints a setup block (key bytes, value bytes and their compressed size, entries, raw and file size). It reports `readrandom` at 16.677 micros/op right after random writes and 11.602 after compaction [https://github.com/google/leveldb].
- YCSB A is 50% reads and 50% updates, B 95% reads, C reads only, D 95% reads and 5% inserts of the latest keys, E 95% scans of up to 100 keys and 5% inserts, and F 50% reads and 50% read-modify-writes. All but D are zipfian. D and E grow the database, so YCSB loads E on its own [https://github.com/brianfrankcooper/YCSB/wiki/Core-Workloads].
- Pebble reuses the YCSB letters for other mixes (its F is 100% inserts), takes value compressibility as a flag, and runs its nightly benchmarks several times on different AWS instances, with outliers dropped [https://github.com/cockroachdb/pebble/blob/master/cmd/pebble/ycsb.go, https://cockroachdb.github.io/pebble/].
- db_bench's `mixgraph` replays a model of Facebook traffic that Cao et al. (FAST '20) fit. The suite left it out as too heavy, since YCSB covers mixed traffic [https://github.com/facebook/rocksdb/wiki/RocksDB-Trace%2C-Replay%2C-Analyzer%2C-and-Workload-Generation].
- Chrome's default IndexedDB durability became `relaxed` in Chrome 121, citing 3× to 30× speedups [https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed/]. Numbers from earlier Chrome versions measured `strict`.
- Nolan Lawson measured in 2021, before Chrome 121, that a paginated `getAll()` beats a cursor over 50,000 items in Chrome (1194 to 488), Firefox (610 to 271) and Safari (4673 to 127). Relaxed durability cut one transaction per item from 10456 to 631 for 1,000 items, and barely changed one large transaction [https://nolanlawson.com/2021/08/22/speeding-up-indexeddb-reads-and-writes/]. A baseline with one transaction per put measures transaction overhead.
- Dexie's `bulkPut()` waits only for the last `onsuccess`, so it beats `put()` in a loop [https://dexie.org/docs/Table/Table.bulkPut()].
- RxDB's storage comparison gives an operation list (time to first insert, bulk and serial inserts, finds by id and by query, counts) with no browser version, run count or harness [https://rxdb.info/rx-storage-performance.html].
- SQLite's `opfs-sahpool` VFS is its fastest OPFS option and needs no COOP or COEP headers. The `opfs` VFS needs them for `SharedArrayBuffer` [https://sqlite.org/wasm/doc/trunk/persistence.md].
- `FileSystemSyncAccessHandle.flush()` persists writes, and sync access handles exist only in dedicated workers [https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle/flush].
- crdt-benchmarks B4 replays a real editing trace of 259,778 ops and reports bundle sizes, raw and gzip (Yjs 69,124 and 20,100 bytes, Automerge 1,737,571 and 604,118). It does not measure persistence [https://github.com/dmonad/crdt-benchmarks]. automerge-perf holds the same LaTeX trace as 332,702 changes [https://github.com/automerge/automerge-perf].
- y-indexeddb appends each update. Once 500 are stored, it writes the whole state and drops the older ones after a 1,000 ms debounce [https://raw.githubusercontent.com/yjs/y-indexeddb/master/src/y-indexeddb.js]. automerge-repo saves incremental chunks until they outgrow the snapshot, then compacts them into one snapshot [https://raw.githubusercontent.com/automerge/automerge-repo/main/packages/automerge-repo/src/storage/StorageSubsystem.ts]. Both are small LSMs.

## Statistics and bundle-size tools

- tachometer loads a fresh page per sample, round-robins the contenders, takes at least 50 samples, and samples until the 95% confidence interval on the difference resolves [https://github.com/google/tachometer].
- benchmark.js, tinybench and mitata loop a function in one page, which fits in-memory code only. A storage operation changes on-disk state and takes 0.1 ms to seconds.
- size-limit has `file`, `esbuild`, `webpack` and `rolldown` plugins and uses brotli by default. Its README says nothing about workers, wasm or `new URL` assets [https://github.com/ai/size-limit].
- esbuild does not bundle `new URL('./x', import.meta.url)` assets or workers. Issue #795 was open on 2026-11-07 [https://github.com/evanw/esbuild/issues/795].
- webpack 5 bundles a worker as its own chunk only when the `new URL(...)` is inline in the `new Worker` call [https://webpack.js.org/guides/web-workers/]. kv writes its SharedWorker URL and its wasm URL inline.
- Vite rewrites a static `new URL('./path', import.meta.url)` to a hashed asset URL in production [https://vite.dev/guide/assets.html].
