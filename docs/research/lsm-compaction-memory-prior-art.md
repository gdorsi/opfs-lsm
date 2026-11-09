# Bounding compaction and flush memory: prior art in LSM engines

Question: what do production LSM engines do to bound the memory of compaction, flush and the memtable, and does that support the design in `docs/research/bounded-compaction-memory.md` (BCM, issue #101)? Each claim below is traced to the code or the project's own design doc at a pinned tag. The candidates are `bounded-compaction-memory/candidate-a.md` (A, the base) and `candidate-b.md` (B).

## Answer in one table

Read "Verdict" as: **supported** (prior art does the same), **diverges** (prior art does something else, and the reason matters here), **gap** (prior art has something BCM lacks).

| # | BCM decision | Verdict | What to do |
|---|---|---|---|
| 1 | One source per L0 run, plus one concatenated source for the overlapped next level (BCM "Shape 1") | **supported**. RocksDB and LevelDB build exactly this iterator. Pebble uses one level iterator per L0 *sublevel*. TigerBeetle merges one table with "the concatenation of tables B" (2.1) | Keep. |
| 2 | Cap the sources, so an L0 step takes the oldest `maxSources − 1` L0 runs | **diverges**. RocksDB takes every overlapping L0 file. Fan-in is bounded instead by an L0 write stop: RocksDB 36 files, LevelDB 12, Pebble 12 sublevels, Badger 15 (2.1, 5.3) | Keep the cap, but add an L0 stop so the cap rarely applies (R1). |
| 3 | `C = 256 KiB` read-ahead per source | **supported**. Pebble's local read-ahead is 256 KiB. RocksDB measured 256 KiB as best for whole-file checksum scans. RocksDB's compaction default is 2 MiB, and its doc ties that to spinning disks (2.2) | Keep. |
| 4 | Read the tail first (128 KiB), parse the block table, drop the tail | **supported**. Pebble reads 32 KiB before the footer when it opens a table, and 512 KiB for index and filter (2.2) | Keep. |
| 5 | A running CRC with `combine` over a run read in pieces. No SST format change | **diverges in mechanism, holds for #101**. Every engine checked verifies each block before decoding it. Whole-file checksums (RocksDB, fjall) are computed while writing and checked only by explicit full scans. Nobody gates a compaction on one (6) | Keep. Change two details: use the streaming CRC state for data and call `combine` once for the tail (R5), and require the block decoder to stay in bounds on garbage, since it decodes before the CRC is known (R6). |
| 6 | Emit entries before the CRC is known. Install only after DONE. Delete the outputs on failure | **supported**. RocksDB cleans up the outputs of aborted compactions and installs all subcompaction outputs in one edit (6.3, 4.2) | Keep. |
| 7 | The pump stops only between keys, with YIELD every 1 MiB, so ingest runs during a step | **supported**. LevelDB runs a pending memtable flush from inside the compaction loop, between keys. RocksDB checks for abort every 1000 keys. TigerBeetle splits compaction into "beats" (5.4) | Keep. |
| 8 | `SstWriter` keeps a u32 hash per key and builds the bloom at `finish` | **supported**. Badger and mini-lsm use `Vec<u32>`/`[]uint32`. Pebble uses pooled u32 blocks. RocksDB uses a `deque<uint64_t>` and charges it to the block cache (3.3) | Keep. Budget the hashes as their own term, not inside "1.03·T" (R7). |
| 9 | The output run is built whole in memory because the path holds the byte size. Cut by size only. T = 4 MiB | **diverges**. RocksDB, LevelDB and Pebble write each block to the file as it is built, and keep the size in the manifest. Only Badger and mini-lsm build the whole table first. T = 4 MiB is normal: LevelDB, Badger and Pebble L0 use 2 MiB, Pebble Lbase 4 MiB, RocksDB 64 MiB (3.1, 3.2) | Consider moving the size into `RunMeta` and streaming output blocks into `createWritable`. That removes about 3·T (12 MiB at B = 32 MiB) from `P_host` (R2). Later, cut at grandparent overlap (R9). |
| 10 | Step bytes are uncapped. L0 grows during a long step | **matches RocksDB for L0→Lbase, but RocksDB pairs it with relief valves**. RocksDB applies no byte cap to L0→Lbase picks. It adds subcompactions (L0→Lbase only) and intra-L0 compaction. Pebble narrows L0→Lbase by splitting flushes into key intervals (4) | Add the L0 stop (R1). For phase 2, evaluate Pebble-style flush splits before virtual runs (R4). |
| 11 | Phase 2: "virtual left-trimmed runs (Pebble-style)" | **misattributed**. Pebble's virtual sstables serve ingest and excise, not progress inside a compaction. The direct precedent is SlateDB's incremental compaction (RFC-0035), which commits the durable key prefix of a running compaction through narrowed views (7) | Rename the phase-2 idea and cite SlateDB (R3). |
| 12 | Bounded flush: at most `flushRunBytes` per L0 run, by WAL record | **supported, with a cost to note**. One memtable becomes one L0 file in RocksDB and LevelDB, and Pebble cuts flush output at 2 MiB. But Pebble's flush pieces are key-disjoint and share a sublevel, while BCM's chunks each span the whole key range, so each chunk adds one merge source (8) | Keep, and let the L0 stop (R1) absorb the extra sources. |
| 13 | Tab memtable: a write waits while `bytes > memtableBytes` | **supported, gap in thresholds**. RocksDB's WriteBufferManager starts a flush at 7/8 of its limit and stalls at the limit. Pebble stops at 2 × memtable size (5.1) | Request ingest early (at about 7/8) and wait at 1× (R8). |
| 14 | `mergeSlot`: one merge per SharedWorker | **supported**. LevelDB has one background compaction. TigerBeetle's compaction CPU pool has size 1 (5.2) | Keep. |
| 15 | Reserve the working set at `merge_open`; a miss returns -11 instead of trapping | **supported by the spec**. `memory.grow` returns −1 on failure. A memory can also be given a maximum. RocksDB's cache reservations degrade or fail cleanly (9, 5.2) | Keep. Optionally set a maximum on `WebAssembly.Memory` (R10). |
| 16 | Recycle the instance when memory exceeds `wasmRecycleBytes` | **no precedent found**. The spec has no way to shrink memory. `memory.discard` is a Phase 1 proposal. Whether dropping an instance frees its memory is up to the engine's GC (9) | Keep the probe in BCM's open questions. It is still unverified. |
| 17 | Reject B's SST v2 per-block CRC | **holds for #101**. Per-block CRC is universal in prior art (RocksDB, LevelDB, Pebble, fjall, TigerBeetle). It brings two things BCM does without: corruption caught before decoding, and compaction never needing the filter (6) | Keep the rejection. Revisit if tabs ever read runs in ranges. |

The recommended changes R1–R10 are in section 10.

---

Conventions as in `derived-index-prior-art.md`:

- **[R]** is a repo fact, cited as `file:line` at `5eea20c`.
- **[E]** is an external fact. Every one links to a file and line range at a pinned tag or commit, listed in section 12.
- **[I]** is my inference.

Method: every repository was shallow-cloned at the pinned tag and read locally with `grep` and `sed`. The WebAssembly proposals README, the WHATWG FS spec, the File API spec and one mini-lsm file were downloaded raw at pinned commits. No summarising fetch was used, and no code was run.

---

## 1. Repo facts this depends on

- [R] An L0 step triggers at 4 L0 runs. L1 targets 40 MiB, and compaction output targets 4 MiB (`packages/kv/src/store/levels.ts:11-16`).
- [R] A run's level and byte size are in its path, so "planning reads no files" (`levels.ts:5-10`, `:44-51`). This is why BCM says a run must be complete before its file is created.
- [R] `crc32.rs` already has a streaming state, "Running CRC state over `data`" (`crates/engine-core/src/crc32.rs:49`), as well as `combine` (`:80-113`).
- [R] BCM's budget: `P_host = W0 + S·(C+K) + S·C + 1.03T + 2T + τ + 5F`. That comes to 31.4 MiB at B = 32 MiB with T = 4 MiB, so the output terms (`1.03T + 2T`) are about 12 MiB of it (BCM "Memory budget arithmetic").

## 2. Question 1: streaming merge inputs

### 2.1 Merge shape and fan-in

- [E] RocksDB builds the compaction input as one iterator per L0 file plus one `LevelIterator` per other level. The comment reads "Level-0 files have to be merged together. For other levels, we will make a concatenating iterator per level" ([version_set.cc:8413-8505](https://github.com/facebook/rocksdb/blob/v11.13.2/db/version_set.cc#L8413-L8505); `LevelIterator` at [:1161](https://github.com/facebook/rocksdb/blob/v11.13.2/db/version_set.cc#L1161)).
- [E] LevelDB has the same code and the same comment, using a `TwoLevelIterator` as the concatenating iterator ([version_set.cc:1220-1251](https://github.com/google/leveldb/blob/1.23/db/version_set.cc#L1220-L1251)).
- [E] Pebble adds one `levelIter` per input level. An L0 input "annotated with l0SublevelInfo" is expanded "into one level per sublevel", so L0 costs one source per *sublevel*, not per file ([compaction.go:1085-1092](https://github.com/cockroachdb/pebble/blob/v2.1.7/compaction.go#L1085-L1092), [:1178-1192](https://github.com/cockroachdb/pebble/blob/v2.1.7/compaction.go#L1178-L1192)).
- [E] TigerBeetle: "Create an iterator from the sort-merge of table A and the concatenation of tables B" ([compaction.zig:17](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/src/lsm/compaction.zig#L17)). Its input count is fixed at compile time: `compaction_tables_input_max = 1 + lsm_growth_factor` ([:55-61](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/src/lsm/compaction.zig#L55-L61)).
- [E] fjall/lsm-tree has a `RunScanner` that "Scans through a disjoint run" and is "Optimized for compaction" ([run_scanner.rs:8-10](https://github.com/fjall-rs/lsm-tree/blob/3.1.10/src/run_scanner.rs#L8-L10)).
- [E] RocksDB has no cap on how many L0 files one L0→Lbase merge takes. `GetOverlappingL0Files` replaces the picked file with every overlapping L0 file and widens the range ([compaction_picker.cc:1310-1340](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_picker.cc#L1310-L1340)). The L0 count is bounded instead by the write stop at `level0_stop_writes_trigger` (default 36; section 5.3).
- [I] So BCM's "concatenated source" is exactly RocksDB's `LevelIterator`, and BCM's source count matches RocksDB and LevelDB. BCM's `maxSources` cap has no direct precedent: the others bound fan-in by stopping writes, not by taking a prefix of L0. Taking the *oldest* L0 runs is sound for the reason BCM gives. Pebble's intra-L0 uses the same seqno rule: files newer than `earliestUnflushedSeqNum` are skipped ([l0_sublevels.go:1617-1623](https://github.com/cockroachdb/pebble/blob/v2.1.7/internal/manifest/l0_sublevels.go#L1617-L1623)).

### 2.2 Read-ahead and the first read

- [E] RocksDB `compaction_readahead_size` defaults to 2 MB: "If you're running RocksDB on spinning disks, you should set this to at least 2MB" ([options.h:1298-1305](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/options.h#L1298-L1305)). For compaction, the prefetcher sets both the initial and the maximum read-ahead to that value. It uses one buffer per table reader ([block_prefetcher.cc:34-69](https://github.com/facebook/rocksdb/blob/v11.13.2/table/block_based/block_prefetcher.cc#L34-L69)).
- [E] RocksDB's whole-file checksum scan reads in 256 KB chunks: "Found that 256 KB readahead size provides the best performance, based on experiments" ([file_util.cc:255-266](https://github.com/facebook/rocksdb/blob/v11.13.2/file/file_util.cc#L255-L266)).
- [E] Pebble: `fileMaxReadaheadSize = 256 * 1024` for local files ([vfs_readable.go:19](https://github.com/cockroachdb/pebble/blob/v2.1.7/objstorage/objstorageprovider/vfs_readable.go#L19)). For remote objects it uses 8 MB for compaction, because "Number of concurrent compactions is bounded … so there is no risk of high memory usage" ([remote_readable.go:26-32](https://github.com/cockroachdb/pebble/blob/v2.1.7/objstorage/objstorageprovider/remote_readable.go#L26-L32)).
- [E] Pebble's first read of a new table pads backward to 32 KiB for the footer, metaindex and properties. Index and filter use 512 KiB ([objstorage.go:44-70](https://github.com/cockroachdb/pebble/blob/v2.1.7/objstorage/objstorage.go#L44-L70)).
- [E] SlateDB's compaction worker fetches `bytes_to_fetch` (2 MiB) per request, with `max_fetch_tasks` (4) per input, so "~8MiB prefetched ahead of the cursor" per SST iterator ([config.rs:1426-1442](https://github.com/slatedb/slatedb/blob/v0.18.1/slatedb/src/config.rs#L1426-L1442)).
- [E] fjall's compaction scanner uses a 32 KiB `BufReader` per table ([table/scanner.rs:12-33](https://github.com/fjall-rs/lsm-tree/blob/3.1.10/src/table/scanner.rs#L12-L33)).
- [E] Compaction reads bypass the block cache. RocksDB sets `fill_cache = false` and `verify_checksums = true` ([compaction_job.cc:1497-1502](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_job.cc#L1497-L1502)), and LevelDB also sets `fill_cache = false` ([version_set.cc:1221-1223](https://github.com/google/leveldb/blob/1.23/db/version_set.cc#L1221-L1223)).
- [I] BCM's 256 KiB is the local-disk value both Pebble and RocksDB settled on. BCM's 128 KiB tail guess sits between Pebble's 32 KiB (footer) and 512 KiB (index and filter).

## 3. Question 2: output

### 3.1 Streaming to disk, file names and sizes

- [E] RocksDB's table builder appends each block, then its 5-byte trailer, to the `WritableFileWriter` as soon as the block is complete ([block_based_table_builder.cc:2735-2771](https://github.com/facebook/rocksdb/blob/v11.13.2/table/block_based/block_based_table_builder.cc#L2735-L2771)). LevelDB does the same ([table_builder.cc:125](https://github.com/google/leveldb/blob/1.23/table/table_builder.cc#L125), [:177-189](https://github.com/google/leveldb/blob/1.23/table/table_builder.cc#L177-L189)). Pebble sends every data block through a `writeQueue` ([rowblk_writer.go:142-154](https://github.com/cockroachdb/pebble/blob/v2.1.7/sstable/rowblk_writer.go#L142-L154)).
- [E] In RocksDB and LevelDB the file name is the file number only (`MakeTableFileName(number)`, [filename.cc:113](https://github.com/facebook/rocksdb/blob/v11.13.2/file/filename.cc#L113); LevelDB [filename.cc:33-36](https://github.com/google/leveldb/blob/1.23/db/filename.cc#L33-L36)). The size lives in the manifest's file metadata (RocksDB `FileDescriptor::file_size`, [version_edit.h:192](https://github.com/facebook/rocksdb/blob/v11.13.2/db/version_edit.h#L192); LevelDB `FileMetaData::file_size`, [version_edit.h:24](https://github.com/google/leveldb/blob/1.23/db/version_edit.h#L24)). A compaction output is opened at its final name before any key is written ([db_impl.cc:800-818](https://github.com/google/leveldb/blob/1.23/db/db_impl.cc#L800-L818)). The only write-to-temp-then-rename in LevelDB is `CURRENT` ([filename.cc:123-135](https://github.com/google/leveldb/blob/1.23/db/filename.cc#L123-L135)).
- [E] Badger takes BCM's path. `CreateTable` calls `builder.Done()` first, then creates the file with the final size known (`OpenMmapFile(fname, …, bd.Size)`), and copies the built table in ([table.go:245-262](https://github.com/dgraph-io/badger/blob/v4.9.6/table/table.go#L245-L262)). mini-lsm also builds into a `Vec<u8>` and then calls `FileObject::create(path, buf)` ([builder.rs:32-35, 93-111](https://github.com/skyzh/mini-lsm/blob/df2120d7252ca2180a00a051ab307893a51545ab/mini-lsm/src/table/builder.rs#L93-L111)).
- [E] Badger shows what this costs. Splits were capped at 5 because "142 tables in bottom led to 48 splits. That's too many splits, because it then uses up a lot of memory for table builder" ([levels.go:1103-1112](https://github.com/dgraph-io/badger/blob/v4.9.6/levels.go#L1103-L1112)).
- [E] OPFS: changes written through a `FileSystemWritableFileStream` "won't be reflected in the file entry … until the stream has been closed". The note adds that this "is typically implemented by writing data to a temporary file" ([WHATWG fs index.bs:520-534](https://github.com/whatwg/fs/blob/d76d3455d5afe2f85754ed24ffdbf99fe30032d4/index.bs?plain=1#L520-L534)). At close, the spec sets the file's data to the stream's `[[buffer]]`, which "is expected" to update the file atomically ([:1170-1180](https://github.com/whatwg/fs/blob/d76d3455d5afe2f85754ed24ffdbf99fe30032d4/index.bs?plain=1#L1170-L1180)).
- [I] So a run can be streamed block by block into one `createWritable` and still become visible all at once, provided its name does not need the final size. With the size in `RunMeta` in the manifest, the way RocksDB and LevelDB do it, the writer would hold about one block plus hashes and index instead of `1.03T`, and the two JS output copies (`2T`) would go away. That is about 12 MiB of the 31.4 MiB at B = 32 MiB. Caveat: the spec models the stream as an in-memory `[[buffer]]`. Whether Chrome, Firefox and Safari keep pending writes on disk is implementation-defined and **not verified** here.

### 3.2 When to cut an output

- [E] RocksDB cuts on: the target file size (optionally counting the estimated tail), the grandparent-overlap limit `grandparent_overlapped_bytes + current_output > max_compaction_bytes`, skippable grandparent files, and a pre-cut at 50–90% of target on grandparent boundaries. "files output to Level 0 won't be split" ([compaction_outputs.cc:238-360](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_outputs.cc#L238-L360), the L0 rule at [:291](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_outputs.cc#L291), size at [:301](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_outputs.cc#L301), grandparents at [:322](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_outputs.cc#L322)). The default `target_file_size_base` is 64 MB ([advanced_options.h:556-568](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/advanced_options.h#L556-L568)).
- [E] LevelDB uses `max_file_size = 2 MiB` ([options.h:115](https://github.com/google/leveldb/blob/1.23/include/leveldb/options.h#L115)), `MaxGrandParentOverlapBytes = 10 × target` and `ExpandedCompactionByteSizeLimit = 25 × target` ([version_set.cc:24-39](https://github.com/google/leveldb/blob/1.23/db/version_set.cc#L24-L39)). It cuts on `ShouldStopBefore` or on reaching `MaxOutputFileSize` ([db_impl.cc:936-938, 1004-1006](https://github.com/google/leveldb/blob/1.23/db/db_impl.cc#L1004-L1006)).
- [E] Pebble uses the same 10× and 25× factors ([compaction.go:53-79](https://github.com/cockroachdb/pebble/blob/v2.1.7/compaction.go#L53-L79)). Its `OutputSplitter` splits at 0.5×–2× of target, prefers grandparent boundaries, and "guarantees that we never split user keys between files" ([splitting.go:51-93](https://github.com/cockroachdb/pebble/blob/v2.1.7/internal/compact/splitting.go#L51-L93)). Defaults are 2 MB for L0 and double per level ([options.go:854-863](https://github.com/cockroachdb/pebble/blob/v2.1.7/options.go#L854-L863)).
- [E] Badger defaults `BaseTableSize` to 2 MiB ([options.go:129](https://github.com/dgraph-io/badger/blob/v4.9.6/options.go#L129)).
- [I] T = 4 MiB is in the normal range for small engines. If T shrinks for small budgets (a BCM open question), 2 MiB has precedent in LevelDB, Pebble L0 and Badger. BCM cuts on size and at key boundaries only. Cutting at grandparent overlap would make the *next* step smaller for L1→L2 and deeper, but it does nothing for L0→L1 with random keys, where every key overlaps.

### 3.3 Building the filter incrementally

- [E] RocksDB keeps one 64-bit hash per key in a `std::deque<uint64_t>`, which "has near-minimal peak memory use". It collapses adjacent duplicates and builds the filter in `Finish` ([filter_policy.cc:76-86, 142-163, 316-319](https://github.com/facebook/rocksdb/blob/v11.13.2/table/block_based/filter_policy.cc#L142-L163)). With cache charging on, that hash buffer is reserved against the block cache under `CacheEntryRole::kFilterConstruction` ([cache.h:74-75](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/cache.h#L74-L75)). If the reservation fails, Ribbon construction "will fall back to Bloom Filter" ([table.h:462-473](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/table.h#L462-L473)). It can also XOR-checksum the hashes and check them after the build (`detect_filter_construct_corruption`, [table.h:696](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/table.h#L696)).
- [E] Pebble stores u32 hashes in pooled `[16384]uint32` blocks and builds at `Finish` ([bloom.go:119-167](https://github.com/cockroachdb/pebble/blob/v2.1.7/bloom/bloom.go#L119-L167)).
- [E] Badger keeps `keyHashes []uint32` "Used for building the bloomfilter" and builds it in `Done` ([builder.go:76, 210, 436-437](https://github.com/dgraph-io/badger/blob/v4.9.6/table/builder.go#L436-L437)). mini-lsm keeps `key_hashes: Vec<u32>` and builds the filter from them ([builder.rs:35, 58, 104-106](https://github.com/skyzh/mini-lsm/blob/df2120d7252ca2180a00a051ab307893a51545ab/mini-lsm/src/table/builder.rs#L104-L106)). fjall keeps `bloom_hash_buffer: Vec<u64>` ([filter/full.rs:15-16](https://github.com/fjall-rs/lsm-tree/blob/3.1.10/src/table/writer/filter/full.rs#L15-L16)).
- [E] LevelDB's old format is the exception. It builds one filter per 2 KiB of data offset, so it buffers only the keys of the current range ([filter_block.cc:14-16, 20-32](https://github.com/google/leveldb/blob/1.23/table/filter_block.cc#L14-L32)).
- [I] BCM's u32-per-key plan matches Badger, mini-lsm and Pebble. The hash buffer is `4 B × entries` per output run. For 4 MiB runs of 32-byte entries that is 512 KiB, or 12.5% of T, so the "0.03" in `1.03·T` is only right for entries over about 130 B. RocksDB budgets this buffer as its own item, and BCM should too (R7).

## 4. Question 3: bounding the size of one step

### 4.1 RocksDB

- [E] `max_compaction_bytes` defaults to `target_file_size_base × 25`, with the caveat "We try to limit … But it's not guaranteed" ([advanced_options.h:687-701](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/advanced_options.h#L687-L701)). Where it is enforced:
  - expanding the input level, with a soft 2× limit ([compaction_picker.cc:603-616](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_picker.cc#L603-L616));
  - round-robin picks ([compaction_picker_level.cc:465-472](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_picker_level.cc#L465-L472));
  - trivial-move extension ([:726-805](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_picker_level.cc#L726-L805));
  - intra-L0 ([:927-943](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_picker_level.cc#L927-L943)).
- [E] L0→Lbase has no byte cap. `SetupOtherL0FilesIfNeeded` takes every overlapping L0 file ([compaction_picker_level.cc:341-347](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_picker_level.cc#L341-L347)). Only one L0 compaction runs at a time ("Two level 0 compaction won't run at the same time", [compaction_picker.cc:1313-1315](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_picker.cc#L1313-L1315)).
- [E] What RocksDB does about large L0→Lbase steps:
  1. **Subcompactions.** One compaction is split into key ranges that run in parallel. In leveled mode this applies only to `start_level_ == 0` (or manual) compactions ([compaction.cc:918-946](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction.cc#L918-L946)). Boundaries come from 128 anchor points per input file, read from the index blocks ([compaction_job.cc:573-598](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_job.cc#L573-L598)). All subcompaction outputs are added to one `VersionEdit` and installed by one `LogAndApply` ([compaction_job.cc:2405-2416, 2465](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_job.cc#L2405-L2416)). `max_subcompactions` defaults to 1 ([options.h:944-950](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/options.h#L944-L950)).
  2. **Intra-L0 when L0→Lbase is blocked.** "L0->base_level may be blocked due to ongoing L0->base_level compactions … we can attempt compacting a span of files within L0" ([compaction_picker_level.cc:236-252](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_picker_level.cc#L236-L252)). This needs at least `level0_file_num_compaction_trigger + 2` L0 files ([:927-943](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_picker_level.cc#L927-L943)).
  3. **Size-based intra-L0.** When Lbase is more than `max(10, multiplier) × 2` times the total L0 size, RocksDB compacts L0 into L0 "to prevent L0->Lbase compaction with large write-amp" ([:120-128](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_picker_level.cc#L120-L128), [:945-998](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_picker_level.cc#L945-L998)).

### 4.2 Pebble: L0 sublevels and flush splits

- [E] `FlushSplitBytes` (default 2 × L0 target) splits a flush "at boundary keys of L0 flush split intervals", which "allows increased compaction flexibility and concurrency" ([options.go:776-786](https://github.com/cockroachdb/pebble/blob/v2.1.7/options.go#L776-L786), default at [:1506](https://github.com/cockroachdb/pebble/blob/v2.1.7/options.go#L1506)). The split keys come from L0's intervals, roughly every `flushSplitMaxBytes × sublevels` bytes ([l0_sublevels.go:700-715](https://github.com/cockroachdb/pebble/blob/v2.1.7/internal/manifest/l0_sublevels.go#L700-L715)). Each flush uses them as output limits ([compaction.go:843-844](https://github.com/cockroachdb/pebble/blob/v2.1.7/compaction.go#L843-L844)).
- [E] A base compaction picks a seed *interval* in L0 and grows it. Two base compactions on disjoint intervals can run in parallel ([l0_sublevels.go:1300-1330, 1399](https://github.com/cockroachdb/pebble/blob/v2.1.7/internal/manifest/l0_sublevels.go#L1300-L1330)). If no base compaction can be picked, `pickL0` falls back to intra-L0 with at least 4 files ([compaction_picker.go:1926-1970](https://github.com/cockroachdb/pebble/blob/v2.1.7/compaction_picker.go#L1926-L1970)).
- [I] Pebble's answer to "L0→Lbase spans all of Lbase" is B's slicing done at flush time: L0 files are cut into key intervals, so a base step covers one interval and only the Lbase files under it. With random keys, a BCM flush chunk could also be cut at the current L1 run boundaries. An L0→L1 step could then take one L1 run plus the L0 pieces over it. Steps would be bounded at about T + L0 bytes / (number of L1 runs), with no format change and no virtual runs. The cost is more, smaller L0 files and manifest entries. This is not measured here (R4).

### 4.3 LevelDB, TigerBeetle

- [E] LevelDB grows a compaction only while `inputs1_size + expanded0_size < 25 × target` ([version_set.cc:1400-1415](https://github.com/google/leveldb/blob/1.23/db/version_set.cc#L1400-L1415)). It has no subcompactions and no intra-L0.
- [E] TigerBeetle bounds a step by construction: one table from level A into at most `lsm_growth_factor` tables of level B. "To avoid write amplification stalls and bound latency, compaction is done incrementally" in beats ([lsm.md:39-58](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/docs/internals/lsm.md?plain=1#L39-L58)). Its level 0 is a sorted run of disjoint tables: "Within a given level and snapshot, the tables' key ranges are disjoint" ([lsm.md:31-35](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/docs/internals/lsm.md?plain=1#L31-L35)). So TigerBeetle has no overlapping-L0 problem at all.

## 5. Question 4: memory budgets and write stalls

### 5.1 Memtable limits

- [E] RocksDB `WriteBufferManager(buffer_size, cache, allow_stall)` ([write_buffer_manager.h:51-65](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/write_buffer_manager.h#L51-L65)):
  - It sets `mutable_limit_ = buffer_size × 7/8` ([:107](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/write_buffer_manager.h#L107)).
  - `ShouldFlush` fires when mutable memory passes that limit, or when total memory ≥ the limit and mutable memory ≥ half of it ([:144-160](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/write_buffer_manager.h#L144-L160)).
  - `ShouldStall` stalls "all writer threads … across all DBs" while memory ≥ `buffer_size` ([:162-185](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/write_buffer_manager.h#L162-L185)).
  - With a cache, memtable memory is charged as `kWriteBuffer` dummy entries ([cache.h:68-69](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/cache.h#L68-L69)).
- [E] Pebble: `MemTableSize` defaults to 4 MB, and writes stop "when the sum of the queued memtable sizes exceeds MemTableStopWritesThreshold × MemTableSize" (default 2) ([options.go:890-910](https://github.com/cockroachdb/pebble/blob/v2.1.7/options.go#L890-L910), defaults at [:1477-1480](https://github.com/cockroachdb/pebble/blob/v2.1.7/options.go#L1477-L1480), enforced at [db.go:2633-2640](https://github.com/cockroachdb/pebble/blob/v2.1.7/db.go#L2633-L2640)).
- [E] LevelDB has one immutable memtable. When it is still flushing, the writer waits: "Current memtable full; waiting…" ([db_impl.cc:1351-1355](https://github.com/google/leveldb/blob/1.23/db/db_impl.cc#L1351-L1355)). `write_buffer_size` defaults to 4 MiB ([options.h:82](https://github.com/google/leveldb/blob/1.23/include/leveldb/options.h#L82)).
- [I] BCM starts ingest and waits at the same threshold. RocksDB starts flushing at 7/8 and stalls at 1×, so in steady state the stall rarely happens (R8).

### 5.2 Compaction memory

- [E] RocksDB cannot charge compaction read-ahead or output buffers to the block cache. Only four roles can be charged: dictionary buffers, filter construction, table readers and file metadata. "Other CacheEntryRole: Not supported" ([table.h:440-511](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/table.h#L440-L511)). When a charge does not fit, the features degrade (dictionary samples dropped, Ribbon falls back to Bloom) or fail with `MemoryLimit` (table readers).
- [E] TigerBeetle: "All memory must be statically allocated at startup" ([TIGER_STYLE.md:151-156](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/docs/TIGER_STYLE.md?plain=1#L151-L156)). Compaction draws from a fixed `ResourcePool`: a stack of blocks, read/write IOPS of 18 and 17, and a CPU pool of size 1 ([compaction.zig:78-90](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/src/lsm/compaction.zig#L78-L90); [constants.zig:654-663](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/src/constants.zig#L654-L663)). The floor is `compaction_block_count_beat_min`: output index and value blocks, index blocks for A and B, and `lsm_compaction_queue_read_max` (16) value blocks ([compaction.zig:67-74](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/src/lsm/compaction.zig#L67-L74)).
- [E] Pebble's memory doc: with Go's GC, "a collection is triggered when the ratio of freshly allocated data to live data … reaches this percentage". Pebble moved the block cache and memtables off the Go heap because RSS was "2x what it was when using RocksDB" ([docs/memory.md](https://github.com/cockroachdb/pebble/blob/v2.1.7/docs/memory.md?plain=1#L20-L51)).
- [I] TigerBeetle's per-beat block floor is the closest analogue to BCM's `S·(C+K)` term: memory is per-source blocks plus one output in progress, and step size does not appear. The Pebble note backs BCM's +25% GC slack for JS read buffers. Section 9 has a spec-level way to reuse them.

### 5.3 L0 slowdown and stop triggers

| Engine | Compaction trigger | Slowdown | Stop | Source |
|---|---|---|---|---|
| RocksDB | 4 files | 20 files (rate `delayed_write_rate`, default 16 MB/s) | 36 files; also when unflushed memtables ≥ `max_write_buffer_number` | [options.h:256](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/options.h#L256), [advanced_options.h:540-554](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/advanced_options.h#L540-L554), [options.h:1395-1407](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/options.h#L1395-L1407), [column_family.cc:1021-1052](https://github.com/facebook/rocksdb/blob/v11.13.2/db/column_family.cc#L1021-L1052) |
| LevelDB | 4 files | 8 files: each write sleeps 1 ms, once | 12 files | [dbformat.h:28-34](https://github.com/google/leveldb/blob/1.23/db/dbformat.h#L28-L34), [db_impl.cc:1325-1360](https://github.com/google/leveldb/blob/1.23/db/db_impl.cc#L1325-L1360) |
| Pebble | read-amp 4 (or 500 files) | none | 12 sublevels | [options.go:837-845, 1417-1446](https://github.com/cockroachdb/pebble/blob/v2.1.7/options.go#L1417-L1446), [db.go:2650-2656](https://github.com/cockroachdb/pebble/blob/v2.1.7/db.go#L2650-L2656) |
| Badger | 5 tables | none found | 15 tables | [options.go:138-140](https://github.com/dgraph-io/badger/blob/v4.9.6/options.go#L138-L140) |
| TigerBeetle | n/a: compaction is paced with commits, and "at the end of every beat, there is space in mutable table for the next beat" | | | [lsm.md:61](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/docs/internals/lsm.md?plain=1#L61) |

- [E] LevelDB explains its slowdown: "Rather than delaying a single write by several seconds when we hit the hard limit, start delaying each individual write by 1ms … this delay hands over some CPU to the compaction thread" ([db_impl.cc:1337-1345](https://github.com/google/leveldb/blob/1.23/db/db_impl.cc#L1337-L1345)).
- [I] In every engine, the backpressure chain ends at the L0 count: memtable full → wait for flush → flush blocked by the L0 stop → wait for compaction. In BCM the chain ends at ingest. A write waits for ingest, but ingest never waits for compaction, so L0 can grow without bound during long steps. The answer to BCM's open question ("L0 write slowdown or `maxStepBytes` now?") is yes to a stop trigger. Every surveyed engine has one, and it is cheap. The threshold should sit at or below `maxSources − 1`, so that one L0 step can always take all of L0 (R1).

### 5.4 Serving flush during a long compaction

- [E] LevelDB's compaction loop checks before every key whether an immutable memtable is waiting. If so, it flushes it inline (`CompactMemTable`) and wakes blocked writers ([db_impl.cc:921-933](https://github.com/google/leveldb/blob/1.23/db/db_impl.cc#L921-L933)).
- [E] RocksDB checks for compaction abort "every 1000 keys processed" ([db.h:2185-2200](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/db.h#L2185-L2200)).
- [I] LevelDB is the closest match to BCM: a single background thread that stops between keys to install a flush while a compaction runs. BCM's YIELD every 1 MiB plus per-chunk ingest locking is the same idea on an event loop.

## 6. Question 5: checksums when a file is read in pieces

### 6.1 Per-block checksums are universal

- [E] RocksDB: every block has a 5-byte trailer (1 byte compression type, 4 bytes checksum) ([block_based_table_reader.h:132-133](https://github.com/facebook/rocksdb/blob/v11.13.2/table/block_based/block_based_table_reader.h#L132-L133)). The checksum covers the block plus its type byte, and is checked in `VerifyBlockChecksum` ([reader_common.cc:26-60](https://github.com/facebook/rocksdb/blob/v11.13.2/table/block_based/reader_common.cc#L26-L60)). Compaction forces `verify_checksums = true` ([compaction_job.cc:1501](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_job.cc#L1501)).
- [E] LevelDB has the same trailer layout ([format.h:79](https://github.com/google/leveldb/blob/1.23/table/format.h#L79)). It checks the block only `if (options.verify_checksums)` ([format.cc:73-87](https://github.com/google/leveldb/blob/1.23/table/format.cc#L73-L87)). For compaction that flag is `paranoid_checks` ([version_set.cc:1222](https://github.com/google/leveldb/blob/1.23/db/version_set.cc#L1222)), which defaults to false ([options.h:59](https://github.com/google/leveldb/blob/1.23/include/leveldb/options.h#L59)). So by default LevelDB compacts without checking block CRCs.
- [E] Pebble: `TrailerLen = 5` ([block.go:105](https://github.com/cockroachdb/pebble/blob/v2.1.7/sstable/block/block.go#L105)). Every block read from disk is checked unconditionally ([block.go:596](https://github.com/cockroachdb/pebble/blob/v2.1.7/sstable/block/block.go#L596)).
- [E] fjall checks a 128-bit xxh3 per block on load ([block/mod.rs:94-96](https://github.com/fjall-rs/lsm-tree/blob/3.1.10/src/table/block/mod.rs#L94-L96)).
- [E] TigerBeetle stores a block's checksum *outside* the block, in its parent, "to protect from misdirected writes" ([data_file.md:30-39](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/docs/internals/data_file.md?plain=1#L30-L39)). Grid reads reject `invalid_checksum` and `invalid_checksum_body` ([grid.zig:1402-1410](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/src/vsr/grid.zig#L1402-L1410)).
- [E] Badger has per-block checksums, but the default mode is `NoVerification` ([options.go:661-666](https://github.com/dgraph-io/badger/blob/v4.9.6/options.go#L661-L666)).

### 6.2 Whole-file checksums: written incrementally, checked only by explicit scans

- [E] RocksDB's `FileChecksumGenerator` has `Update(data, n)` / `Finalize()` ([file_checksum.h:55-73](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/file_checksum.h#L55-L73)). It is fed on every append (`UpdateFileChecksum`, [writable_file_writer.cc:880](https://github.com/facebook/rocksdb/blob/v11.13.2/file/writable_file_writer.cc#L880)), and the result is stored in the output's metadata ([compaction_outputs.cc:87-88](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_outputs.cc#L87-L88)). It is off unless `file_checksum_gen_factory` is set ([options.h:1689-1696](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/options.h#L1689-L1696)).
- [E] RocksDB checks it with `DB::VerifyFileChecksums` ("Currently the whole-file checksum of table files are checked"), as distinct from `VerifyChecksum` for blocks ([db.h:2750-2758](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/db.h#L2750-L2758)). Checking means one sequential scan in 256 KB chunks that feeds `Update` ([file_util.cc:255-298](https://github.com/facebook/rocksdb/blob/v11.13.2/file/file_util.cc#L255-L298)). On output, it is checked only if `verify_output_flags` asks for `kVerifyFileChecksum` ([compaction_job.cc:930-1000](https://github.com/facebook/rocksdb/blob/v11.13.2/db/compaction/compaction_job.cc#L930-L1000)). `paranoid_file_checks` "reopen[s] it and read[s] all the keys", which is an iteration check, not a file checksum ([advanced_options.h:818-825](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/advanced_options.h#L818-L825)).
- [E] fjall wraps its table writer in a `ChecksummedWriter` and returns the file checksum from `finish` ([writer/mod.rs:66, 100, 518-520](https://github.com/fjall-rs/lsm-tree/blob/3.1.10/src/table/writer/mod.rs#L518-L520)).
- [E] RocksDB's compaction does not read input filters. The ephemeral compaction reader sets `skip_filters` ([version_set.cc:1153-1158](https://github.com/facebook/rocksdb/blob/v11.13.2/db/version_set.cc#L1153-L1158)).

### 6.3 When corruption is detected, and what happens to outputs

- [E] In RocksDB and Pebble, a corrupt block fails the block read before any entry from it is decoded (6.1). Outputs of aborted compactions "are automatically cleaned up, ensuring no partial compaction results are installed" ([db.h:2194-2196](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/db.h#L2194-L2196)).

### 6.4 What this means for BCM

- [I] BCM's running CRC is RocksDB's `GenerateOneFileChecksum` loop moved into the compaction read path. Nobody else gates a compaction on a whole-file checksum, but nothing argues against it either. Install is still gated, which is the property that matters. Rejecting B's SST v2 format change stands for #101.
- [I] BCM pays three costs that per-block formats avoid:
  1. Every input's bloom must be read, because the whole-file CRC covers it. RocksDB skips filters in compaction. This is a few percent of input bytes. **Not measured.**
  2. Corruption is found only when a run's last block has been used.
  3. Entries are decoded *before* they are verified.

  The third one has a design consequence: the block decoder and the LZ4 decoder must be total on arbitrary bytes. Bad lengths must return a corruption code, never index out of bounds, because a panic in wasm is a trap (R6). RocksDB and Pebble never decode unverified bytes, so they do not need this property.
- [I] Since feeds arrive in file order, the data CRC needs only the streaming state that `crc32.rs:49` already has, as in RocksDB's `Update`. `combine` is needed once, to append the separately computed tail (R5). The current BCM wording, "updated on every feed with `combine`", costs a GF(2) matrix step per feed for no gain.

## 7. Question 6: virtual and trimmed sstables, and partial progress

- [E] Pebble's virtual sstable RFC: "A virtual sstable has no associated physical data on disk, and is instead backed by an existing physical sstable". It is used "to lower the read-amp and the write-amp caused by certain ingestions" and for disaggregated-storage masking ([20221122_virtual_sstable.md:12-31](https://github.com/cockroachdb/pebble/blob/v2.1.7/docs/RFCS/20221122_virtual_sstable.md?plain=1#L12-L31)). In the code, virtual tables come from `exciseTable` ([excise.go:64-65](https://github.com/cockroachdb/pebble/blob/v2.1.7/excise.go#L64-L65)) and from delete-only compactions that "virtualiz[e] them into virtual sstables" ([compaction.go:290-299](https://github.com/cockroachdb/pebble/blob/v2.1.7/compaction.go#L290-L299)). Pebble does not create them to commit part of a running compaction. **Not found** in the files read.
- [E] SlateDB's RFC-0035, "Incremental Compaction" (Status: Draft), does exactly that. It commits "output for key intervals while workers process the remaining keys". Each sorted run holds `SsTableView`s with a `visible_range` projection, and a commit "can narrow a view, split it into several views of the same physical SST, or remove it". For an unfinished range, the durable interval runs "up to the last key of the last recorded output SST, and excludes that key". The motivation is transient space, not L0 growth ([0035-incremental-compaction.md:47-131](https://github.com/slatedb/slatedb/blob/v0.18.1/rfcs/0035-incremental-compaction.md?plain=1#L47-L131)). The code exists at v0.18.1 ([incremental_progress.rs:1-40](https://github.com/slatedb/slatedb/blob/v0.18.1/slatedb/src/incremental_progress.rs#L1-L40); `SsTableView` at [db_state.rs:63-74](https://github.com/slatedb/slatedb/blob/v0.18.1/slatedb/src/db_state.rs#L63-L74)).
- [E] RocksDB's `OpenAndCompactOptions::allow_resumption` (EXPERIMENTAL, remote compaction only) persists progress "upon completion of each new output file". It does not install partial output ([options.h:3346-3379](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/options.h#L3346-L3379)).
- [I] BCM's phase-2 "virtual left-trimmed runs (Pebble-style)" is SlateDB-style incremental commit. The name and citation should change (R3). With one concatenated next-level source and outputs cut at key boundaries, the durable prefix is simply `[−∞, last key of last finished output)`:
  - L1 runs that end before that key can be released;
  - L1 runs and L0 runs that straddle it become left-trimmed views.

  That needs a `visible_range` in `RunMeta` and in the reader. Pebble-style flush splits (4.2) attack the same problem, long L0→L1 steps, without views. They are the smaller change to try first (R4).

## 8. Question 7: bounding the flush when ingest lags

- [E] RocksDB:
  - `write_buffer_size` is 64 MB per memtable ([options.h:192](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/options.h#L192)).
  - `max_write_buffer_number` is 2; above 3, writes slow on the last buffer ([advanced_options.h:260-271](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/advanced_options.h#L260-L271)).
  - With `min_write_buffer_number_to_merge = 1`, "all write buffers are flushed to L0 as individual files" ([:273-283](https://github.com/facebook/rocksdb/blob/v11.13.2/include/rocksdb/advanced_options.h#L273-L283)).
  - A backlog therefore becomes several bounded L0 files, not one big file.
- [E] Pebble flushes all queued memtables in one flush ([compaction.go:1071-1083](https://github.com/cockroachdb/pebble/blob/v2.1.7/compaction.go#L1071-L1083)). It cuts the output at the 2 MB L0 target and at flush split keys (4.2), so the pieces are key-disjoint L0 files.
- [E] Badger keeps up to `NumMemtables = 5` ([options.go:140](https://github.com/dgraph-io/badger/blob/v4.9.6/options.go#L140)).
- [E] TigerBeetle sizes the mutable table "to accommodate a full bar of updates" and flushes the immutable one during the next half-bar ([lsm.md:23-30](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/docs/internals/lsm.md?plain=1#L23-L30); [constants.zig:639-647](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.10/src/constants.zig#L639-L647)).
- [I] BCM's `flushRunBytes` chunking is the RocksDB pattern: each piece of backlog becomes its own L0 file, bounded in size. BCM's input is unsorted WAL records, not sorted memtables, so it cannot stream-merge the whole backlog and cut by key the way Pebble does without holding the backlog. The cost is that every chunk spans the full key range and adds one merge source. That makes the L0 stop (R1) more important, not less.

## 9. Question 8: wasm and browser memory

- [E] Core spec: "The memory.grow instruction grows a memory by a given delta and returns the previous size, or −1 if enough memory cannot be allocated". No instruction shrinks memory ([syntax/instructions.rst:216-224](https://github.com/WebAssembly/spec/blob/f3268fa9dcb7d3a60d09546e743e7281e75cddb0/document/core/syntax/instructions.rst?plain=1#L216-L224)).
- [E] JS API: `Memory.grow` throws `RangeError` on failure ([js-api/index.bs:910-929](https://github.com/WebAssembly/spec/blob/f3268fa9dcb7d3a60d09546e743e7281e75cddb0/document/js-api/index.bs?plain=1#L910-L929)). The descriptor accepts an optional `maximum` ([:813, 883-884](https://github.com/WebAssembly/spec/blob/f3268fa9dcb7d3a60d09546e743e7281e75cddb0/document/js-api/index.bs?plain=1#L883-L884)). A memory's `ArrayBuffer` has `[[ArrayBufferDetachKey]] = "WebAssembly.Memory"`, so user code cannot transfer or detach it ([:838-841](https://github.com/WebAssembly/spec/blob/f3268fa9dcb7d3a60d09546e743e7281e75cddb0/document/js-api/index.bs?plain=1#L838-L841)).
- [E] The memory-control proposal says linear memory "can grow but never shrink", and "there are no APIs for releasing memory to the host, so a WebAssembly application's memory footprint can only increase" ([Overview.md:1, 14](https://github.com/WebAssembly/memory-control/blob/62fac131de7e6406c9c05b493457025c2e42a15c/proposals/memory-control/Overview.md?plain=1#L1-L14)). It proposes `memory.discard`, which zero-fills pages and lets the host drop them ([discard.md:1-13](https://github.com/WebAssembly/memory-control/blob/62fac131de7e6406c9c05b493457025c2e42a15c/proposals/memory-control/discard.md?plain=1#L1-L13)). The proposal is at **Phase 1** ([proposals README.md:56-64](https://github.com/WebAssembly/proposals/blob/df6a2aca1cd9d779eb4f2f3e19dae8277f336015/README.md?plain=1#L56-L64)).
- [E] File API: `Blob.stream()` is set up "with byte reading support" ([FileAPI index.bs:329-335](https://github.com/w3c/FileAPI/blob/2f610830afbbcb8116c3f3fc22062c0980456291/index.bs?plain=1#L329-L335)). By spec, a BYOB reader can therefore fill a caller-owned buffer. It cannot fill wasm memory directly, because of the detach key above.
- [I] What this supports:
  - Reserving at `merge_open` and returning −11 is safe at the spec level. If the allocator turns a −1 from `memory.grow` into an `Err`, nothing traps.
  - A `maximum` on the memory would make the budget a hard ceiling. A miss would then be a clean −11, not a slow growth (R10).
  - Instance recycling is the only shrink available today. No primary source says when a browser returns a dropped instance's memory. That stays an open probe.
  - BYOB reads into a few reusable JS buffers could replace one `File.slice().arrayBuffer()` per demand and cut GC churn. Browser support was **not verified**.

## 10. Recommended changes to the design

1. **R1. Add an L0 stop for ingest.** While the L0 run count is at or above `l0StopRuns`, `ingestAll` waits for the step that is running. Tab writes are already chained to ingest through `memtableBytes`, so this completes the RocksDB/LevelDB/Pebble chain (5.3). Pick `l0StopRuns ≤ maxSources − 1`, so that one L0 step can always take all of L0 and the "oldest subset" path becomes a rare fallback. Prior art: LevelDB and Pebble stop at 12, Badger at 15, RocksDB at 36. A LevelDB-style 1 ms per-write delay at a lower count is optional.
2. **R2. Consider moving run byte size from the path into `RunMeta`** (RocksDB `FileDescriptor`, LevelDB `FileMetaData`), and streaming output blocks into one `createWritable`. This removes about `1.03T + 2T` (12 MiB at B = 32 MiB, T = 4 MiB) from `P_host`. Then either S rises or the 24 MiB floor drops. First check why size is in the path, and how Chrome stores pending `createWritable` data (3.1).
3. **R3. Rename phase 2** from "virtual left-trimmed runs (Pebble-style)" to "incremental commit with trimmed run views (SlateDB RFC-0035)", and cite it (section 7).
4. **R4. Before phase 2, evaluate flush splits at L1 run boundaries** (Pebble `FlushSplitBytes`, 4.2). This bounds L0→L1 step size with no views and no format change. Also consider RocksDB's size-based intra-L0 rule for when L1 is more than 20× L0 (4.1).
5. **R5. CRC wording and cost.** Use the streaming CRC state for data, as RocksDB's `Update` does, and call `combine` once to append `crc_tail`. Change "updated on every feed with `combine`" accordingly (6.4).
6. **R6. State a decoder invariant.** Block parsing and LZ4 decoding must be total on corrupt bytes and return a corruption code, never trap, because entries are decoded before their run's CRC is known. Add corrupt-input cases to the merge-session property test (6.4).
7. **R7. Budget the bloom hashes explicitly**: `4 B × (T / min entry bytes)` per output run, the way RocksDB charges `kFilterConstruction`. Do not fold it into the 0.03·T slack (3.3).
8. **R8. Two memtable thresholds.** Request a coalesced ingest at about 7/8 of `memtableBytes` and block at 1×, like RocksDB's `mutable_limit_` (5.1).
9. **R9. Later: grandparent-overlap cuts** for outputs of L1 and deeper (LevelDB and Pebble: 10 × T), to keep future Ln steps short (3.2). This has no effect on random-key L0→L1.
10. **R10. Optional: give `WebAssembly.Memory` a `maximum`** derived from B plus the static size, so a budget miss is always −11 (section 9).

No change is suggested for: the concatenated source; the oldest-first L0 pick rule (it stays, but rarely triggers after R1); 256 KiB read-ahead; the 128 KiB tail; emitting before CRC with install gated on DONE; YIELD between keys; the u32 hash buffer; `mergeSlot`; reservation at `merge_open`; rejecting SST v2.

## 11. What I did not verify

- No code was run, and no number here was measured. The bloom-read overhead (6.4), the 12 MiB saving (R2) and the step bounds from flush splits (R4) are estimates.
- **OPFS write storage.** Whether Chrome, Firefox and Safari keep pending `createWritable` writes on disk or in memory. The spec models them as an in-memory `[[buffer]]`.
- **Browser support** for BYOB readers on `Blob.stream()`, and whether dropping a `WebAssembly.Instance` returns its memory in each engine.
- **Pebble base compactions.** Whether `baseCompactionUsingSeed` can take only the lower sublevels of an interval. I read the comments and `pickL0`, not the full algorithm. Also not checked: whether any Pebble path makes virtual tables for reasons other than excise, delete-only and ingest.
- **RocksDB.** Not read: `level_compaction_dynamic_level_bytes` and how it changes L0→Lbase size; `CompactionPri` effects; the remote-compaction resumption code beyond its option doc. The 16 MB/s default for `delayed_write_rate` comes from the option comment, not from the code that infers it.
- **SlateDB.** RFC-0035 is marked Draft. I read the RFC and the header of `incremental_progress.rs`, not the coordinator logic.
- **TigerBeetle.** Read: `lsm.md`, the top of `compaction.zig`, `constants.zig` and `TIGER_STYLE.md`. Not read: the beat scheduling in `forest.zig`.
- **Not covered at all:** WiredTiger LSM, ScyllaDB and Cassandra compaction, AgateDB, sled. Only one mini-lsm file was read. I found no browser or wasm LSM engine to compare against, and did not search exhaustively.

## 12. Sources

Repo: `docs/research/bounded-compaction-memory.md` and `bounded-compaction-memory/candidate-a.md` / `candidate-b.md`; `packages/kv/src/store/levels.ts`; `crates/engine-core/src/crc32.rs`. Checkout at `5eea20c`.

External. Each was cloned or downloaded on 2026-11-09 at the pin shown, and every link above points into one of these:

- RocksDB `v11.13.2` (commit 17b624b5): https://github.com/facebook/rocksdb/tree/v11.13.2
- Pebble `v2.1.7` (66d468e4): https://github.com/cockroachdb/pebble/tree/v2.1.7
- LevelDB `1.23` (99b3c03b): https://github.com/google/leveldb/tree/1.23
- TigerBeetle `0.17.10` (commit 33fa3531): https://github.com/tigerbeetle/tigerbeetle/tree/0.17.10
- Badger `v4.9.6` (fbd8d2ee): https://github.com/dgraph-io/badger/tree/v4.9.6
- fjall-rs/lsm-tree `3.1.10` (9812163a): https://github.com/fjall-rs/lsm-tree/tree/3.1.10
- SlateDB `v0.18.1` (7351512d): https://github.com/slatedb/slatedb/tree/v0.18.1
- mini-lsm `df2120d7`: https://github.com/skyzh/mini-lsm/blob/df2120d7252ca2180a00a051ab307893a51545ab/mini-lsm/src/table/builder.rs
- WebAssembly spec `f3268fa9`: https://github.com/WebAssembly/spec/tree/f3268fa9dcb7d3a60d09546e743e7281e75cddb0
- WebAssembly memory-control `62fac131`: https://github.com/WebAssembly/memory-control/tree/62fac131de7e6406c9c05b493457025c2e42a15c/proposals/memory-control
- WebAssembly proposals README `df6a2aca`: https://github.com/WebAssembly/proposals/blob/df6a2aca1cd9d779eb4f2f3e19dae8277f336015/README.md
- WHATWG File System `d76d3455`: https://github.com/whatwg/fs/blob/d76d3455d5afe2f85754ed24ffdbf99fe30032d4/index.bs
- W3C File API `2f610830`: https://github.com/w3c/FileAPI/blob/2f610830afbbcb8116c3f3fc22062c0980456291/index.bs
