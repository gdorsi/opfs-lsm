# Benchmark prior art for a new suite

Question: how do LSM engines, browser storage libraries and CRDT libraries benchmark themselves, how do they define write, read and space amplification, and how should bundle size be measured? The goal is a from-scratch suite that compares kv and collections against Dexie, raw IndexedDB, y-indexeddb and Automerge's IndexedDB adapter, and reports absolute kv numbers.

Conventions as in the other research notes. **[E]** external fact, cited with the owner's URL. **[R]** repo fact, cited by path. **[I]** my inference. Fetched 2026-11-07.

Not verified (fetch failed or not attempted): Dostoevsky and Monkey papers (403), Badger and LMDB benchmark write-ups (redirect / TLS error), Pebble's `bench` package internals, mixgraph run on real hardware. Nothing here was measured in this checkout.

---

## 0. Answer in ten lines

1. Copy db_bench's shape: named scenarios (`fillseq`, `fillrandom`, `overwrite`, `readrandom`, `readseq`, `seekrandom`, `readwhilewriting`) run in a fixed order against one database, each reporting ops/sec, micros/op and p50/p99/p99.9/max [E: RocksDB benchmark.sh header].
2. State the setup line like LevelDB does: key bytes, value bytes, entries, raw size, file size, compression ratio of the values [E: leveldb README].
3. Report reads twice: right after the writes and after compaction has settled. LevelDB shows a 1.4x readrandom gap between the two [E: leveldb README].
4. Add YCSB A, B, C, D, E, F with zipfian (A, B, C, E, F) and latest (D) request distributions for mixed workloads [E: YCSB Core Workloads, workload files].
5. Write amplification: count bytes, not ops. Report two numbers: **W-Amp(engine)** = (flush + compaction bytes written) / user bytes, as Pebble's per-level code does, and **W-Amp(total)** = (WAL + flush + compaction bytes) / user bytes, as Lim et al. model it (WAL contributes 1) [E: Pebble metrics.go; Lim FAST'16].
6. Space amplification = bytes on disk / logical live bytes [E: RocksDB Tuning Guide]. Read amplification = runs (sources) consulted per point get, plus bytes read per get [E: Pebble ReadAmp; RocksDB Tuning Guide].
7. Browser baselines must use each library's fast path (bulk ops, one transaction per batch, `getAll` pages) and state durability: Chrome defaults to `relaxed` since 121 [E: Chrome blog]. Older numbers (Nolan Lawson 2021) predate that change.
8. Compare at the library boundary the user sees: collections vs Dexie, Automerge-repo `StorageAdapter` on kv vs `IndexedDBStorageAdapter`, Yjs persistence on kv vs y-indexeddb, kv vs a hand-written IndexedDB key-value store doing the same ops.
9. Bundle size: esbuild cannot follow `new URL(..., import.meta.url)` (issue #795 still open), webpack 5 can [E]. Measure the main entry with size-limit (`import`, brotli) and list the SharedWorker bundle and the `.wasm` as separate rows with `@size-limit/file`, plus a total.
10. Statistics: interleave the contenders round-robin, fresh page per sample, report median and a range or 95% CI, as tachometer does [E: tachometer README].

---

## 1. LSM benchmark prior art

### 1.1 RocksDB db_bench and benchmark.sh

- db_bench benchmark names [E: https://github.com/facebook/rocksdb/wiki/Benchmarking-tools]:
  - `fillseq`: "write N values in sequential key order in async mode".
  - `fillrandom`: "write N values in random key order in async mode".
  - `overwrite`: "overwrite N values in random key order in async mode".
  - `fillsync`: "write N/100 values in random key order in sync mode".
  - `readrandom`: "read N times in random order". `readseq`: "read N times sequentially".
  - `seekrandom`: "N random seeks, call Next seek_nexts times per seek".
  - `readwhilewriting`: "1 writer, N threads doing random reads". `readrandomwriterandom`: mixed threads.
  - `deleterandom`: "delete N keys in random order".
  - The page suggests running `readrandom` with `--use_existing_db` after `fillseq`, and `--statistics` with a `stats` pseudo-benchmark for more detail.
- `benchmark.sh` jobs include `bulkload`, `fillseq_disable_wal`, `fillseq_enable_wal`, `overwrite`, `updaterandom`, `readrandom`, `multireadrandom`, `fwdrange`, `revrange`, `readwhilewriting`, `fwdrangewhilewriting`, `waitforcompaction`, among others. Defaults: `KEY_SIZE` 20, `VALUE_SIZE` 400, block cache 16 GB [E: https://raw.githubusercontent.com/facebook/rocksdb/main/tools/benchmark.sh].
- `report.tsv` columns, quoted from the script header [E: same]: `ops_sec`, `mb_sec` ("ops_sec * size-of-operation-in-MB"), `lsm_sz`, `c_wgb` ("GB written by compaction"), `w_amp` ("bytes written by compaction / bytes written by memtable flush"), `c_wsecs`, `c_csecs`, `usec_op`, `p50`, `p99`, `p99.9`, `p99.99`, `pmax`, `stall%`, `Nstall`, `u_cpu`, `s_cpu`, `rss`, `test`, `date`, `version`, `githash`.
- The published "Performance Benchmarks" sequence [E: https://github.com/facebook/rocksdb/wiki/Performance-Benchmarks]: bulkload (random order, empty DB) → readrandom → multireadrandom → fwdrange → revrange → overwrite → readwhilewriting → fwdrangewhilewriting → revrangewhilewriting. All run against the same database in order. Whilewriting tests rate-limit the writer (`MB_WRITE_PER_SEC=2`). Reports ops/sec, MB/s, usec/op, p50/p75/p99/p99.9/p99.99; bulkload adds stall time and `du -s -k`; overwrite and whilewriting add W-Amp. Hardware, kernel, filesystem and an fio baseline are stated.
- **mixgraph** models Facebook production traffic (Cao et al., FAST'20): key-range hotness (two-term exponential), per-key power law, value sizes and scan lengths from a Generalized Pareto Distribution, a Get/Put/Seek mix, and a sine-shaped QPS curve. The example ZippyDB-like run is 85% Get, 14% Put, 1% Seek, 48-byte keys [E: https://github.com/facebook/rocksdb/wiki/RocksDB-Trace%2C-Replay%2C-Analyzer%2C-and-Workload-Generation]. [I] Too heavy for us; YCSB covers mixed traffic.

### 1.2 LevelDB db_bench and its numbers format

[E: https://github.com/google/leveldb, "Performance"]

- Setup block printed before results: version, date, CPU, `Keys: 16 bytes each`, `Values: 100 bytes each (50 bytes after compression)`, `Entries: 1000000`, `Raw Size: 110.6 MB (estimated)`, `File Size: 62.9 MB (estimated)`.
- One line per benchmark: `fillseq : 1.765 micros/op; 62.7 MB/s`, `fillsync : 268.409 micros/op; 0.4 MB/s (10000 ops)`, `fillrandom : 2.460 micros/op`, `overwrite : 2.380 micros/op`.
- Reads reported three ways: right after random writes (`readrandom` 16.677 micros/op), after compaction (11.602), and with a cache large enough for uncompressed blocks (9.775 before, 5.215 after compaction). `readseq` and `readreverse` are reported in MB/s.
- `fillsync` "flushes data from the operating system to the disk after every operation"; the other fills leave data in the OS buffer cache. So sync and async writes are separate scenarios.

### 1.3 YCSB core workloads

[E: https://github.com/brianfrankcooper/YCSB/wiki/Core-Workloads, workload files under https://github.com/brianfrankcooper/YCSB/tree/master/workloads (mixes and distributions read from `workloada`…`workloadf`)]

| Workload | Mix | Distribution | Example |
|---|---|---|---|
| A update heavy | 50 read / 50 update | zipfian | session store |
| B read mostly | 95 read / 5 update | zipfian | photo tagging |
| C read only | 100 read | zipfian | profile cache |
| D read latest | 95 read / 5 insert | latest | status updates |
| E short ranges | 95 scan / 5 insert | zipfian (scan length uniform, max 100) | threaded conversations |
| F read-modify-write | 50 read / 50 RMW | zipfian | user database |

- Template defaults: `recordcount` 1,000,000, `operationcount` 3,000,000, 10 fields of 100 bytes, `requestdistribution` zipfian (alternatives uniform, latest; hotspot via `hotspotdatafraction=0.2`, `hotspotopnfraction=0.8`), `insertorder` hashed [E: https://github.com/brianfrankcooper/YCSB/blob/master/workloads/workload_template]. Workload D's file: `readproportion=0.95`, `insertproportion=0.05`, `requestdistribution=latest` [E: https://github.com/brianfrankcooper/YCSB/blob/master/workloads/workloadd].
- Recommended order: load with A, run A, B, C, F, D, then wipe, load E, run E, because D and E grow the database [E: Core Workloads wiki].

### 1.4 Pebble

- `pebble bench ycsb` takes `--workload` as a letter or a weight list such as `read=50,update=50`; its letters differ from YCSB: D is "95% reads / 5% inserts", E "95% scans / 5% inserts", F "100% inserts". Flags: `--keys` (latest, uniform, zipf), `--values` (size range with optional `/<target-compression>`, default 1.0 = incompressible), `--batch`, `--scans`, `--initial-keys`, `--num-ops` [E: https://github.com/cockroachdb/pebble/blob/master/cmd/pebble/ycsb.go].
- Nightly benchmarks chart, per YCSB workload, ops/sec plus Bytes Read, Bytes Written, Read Amp and Write Amp. They run each benchmark several times on different AWS instances and exclude outliers because of instance-to-instance variance. A separate `pebble bench write` raises load until an L0-sublevel / L0-file / stall heuristic fails, giving a sustainable write throughput [E: https://cockroachdb.github.io/pebble/].
- [I] Two lessons: name the deviation when you reuse YCSB letters, and state value compressibility, since it changes both throughput and space numbers.

---

## 2. Amplification definitions

### 2.1 What the sources say

- **RocksDB Tuning Guide** [E: https://github.com/facebook/rocksdb/wiki/RocksDB-Tuning-Guide]: "Write amplification is the ratio of bytes written to storage versus bytes written to the database" (10 MB/s in, 30 MB/s to disk → 3). "Read amplification is the number of disk reads per query." "Space amplification is the ratio of the size of database files on disk to data size."
- **Mark Callaghan** [E: https://smalldatum.blogspot.com/2015/11/read-write-space-amplification-pick-2_23.html]: read-amp is "the amount of work done per logical read operation" (key comparisons in memory; bytes and seeks on storage); write-amp is "the amount of work done per write operation"; space-amp is "the ratio of the size of the database to the size of the data in the database". He notes the redo log is a non-deferred write cost.
- **RocksDB compaction stats** [E: https://github.com/facebook/rocksdb/wiki/Compaction-Stats-and-DB-Status]: per level, `Read(GB)` = Rn + Rnp1, `Write(GB)`, `Wnew(GB)` = written to N+1 minus read from N+1, `Moved(GB)` (trivial move, manifest only), `W-Amp` = bytes written to N+1 / bytes read from N. "Cumulative writes … ingest" is "total bytes written into DB (not counting compactions)"; "Cumulative WAL" reports GB written to the WAL separately. benchmark.sh's `w_amp` is compaction bytes / flush bytes [E: benchmark.sh]. So RocksDB's headline W-Amp excludes the WAL.
- **Pebble** [E: https://github.com/cockroachdb/pebble/blob/master/metrics.go]: `LevelMetrics.WriteAmp()` = (TablesFlushed + TablesCompacted + blob flushed + blob compacted bytes) / `TableBytesIn`; for L0, `TableBytesIn` "is the bytes written to the WAL". `Metrics.Total()` passes `WAL.BytesWritten` into the total row; WAL logical bytes (`BytesIn`) and physical bytes (`BytesWritten`) are separate counters. `ReadAmp()` = "number of sublevels in L0 + the number of non-empty levels below L0".
- **Lim, Andersen, Kaminsky, FAST'16** [E: https://www.usenix.org/system/files/conference/fast16/fast16-papers-lim.pdf]: "Write amplification (WA) is the expected amount of data written to disk or flash per insert." They exclude reads from WA on purpose. Their LevelDB estimator starts `WA = 1; // mem -> log`, i.e. the WAL counts once per inserted byte, then adds level-0 and per-level merges. They also show WA and insert throughput are inversely related (1 kB items, uniform vs Zipf, 3 runs each).
- **Dong et al., CIDR'17 "Optimizing Space Amplification in RocksDB"** [E: https://www.cidrdb.org/cidr2017/papers/p82-dong-cidr17.pdf]: LSM space amp "is mostly determined by how much stale data is yet to be garbage-collected"; with a full last level and 10x fanout, worst case is 1.111…; with fixed level targets it can exceed 2; dynamic level sizing keeps it under 1.111…. A larger level multiplier lowers space and read amp and raises write amp. They measured write volume with iostat and had to correct for TRIM.

### 2.2 Byte-counter definitions for kv [I]

Count at our own I/O seams (the OPFS file layer and the IndexedDB WAL store), not with `navigator.storage.estimate()`, which MDN says is "not exact" because of compression, deduplication and obfuscation [E: https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate]. [R] The WAL is in IndexedDB (`packages/kv/src/idb/wal.ts`) and SSTs are OPFS files, so two counter families are needed.

Counters, all in bytes, reset at the start of a scenario:

- `user_in`: sum of `key.length + value.length` for every put, `key.length` for every delete, as accepted by `Db` (logical bytes). Same idea as RocksDB "ingest" and Pebble `WAL.BytesIn`.
- `wal_written`: bytes of WAL records handed to IndexedDB (encoded record size, as we serialize it).
- `flush_written`: bytes of L0 SST files written by ingest.
- `compact_written[level]`: bytes of SST files written by compaction into each level; `compact_read[level]`: bytes read from input runs.
- `moved[level]`: bytes of runs relinked without rewrite (count, do not add to written).
- `get_bytes_read`, `get_runs_probed`, `get_bloom_negative`: per point get.
- `live_logical`: sum of key+value bytes of the newest non-deleted version of every key (computed by a full scan at the end of the scenario).
- `disk_bytes`: sum of OPFS SST file sizes + WAL bytes still in IndexedDB (not yet ingested) + manifest/meta files.

Derived metrics:

| Metric | Formula | Matches |
|---|---|---|
| W-Amp engine | (flush_written + Σ compact_written) / user_in | Pebble per-level WriteAmp numerator; Tuning Guide definition without WAL |
| W-Amp total | (wal_written + flush_written + Σ compact_written) / user_in | Lim et al. (WAL = 1) and the Tuning Guide's "bytes written to storage" |
| W-Amp per level | compact_written[L+1] / compact_read_from[L] | RocksDB compaction-stats W-Amp |
| Compaction ratio | Σ compact_written / flush_written | benchmark.sh `w_amp` |
| Read-Amp (structural) | L0 runs + non-empty deeper levels at end of scenario | Pebble ReadAmp |
| Read-Amp (measured) | mean `get_runs_probed` and `get_bytes_read` per get, split hit/miss | Tuning Guide "disk reads per query", Callaghan "work per read" |
| Space-Amp | disk_bytes / live_logical | Tuning Guide, Callaghan, CIDR'17 |

Report `user_in`, all raw counters, and compression state (L2 is LZ4) next to the ratios, so a reader can recompute them. [I] Space-Amp below 1 is expected at L2 because of LZ4; LevelDB's setup line already reports raw vs file size for this reason [E: leveldb README].

---

## 3. Browser storage benchmark prior art

### 3.1 IndexedDB performance and pitfalls

- **Durability.** `durability: "strict"` waits for persistent storage; `"relaxed"` commits once changes reach the OS; `"default"` is the browser default [E: https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction]. Chrome changed its default from strict to relaxed in Chrome 121, citing 3x to 30x speedups and alignment with Firefox and Safari [E: https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed/, https://groups.google.com/a/chromium.org/g/blink-dev/c/3jyazaUTJfQ].
- **Nolan Lawson, 2021** [E: https://nolanlawson.com/2021/08/22/speeding-up-indexeddb-reads-and-writes/]: paginated `getAll()`/`getAllKeys()` vs a cursor over 50,000 items: Chrome 1194 → 488 (batch 1000), Firefox 610 → 271, Safari 4673 → 127. Relaxed durability barely helped one big transaction (7172 → 6970 in Chrome) but helped one-transaction-per-item a lot (10456 → 631 for 1000 items). Explicit `commit()` gave a negligible gain. Main advice: use fewer transactions. [I] These numbers predate Chrome 121's default change, so "default" then meant strict.
- **Dexie.** Group operations in a transaction, which performs "less costly operations in total"; do not await non-Dexie async work inside a transaction or it commits early [E: https://dexie.org/docs/Tutorial/Best-Practices]. `bulkPut()` "is faster than doing put() in a loop" because it only waits for the last `onsuccess` [E: https://dexie.org/docs/Table/Table.bulkPut()].
- [I] So each IndexedDB baseline needs: one transaction per batch, bulk methods, `getAll` with a page size for scans, and an explicit durability label. A baseline that does one transaction per put measures transaction overhead, not storage.

### 3.2 RxDB storage comparison

[E: https://rxdb.info/rx-storage-performance.html]

- Browser storages: OPFS (dedicated WebWorker), OPFS (main thread), IndexedDB, Dexie.js, Memory. Node: filesystem, `node:sqlite`, memory.
- Operations: time to first insert (from database creation), insert 500 docs bulk, find 3000 by id (one call), insert 50 serial, find 50 by id serial, find 3000 by query, find 3000 by query as 4 parallel queries, count 3000 four times in parallel.
- Example: IndexedDB bulk insert 500 = 9.67 ms vs Dexie 73.92 ms; find 3000 by id IndexedDB 67.7 vs OPFS (worker) 24.5.
- The page does not state browser version, headless mode, run count or the harness source, and tells readers to measure themselves. [I] Useful as an op list (especially time-to-first-insert and serial vs bulk); not as a methodology.

### 3.3 SQLite on the web

- **absurd-sql** (James Long, Aug 2021) persisted SQLite pages into IndexedDB and claimed up to 10x faster than raw IndexedDB; benchmark code in the repo's `src/examples/bench` [E: https://jlongster.com/future-sql-web, page 404 on fetch; claim seen via search snippet and https://npmjs.com/package/absurd-sql]. Not verified in full.
- **sqlite.org OPFS notes** [E: https://sqlite.org/wasm/doc/trunk/persistence.md]: `opfs-sahpool` is "Easily the highest OPFS performance of the options"; the gap shows in batch work, not single interactions. Eagerly releasing locks costs "up to 400% run time increase in I/O-heavy benchmarks". The `opfs` VFS needs COOP/COEP for `SharedArrayBuffer`; SAHPool does not. Concurrency limit is "unknown"; 8 to 10 concurrent workers reported.
- **wa-sqlite** ships a browser benchmark page comparing IDBBatchAtomicVFS, IDBMirrorVFS, AccessHandlePoolVFS, OPFSCoopSyncVFS, OPFSAdaptiveVFS and OPFSWriteAheadVFS, and says to run it in a desktop browser; the README does not describe the tests [E: https://github.com/rhashimoto/wa-sqlite].
- **PGlite** benchmarks: 12 round-trip CRUD tests (insert/select/update/delete on small, 1 kB and 10 kB rows) plus a 16-test port of SQLite's speedtest "adapted for the wa-sqlite benchmarks"; storages memory, IndexedDB, OPFS AHP, some with relaxed durability; M2 MacBook Air; reports averages; run count not stated [E: https://pglite.dev/benchmarks]. Size claim "under 3MB Gzipped" [E: https://pglite.dev/].
- **OPFS flush.** `FileSystemSyncAccessHandle.flush()` persists writes; MDN says you only need it if changes must be on disk at a specific time; sync access handles are dedicated-WebWorker only [E: https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle/flush]. [I] So "durable" for kv must say whether each scenario's timing includes `flush()` and the IndexedDB commit of the WAL.

### 3.4 CRDT benchmarks

- **dmonad/crdt-benchmarks** [E: https://github.com/dmonad/crdt-benchmarks]: B1 no conflicts (append, prepend, random insert/delete on text and arrays), B2 two users with conflicts, B3 about √N clients, B4 a real editing trace (259,778 ops, 104,852 final characters), B4×100. Metrics: time, avg/total update size, encoded doc size, encodeTime, parseTime, memUsed (GC then heap delta; can be negative; excludes wasm memory), bundle size raw and gzipped (Yjs 69,124 / 20,100 bytes; Automerge 1,737,571 / 604,118). Node 20.5, i5-8400; also runs in browser and Bun. Persistence is not measured.
- **automerge-perf** [E: https://github.com/automerge/automerge-perf]: the same LaTeX editing trace (332,702 changes incl. cursor moves; about 260k insert/delete) with a plain-array baseline and an Automerge replay. I found no separate "benchmark battery" repo.
- **y-indexeddb storage pattern** [E: https://raw.githubusercontent.com/yjs/y-indexeddb/master/src/y-indexeddb.js]: each Yjs update is appended with `addAutoKey`; when the stored update count reaches `PREFERRED_TRIM_SIZE = 500`, a debounced (1000 ms `_storeTimeout`) trim writes `encodeStateAsUpdate(doc)` and drops older entries.
- **automerge-repo storage pattern** [E: https://raw.githubusercontent.com/automerge/automerge-repo/main/packages/automerge-repo/src/storage/StorageSubsystem.ts]: chunks keyed `[documentId, "snapshot" | "incremental", hash]`; load does `loadRange` for snapshots then incrementals; it saves incrementals "until the incremental size is greater than the snapshot size", then compacts to one snapshot and `removeRange`s the rest. The adapter interface is designed for "any key/value store that supports range queries" [E: https://automerge.org/docs/reference/repositories/storage/].
- [I] Both persistence layers are themselves small LSMs (append, then compact). Benchmark them with the B4 trace replayed through the persistence layer: time to persist the trace, bytes written (W-Amp vs final doc size), cold load time, and on-disk size.

### 3.5 Cold, warm and headless

- tachometer loads each benchmark page fresh in Chrome, round-robins between contenders, takes at least 50 samples each, keeps sampling until the 95% CI on the difference is clear (3-minute default timeout), and can run Chrome headless [E: https://github.com/google/tachometer].
- [I] "Cold" in a browser means a new page (new JS heap, no in-memory caches, no warm IndexedDB connection) over existing on-disk data. We cannot drop the OS page cache from a page, so call it "cold page, warm OS" and say so, as RocksDB states cache size and state [E: Performance Benchmarks wiki].

---

## 4. Bundle size

- **size-limit** [E: https://github.com/ai/size-limit]: plugins `file` (size of files, Brotli by default, Gzip or none optional), `esbuild`, `webpack`, `rolldown` (bundle into an empty project so dependency and polyfill cost counts), `time` (headless Chrome run time). `preset-small-lib` = rolldown + file; `preset-big-lib` = webpack + file + time. Config: `path`, `import` (`"{ x }"` measures a tree-shaken named import, `"*"` everything), `limit`, `gzip`, `brotli: false`, `ignore`, `modifyEsbuildConfig`/`modifyWebpackConfig`. `--why` via `*-why` plugins (esbuild-why writes an HTML report). The README says nothing about workers, wasm or `new URL` assets.
- **esbuild** has a metafile (inputs, outputs, `bytesInOutput` per input per output) and `analyzeMetafile`; the docs point to the online Bundle Size Analyzer for metafiles [E: https://esbuild.github.io/api/#metafile]. esbuild does not bundle `new URL('./x', import.meta.url)` assets or workers: issue #795 is still open [E: https://github.com/evanw/esbuild/issues/795]. So size-limit's esbuild plugin would miss our worker and wasm.
- **webpack 5** bundles `new Worker(new URL("./worker.js", import.meta.url))` as a separate chunk without a loader, but only when the `new URL` is inline in the constructor call [E: https://webpack.js.org/guides/web-workers/]. `new URL('./file', import.meta.url)` alone creates an asset module and needs no rule [E: https://webpack.js.org/guides/asset-modules/]. [R] kv builds the worker URL in a helper (`packages/kv/src/db.ts:239`) and the wasm URL in `store/engine.ts:32`; [I] webpack will emit the wasm asset but likely will not treat a SharedWorker URL returned from a helper as a worker entry.
- **Vite** rewrites static `new URL('./path', import.meta.url)` to hashed asset URLs in production; documented worker chunking is for `?worker` / `?sharedworker` imports [E: https://vite.dev/guide/assets.html].
- **How others report.** crdt-benchmarks lists raw and gzipped bundle bytes per library without stating the bundler [E: crdt-benchmarks README]. PGlite states one gzipped total for the wasm build [E: pglite.dev]. sqlite-wasm's README gives no sizes and needs `optimizeDeps.exclude` in Vite [E: https://github.com/sqlite/sqlite-wasm].

### Recommendation [I]

Three rows plus a total, each raw, gzip and brotli:

1. **Main entry, tree-shaken**: size-limit with `@size-limit/esbuild` (or rolldown preset), `import: "{ openDb }"` and one row per realistic import set (`kv`, `collections`). This is the JS cost a user pays on the main thread. Mark the worker and wasm URLs external / ignored here so they are not double-counted.
2. **SharedWorker script**: bundle `@opfs-lsm/kv/shared-worker` (the existing export) as its own entry with esbuild and measure with `@size-limit/file`. It loads in parallel but it is real download.
3. **wasm**: `@size-limit/file` on `engine_wasm_bg.wasm`. Brotli is the right default because servers usually serve wasm compressed; also report raw because wasm compile time scales with raw size.
4. **Total first-load bytes** = 1 + 2 + 3, brotli.

Cross-check once with a webpack 5 or Vite build of `examples/todo` and read the emitted file sizes, to catch anything the hand-split misses. Keep the esbuild metafile as a CI artefact for `--why`.

---

## 5. Statistical method

- **benchmark.js** reports mean, deviation, variance, sem, moe, rme and the raw sample, with `minSamples`, `maxTime` and `minTime` controlling sampling [E: https://benchmarkjs.com/docs]. (Archived; mean-and-rme style.)
- **tinybench** uses `performance.now()` by default (pluggable `timestampProvider`), runs each task until both a time budget and a minimum iteration count are met, has `warmupTime`/`warmupIterations`, and reports mean, median, rme, mad, percentiles [E: https://github.com/tinylibs/tinybench].
- **mitata** runs GC once after each warmup (`gc: 'once'` default, `'inner'` before each iteration) where the runtime exposes it, reports avg, min, max, p75, p99, guards dead-code elimination with `do_not_optimize` and flags suspected DCE [E: https://github.com/evanwashere/mitata].
- **tachometer**: interleaved round-robin across contenders, fresh page per sample, ≥50 samples, 95% CI on percent difference, auto-sample until resolved [E: https://github.com/google/tachometer].
- **Pebble nightly**: several runs on different machines, outliers excluded [E: https://cockroachdb.github.io/pebble/]. **Lim et al.**: 3 runs per configuration [E: FAST'16 PDF].

[I] Storage operations here take 0.1 ms to seconds and change on-disk state, so micro-benchmark loops (tinybench, mitata) fit only in-memory paths (codec, memtable, bloom). For storage scenarios: one scenario = one fresh page and fresh database; per-op latencies recorded into a histogram; repeat the scenario N ≥ 5 times per contender, interleaved (A B C A B C …) to spread thermal and background noise; report median of the per-run throughput with min-max range, and pooled p50/p99/p99.9/max for latency. Warm up with a fixed op count that is excluded from timing, and say whether the warmup ran before or after the fill.

---

## 6. Implications for our suite

### 6.1 Setup line (every report)

`browser + version, headless?, OS, CPU, key bytes, value bytes (and compressibility), entries, raw MB, on-disk MB, durability mode per contender, runs per scenario`. Modelled on LevelDB's header and RocksDB's environment block [E: leveldb README; Performance Benchmarks wiki]. Defaults [I]: 16-byte keys, 100-byte values compressible to about half (LevelDB) and 20/400 (benchmark.sh) as a second size; 100k and 1M entries.

### 6.2 kv scenarios (absolute numbers)

Run in this order on one database per run, as RocksDB does [E: Performance Benchmarks wiki]:

| Name | What | Report |
|---|---|---|
| `fillseq` | N puts, ascending keys, batched (state batch size) | ops/s, MB/s, W-Amp engine/total, Space-Amp |
| `fillrandom` | N puts, random order, fresh db | same |
| `fillsync` | N/100 puts, each awaited to durable ack | micros/op, p50/p99 |
| `overwrite` | N random puts over existing keys | ops/s, W-Amp per level, compaction ratio |
| `readrandom_pre` | random gets of existing keys right after writes | micros/op, p50/p99/p99.9, runs probed, bytes read |
| `waitforcompaction` | settle; not timed | structural Read-Amp, Space-Amp |
| `readrandom` | random gets after compaction | as above |
| `readmissing` | gets for absent keys | micros/op, bloom negative rate |
| `readseq` | full forward scan | MB/s, rows/s |
| `seekrandom` | random seek + `seek_nexts` (10, 100) nexts | micros/op |
| `deleterandom` | delete N/10 random keys, then settle | W-Amp, Space-Amp before and after |
| `readwhilewriting` | 1 writer (rate-limited) + readers in a second tab via the SharedWorker | reader p99, writer ops/s |
| `coldopen` | new page, open existing db, first get | ms to open, ms to first get |
| `ycsb_a`…`ycsb_f` | YCSB mixes, zipfian (A,B,C,E,F) / latest (D); our F is read-modify-write as in YCSB, not Pebble's | ops/s, p50/p99 per op type |

`coldopen` comes from RxDB's "time to first insert" [E: rxdb.info]; `readwhilewriting` exercises the multi-tab host [I].

### 6.3 Amplification to implement

Implement the counters and formulas in section 2.2. Headline pair: **W-Amp engine** (comparable to Pebble/RocksDB) and **W-Amp total** (includes the IndexedDB WAL, comparable to Lim et al.). Plus per-level W-Amp, compaction ratio, structural and measured Read-Amp (hit vs miss), and Space-Amp with LZ4 state. Print raw counters too.

### 6.4 Comparison matrix

Each pair does the same logical work with each library's documented fast path, same durability label (default; strict as a second column where the library allows), same data.

| Ours | Baseline | Scenarios |
|---|---|---|
| kv | raw IndexedDB KV (one object store, one tx per batch, `getAll` pages for scans) | fillseq, fillrandom, overwrite, readrandom, readmissing, readseq, seekrandom, coldopen, disk bytes |
| collections | Dexie (`bulkPut`, `where().between()`, compound index, `count`) | RxDB-style ops: first insert, bulk insert 500, serial insert 50, find 3000 by id bulk and serial, query by index 3000, count, update-by-query, delete [E: rxdb.info] |
| Automerge-repo + kv `StorageAdapter` | `IndexedDBStorageAdapter` | replay automerge-perf trace in K saves; persist time, bytes written / final doc size, cold load, disk bytes; many small docs (1000 × small) load |
| Yjs + kv persistence | y-indexeddb | crdt-benchmarks B4 trace through persistence (updates appended, trim at 500 for y-indexeddb); persist time, cold load, disk bytes, bytes written |

Disk bytes for IndexedDB baselines can only come from `navigator.storage.estimate()`, which is approximate [E: MDN estimate]; report it with that caveat and compare deltas on a fresh origin.

### 6.5 Statistics

Fresh page and fresh origin data per run; contenders interleaved; N ≥ 5 runs (10 for comparisons); median with min-max for throughput; pooled histograms for p50/p99/p99.9/max; headless Chrome in CI, headed spot checks on one desktop browser. Tinybench or mitata only for in-memory microbenchmarks (codec, memtable, bloom). Consider tachometer for the comparison matrix, since it already does interleaving, fresh pages and CIs [E: tachometer README].

### 6.6 Bundle size

Section 4 recommendation: size-limit with esbuild for the tree-shaken main entry (`kv`, `collections` rows), `@size-limit/file` for the SharedWorker bundle and the `.wasm`, brotli headline plus gzip and raw, and a total. Put Dexie, y-indexeddb and `@automerge/automerge-repo-storage-indexeddb` through the same config so the comparison table has a size column.
