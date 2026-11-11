# Caps on one atomic write: prior art for kv's batch limits

Question: kv limits a batch to 8 MiB of key plus value bytes, and until PR 180 also to 10,000 ops. Neither cap has a recorded reason. How do other storage engines and databases cap one atomic write batch or transaction, what reasons do they give, and what does that say about kv's options: keep 8 MiB fixed, add a per-op charge, make the cap configurable or derived from `compactionMemoryBytes`, split a large batch across several WAL records, or remove the cap?

## Answer in twelve lines

1. No embedded engine surveyed has an op-count cap. LevelDB, RocksDB, Pebble, SQLite and LMDB bound a write by bytes, pages or memory, never by count (2.2 to 2.5).
2. Op-count caps appear only in hosted or replicated systems, where one op is a unit of server work: etcd 128, DynamoDB 100, Spanner 80,000 mutations (2.7, 2.8).
3. Two systems removed an op-count cap and kept the byte, time or memory cap: Firestore dropped its 500-write limit in March 2023, TiDB dropped its 300,000 key-value limit in v4.0 (2.7, 2.8). None surveyed added one. PR 180 follows the same direction.
4. A byte cap is measured on the resource it protects. FoundationDB counts the bytes of the commit request, CockroachDB the encoded Raft command, etcd and Firestore the request, TiDB (since v6.5) the session's memory (2.1, 2.3, 2.7, 2.8).
5. Per-op overhead is counted when the protected resource is a memory structure. Pebble sizes a batch by what each entry will take in the memtable, node overhead included, and uses that figure for its large-batch decision (2.3). FoundationDB's limit does not count per-mutation overhead (2.1).
6. kv's memtable already charges 256 bytes per row. The batch cap does not. So the stated bound "memtable is at most `memtableBytes` plus one batch" holds in key and value bytes but not in the memtable's own unit once the op cap is gone (section 1, 4.2).
7. Engines with no default cap document the failure it invites. Pebble's notes describe a RocksDB process killed while applying a 1 GB batch, then killed again on every WAL replay (2.3). kv has the same shape: a record too large to fold is persisted first.
8. Configurable caps exist, but they are operator settings on one server or cluster. FoundationDB lets a client only lower the limit. No surveyed system lets each client of a shared log choose its own cap (2.1, 4.3).
9. Systems that accept writes past the memory bound do it in one of two ways. They stream the write to storage before commit (RocksDB write-unprepared, TiDB pipelined DML, SQLite cache spill, LMDB page spill), or they turn the batch into its own sorted layer that skips the memtable (Pebble flushable batch, RocksDB `commit_bypass_memtable`). Both need format or protocol support that kv does not have (2.2 to 2.5, 2.8).
10. The usual advice for a write over the cap is to chunk it and give up atomicity, with an indirection or a "building" state to hide partial work (FoundationDB, CockroachDB, TiDB non-transactional DML, DynamoDB). `document-store-prior-art.md` item F reached the same answer for index backfill.
11. IndexedDB does not force kv's 8 MiB. Chromium refuses one `put` near 127 MiB and Firefox near 255 MiB. No per-transaction size limit was found in either. WebKit shows only a quota check (2.6).
12. Recommendation (inference, section 5): keep a fixed cap, keep the op cap removed, and add a fixed per-op charge equal to the memtable's 256 bytes. Do not make the cap a per-`openDb` option. Do not split or remove it now.

---

Conventions as in `document-store-prior-art.md`. **[R]** repo fact, cited `file:line`. **[E key]** external fact; keys resolve in section 7. **[I]** my inference. Nothing was run in this task.

Method. Source files and raw documentation were downloaded with `curl` and read locally by search. Documentation that exists only as HTML (SQLite, Firestore, DynamoDB, Spanner, the HTML standard) was stripped to text locally before reading; quotes are exact but layout is lost. Line numbers are from each default branch on 2026-11-11. Large files were read by search, not end to end. Section 6 lists what this leaves unconfirmed.

---

## 1. Repo facts

- [R] Limits: key 8 KiB, value 16 MiB, 10,000 ops and 8 MiB per batch (`packages/kv/src/check.ts:3-8`, `docs/design.md:665-673`). The file's history starts at the initial import (`67af728`); no commit or document gives a reason for either batch figure.
- [R] The byte count is key bytes plus value bytes. Nothing is added per op (`check.ts:54-58`, `:66-83`). `checkKey` has no minimum length (`check.ts:37-43`).
- [R] A batch is one WAL record: one `ArrayBuffer` in one IndexedDB row. Each op costs 5 bytes of framing for a delete and 9 for a put (`docs/design.md:55-66`).
- [R] After the append commits, the tab posts `{ kind: "append", seq, ops }` on a `BroadcastChannel`, so every other tab receives the ops as objects (`docs/design.md:338`).
- [R] The memtable counts key bytes, value bytes and 256 bytes per live row. `memtableBytes` bounds that sum, 16 MiB by default. The thresholds are checked only on a write (`docs/design.md:146-156`, `packages/kv/src/store/memtable.ts:28-38`). The comment on `ROW_OVERHEAD` says V8 in Node holds 290 to 510 bytes per row and 256 is an estimate for Chrome.
- [R] A flush run reads WAL records up to `flushRunBytes` of op bytes, and "a run takes at least one record" (`docs/design.md:398-409`). `flushRunBytes` is 0.875 MiB at a 16 MiB budget, 1.75 MiB at 32 MiB and 3.5 MiB at 64 MiB (`docs/design.md:495-499`). The host uses the smallest `compactionMemoryBytes` any open tab passed, minimum 8 MiB (`docs/design.md:489-492`).
- [R] `bounded-compaction-memory.md` states the two bounds the cap serves: a flush folds "at most `flushRunBytes` of op bytes per L0 run and always at least one record" (`:212-213`), and "`memtable ≤ memtableBytes + one batch`" (`:332`).
- [R] `document-store-prior-art.md` already cites FoundationDB's 10,000,000 byte and five second limits and the Firestore SDK's 50-document backfill passes (`:170-171`), and rates atomic writes above the batch limits "not-needed" (`:294-297`).
- Not a repo fact: the figure of about 185 bytes per op object comes from the task brief (a Node measurement). It was not re-measured here.

[I] Two consequences of the facts above, by arithmetic only:

- A single record can already exceed `flushRunBytes` at every budget in the table, since 8 MiB is larger than 3.5 MiB. The batch cap, not `flushRunBytes`, is what bounds the largest flush run.
- With the op cap removed and no per-op charge, the byte cap does not bound op count in any useful way. 8 MiB of 4-byte-key deletes is 2,097,152 ops. That is an 18 MiB WAL record (9 bytes each), about 370 MiB of op objects per context at 185 bytes, and up to 520 MiB of memtable charge at 260 bytes per row if the keys are distinct. With the old cap of 10,000 ops the memtable charge of one batch's overhead was at most 2.4 MiB. A batch of deletes of the empty key counts zero bytes at any length, as far as `check.ts` shows.

---

## 2. Findings by system

### 2.1 FoundationDB

- [E fdb-lim] "Transaction size cannot exceed 10,000,000 bytes of affected data. Keys, values, and ranges that you write are included as affected data. Keys and ranges that you read are also included as affected data, but values that you read are not" (`known-limitations.rst:28`). Confirms the figure already cited in `document-store-prior-art.md`.
- [E fdb-lim] Reason and softer guidance: "If any single transaction exceeds one megabyte of affected data, you should modify your design. In the current version, these large transactions can cause performance issues and database availability can (briefly) be impacted" (`:30`).
- [E fdb-lim] "Keys cannot exceed 10,000 bytes in size. Values cannot exceed 100,000 bytes in size" (`:41`). [E fdb-knobs] The three figures are client knobs: `TRANSACTION_SIZE_LIMIT 1e7`, `KEY_SIZE_LIMIT 1e4`, `VALUE_SIZE_LIMIT 1e5` (`ClientKnobs.cpp:183-186`).
- [E fdb-opt] Configurable downward only. The `size_limit` transaction option: "The size is calculated by combining the sizes of all keys and values written or mutated, all key ranges cleared, and all read and write conflict ranges. (In other words, it includes the total size of all data included in the request to the cluster to commit the transaction.) Large transactions can cause performance problems on FoundationDB clusters, so setting this limit to a smaller value than the default can help prevent the client from accidentally degrading the cluster's performance. This value must be at least 32 and cannot be set to higher than 10,000,000" (`fdb.options:306-308`). [E fdb-native] The code clamps the option to `[32, TRANSACTION_SIZE_LIMIT]` (`NativeAPI.cpp:5044`).
- [E fdb-native] The check runs in the client at commit: `if (transactionSize > trState->options.sizeLimit) return transaction_too_large();` (`NativeAPI.cpp:4764-4782`).
- [E fdb-commit] Per-op overhead is not counted. The size is `read_conflict_ranges.expectedSize() + write_conflict_ranges.expectedSize() + mutations.expectedSize()` (`CommitTransaction.h:533-535`), and a mutation's `expectedSize()` is `param1.size() + param2.size()` (`:140`). A separate `totalSize()` that adds `OVERHEAD_BYTES` exists (`:136-139`) but is not the one the limit uses.
- [I] There is still an implicit per-op charge: each `set` adds a write conflict range, whose key bytes count. So a write costs roughly twice its key plus its value against the limit.
- [E fdb-lim] No op-count cap. Advice for larger writes: "The effect of long and large transactions can be achieved using short and small transactions", and for bulk inserts "it can use a level of indirection to swap in the inserted data quickly" (`:95-99`).

### 2.2 RocksDB and LevelDB

- [E rdb-wb] A `WriteBatch` is one contiguous byte buffer: a 12-byte header (sequence, count) then records of a type byte and length-prefixed strings (`db/write_batch.cc:10-24`). LevelDB has the same layout (`db/write_batch.cc:5-14` [E ldb-wb]).
- [E rdb-wbh] No cap by default. The constructor takes `max_bytes = 0` (`write_batch.h:66`), documented as "Maximum size of rep_" (`:534-535`). [E rdb-wbi] When set, a write that takes the buffer past it is undone and returns `Status::MemoryLimit()` (`write_batch_internal.h:306-314`). The cap is on the encoded buffer, so it includes the per-record framing but not the memtable's per-entry overhead.
- [E rdb-txn] Transactions expose the same cap: `TransactionOptions::max_write_batch_size`, "The maximum number of bytes used for the write batch. 0 means no limit" (`transaction_db.h:363-364`). `WriteBatchWithIndex` takes the same `max_bytes` (`write_batch_with_index.h:113-122` [E rdb-wbwi]). No reason is stated in either header.
- [E rdb-opt] `max_write_batch_group_size_bytes` is not a batch cap. It limits how many waiting batches the group-commit leader merges into one WAL write: "The maximum limit of number of bytes that are written in a single batch of WAL or memtable write. It is followed when the leader write size is larger than 1/8 of this limit. Default: 1 MB" (`options.h:1499-1504`). The code comment gives the reason: "if the original write is small, limit the growth so we do not slow down the small write too much" (`db/write_thread.cc:449-458` [E rdb-wt]). A single batch larger than the limit still goes through alone. LevelDB hard-codes the same rule at 1 MiB and 128 KiB (`db/db_impl.cc:1288-1311` [E ldb-impl]).
- [E rdb-txn] Internal splitting exists for one write policy. `default_write_batch_flush_threshold`: "This option is only valid for write unprepared. If a write batch exceeds this threshold, then the transaction will implicitly flush the currently pending writes into the database. A value of 0 or less means no limit" (`transaction_db.h:242-245`, per-transaction override `:379-382`).
- [E rdb-txn] Memtable bypass exists for another. `commit_bypass_memtable`, marked experimental: "the transaction will skip memtable write and ingest into the DB directly during Commit(). This makes Commit() much faster for transactions with many operations ... the transaction will be ingested as an immutable memtable for CFs it updates, and the current memtable will be switched to a new one. So ingesting many transactions in a short period of time may cause stall due to too many memtables" (`:416-438`). It can be triggered by op count (`large_txn_commit_optimize_threshold`) or by bytes (`large_txn_commit_optimize_byte_threshold`), both off by default (`:440-454`).
- [E ldb-wbh] LevelDB's public `WriteBatch` header has no size or count limit (`include/leveldb/write_batch.h`, searched for "limit" and "max": no match).

### 2.3 Pebble and CockroachDB

- [E pb-open] Pebble's only hard cap is the format's: `maxBatchSize = min(math.MaxUint32, math.MaxInt)`, "so that the exclusive end of an allocation fits in uint32" (`open.go:40-45`). Exceeding it panics with `ErrBatchTooLarge`, "the size of this batch is over the limit of 4GB" (`batch.go:49-50`, `:1684-1685` [E pb-batch]). [E pb-batch] The op count is limited to `MaxUint32` by the header field (`batch.go:1722-1723`).
- [E pb-doc] "The size of a batch is limited only by available memory, yet the required memory is not just the batch representation ... Each skiplist entry has overhead for the index links and other metadata that is a dozen bytes at minimum. A large batch composed of many small records can require twice as much memory when inserted into a memtable than it required in the batch" (`docs/rocksdb.md:168-180`).
- [E pb-doc] The failure with no cap, as Pebble describes RocksDB: "while RocksDB may be configured with a 64MB memtable size, a 1GB batch will cause the memtable to grow to accommodate it ... Adding the large batch to the memtable may consume so much memory that the system runs out of memory and is killed by the kernel. This can result in a death loop because upon restarting as the batch is read from the WAL and applied to the memtable again" (`:198-205`).
- [E pb-doc] Pebble's answer is a memtable bypass: "A batch that is too large to fit in the memtable causes the current mutable memtable to be marked as immutable and the batch is wrapped in a `flushableBatch` structure and added to the list of immutable memtables. Because the `flushableBatch` is readable as another layer in the LSM, the batch commit can return as soon as the `flushableBatch` has been added" (`:207-217`). The batch is sorted once instead of inserted: "Sorting is significantly faster and uses significantly less memory due to not having to copy the batch records" (`:219-224`).
- [E pb-open] [E pb-db] The threshold is derived from the memtable budget, not set on its own: `largeBatchThreshold: (opts.MemTableSize - uint64(memTableEmptySize)) / 2` (`open.go:160`), tested as `batch.memTableSize >= d.largeBatchThreshold` (`db.go:830-832`). `MemTableSize` defaults to 4 MB (`options.go:1024-1025` [E pb-opt]).
- [E pb-batch] [E pb-mem] Per-op overhead is counted in that comparison. Every `Set` or `Delete` adds `memTableEntrySize(keyLen, valueLen)` to `batch.memTableSize` (`batch.go:738`, `:791`), and that function is `arenaskl.MaxNodeSize(keyBytes, valueBytes)`, the full skiplist node (`mem_table.go:24-26`).
- [E crdb-base] CockroachDB caps the replicated unit, not the transaction: `kv.raft.command.max_size`, "maximum size of a raft command", default 64 MB, floor 4 MB, a cluster setting. The source comment on the setting says it is "used by SQL/bulk to determine mutation batch sizes" (`kvserverbase/base.go:449-466`).
- [E crdb-raft] It is checked against the encoded proposal: `quotaSize := uint64(proposal.command.Size())`, then "command is too large: %d bytes (max: %d)" (`replica_raft.go:289-294`). So framing is counted, because the encoded command is what is measured.
- [E crdb-set] A transaction has separate memory budgets instead of a size cap: `kv.transaction.max_intents_bytes`, "maximum number of bytes used to track locks in transactions", default 4194304, and `kv.transaction.reject_over_max_intents_budget.enabled`, default false: "transactions that exceed their lock tracking budget ... are rejected instead of having their lock spans imprecisely compressed" (`settings.html`).
- [E crdb-del] Advice for a large write: "To manually delete a large number of rows (i.e., tens of thousands of rows or more), we recommend iteratively deleting subsets of the rows ... To determine the optimal batch size, try out different batch sizes (1,000 rows, 10,000 rows, 100,000 rows, etc.) and monitor the change in performance" (`bulk-delete-data.md:12`, `:55`).

### 2.4 SQLite

- [E sq-lim] [E sq-h] SQLite caps the statement, not the transaction. Statement length: `SQLITE_MAX_SQL_LENGTH`, default 1,000,000,000 bytes, lowerable at run time with `sqlite3_limit` (`sqliteLimit.h:88-89`). Host parameters: `SQLITE_MAX_VARIABLE_NUMBER`, "defaults to 999 for SQLite versions prior to 3.32.0 (2020-05-22) or 32766 for SQLite versions after 3.32.0" (`sqliteLimit.h:189-190`). Row or blob: `SQLITE_MAX_LENGTH`, 1,000,000,000 (`:23-24`).
- [E sq-lim] The stated reason for the parameter cap is memory: "SQLite allocates space to hold all host parameters between 1 and the largest host parameter number used ... To prevent excessive memory allocations, the maximum value of a host parameter number is SQLITE_MAX_VARIABLE_NUMBER". This is the one count cap in SQLite's write path, and it was raised from 999 to 32,766, not removed.
- [E sq-lim] The limits page lists no cap on the size of a transaction. The bounds it lists are the database size (4294967294 pages) and the file system.
- [E sq-atomic] A transaction larger than the page cache spills: "sometimes a larger change will overflow the user-space cache prior to transaction commit. In those cases, the cache must spill to the database before the transaction is complete" (section 6.3). Memory stays bounded by the cache; disk absorbs the rest.
- [E sq-wal] WAL growth: "A checkpoint can only complete when no other transactions are running, which means the WAL file cannot be reset in the middle of a write transaction. So a large change to a large database might result in a large WAL file ... As of SQLite version 3.11.0 (2016-02-15), the WAL file for a single transaction should be proportional in size to the transaction itself."
- [E sq-wal] Guidance: "WAL works best with smaller transactions ... For transactions larger than about 100 megabytes, traditional rollback journal modes will likely be faster. For transactions in excess of a gigabyte, WAL mode may fail with an I/O or disk-full error", followed by the note that since 3.11.0 "WAL mode works as efficiently with large transactions as does rollback mode".

### 2.5 LMDB

- [E lmdb-h] No byte or op cap on a write transaction. Two things bound it. The map: "The size of the memory map is also the maximum size of the database" (`lmdb.h:855-858`), error `MDB_MAP_FULL`. The dirty page list: `MDB_TXN_FULL`, "the transaction has too many dirty pages" (`lmdb.h:459`, `:1377`).
- [E lmdb-c] [E lmdb-midl] The dirty list holds `MDB_IDL_UM_MAX` pages, set at transaction start (`mdb.c:3171`); that is `2^17 - 1` = 131,071 (`midl.h:59-66`). It is a compile-time constant.
- [E lmdb-c] Since page spilling was added the list is a memory bound, not a transaction bound: "Spill pages from the dirty list back to disk. This is intended to prevent running into MDB_TXN_FULL situations ... if not using nested txns, it is expected that apps will not run into MDB_TXN_FULL any more. The pages are flushed to disk the same way as for a txn commit" (`mdb.c:2325-2336`).
- [I] The unit is pages, so per-key overhead is counted for free: many tiny keys dirty pages like anything else.
- MDBX was not read.

### 2.6 IndexedDB, structured clone and BroadcastChannel

- [E idb-spec] The specification sets no size limit for a value or a transaction. The only size-related failure it names is `QuotaExceededError`, "not enough remaining storage space, or the storage quota was reached" (`index.bs:1960-1962`).
- [E chr-mojom] [E chr-txn] Chromium caps one `put`. `kIDBMaxMessageSize = 134217728`, "128MB, originally based on IPC::mojom::kChannelMaximumMessageSize", minus `kIDBMaxMessageOverhead = 1048576`, "1MB; arbitrarily chosen" (`indexeddb.mojom:14-21`). The renderer sums value, primary key and index key sizes and fails the request with "The serialized keys and/or value are too large (size={} bytes, max={} bytes)" when the estimate reaches the limit (`idb_transaction.cc:546-559`). So the usable size of one value is about 127 MiB, and the reason is the IPC message size.
- [E chr-mojom] Chromium wraps large values in a blob: `kIDBWrapThreshold = 65536`. Reason given: "LevelDB, the underlying storage for IndexedDB, was not designed with large values in mind. At the very least, large values will slow down compaction, causing occasional I/O spikes" (`indexeddb.mojom:23-30`). A kv WAL record over 64 KiB is therefore stored outside the LevelDB keyspace in Chromium [I, from the threshold; the wrap path itself was not traced for `ArrayBuffer` values].
- [E ff-mgr] [E ff-store] Firefox caps one `put` in two ways. The structured clone: `kDefaultMaxStructuredCloneSize = 1042 * 1024 * 1024`, a preference. The IPC message: `kDefaultMaxSerializedMsgSize = IPC::Channel::kMaximumMessageSize` (`IndexedDatabaseManager.cpp:114-131`), which is `256 * 1024 * 1024` (`ipc_channel.h:75` [E ff-ipc]), minus a 1 MB overhead allowance. Over it the request throws "The serialized value is too large (size=%zu bytes, max=%zu bytes)" (`IDBObjectStore.cpp:955-1004`).
- [E ff-mgr] [E ff-actors] Firefox stores large values outside the database: `kDefaultDataThresholdBytes = 1024 * 1024`, "Anything smaller than the threshold is compressed and stored in the database. Anything larger is compressed and stored outside the database" (`IndexedDatabaseManager.cpp:114-117`, used at `ActorsParent.cpp:19157-19159`).
- [E wk-udb] WebKit: the files read show a quota check before a put, returning `QuotaExceededError` (`UniqueIDBDatabase.cpp:1009-1010`), and no fixed per-value size check. Unconfirmed beyond those files.
- Per-transaction size: no limit was found in the Chromium renderer files or the Firefox files read. Unconfirmed either way for the browser back ends.
- [E html-msg] `BroadcastChannel.postMessage`: the HTML standard's web messaging chapter states no size limit. The only error it gives for the message itself is `DataCloneError` when it cannot be cloned. Engine-level limits on a broadcast message were not confirmed.
- [I] kv's 8 MiB sits 16 times under the tightest per-value limit found (Chromium's 127 MiB). IndexedDB is not the reason for 8 MiB and does not force a lower figure. It does force some cap: an uncapped batch would fail in Chromium past 127 MiB with an `UnknownError` from the browser instead of a `ConstraintError` from kv.

### 2.7 Firestore, DynamoDB and Spanner

- [E fs-rel] Firestore removed its op-count cap. Release note of March 29, 2023: "Firestore no longer limits the number of writes that can be passed to a Commit operation or performed in a transaction. Previously, the limit was 500. Limits for request size and the transaction time limit still apply."
- [E fs-quota] What remains: "Maximum API request size 10 MiB", "Time limit for a transaction 270 seconds, with a 60-second idle expiration time", and "Maximum number of field transformations that can be performed on a single document in a Commit operation or in a transaction 500". The byte cap is on the request, so per-write encoding is counted.
- [E ddb-tx] DynamoDB publishes both kinds: "`TransactWriteItems` is a synchronous write operation that groups up to 100 action requests ... The aggregate size of the items in the transaction cannot exceed 4 MB." [E ddb-new] The count was raised, not removed: "Amazon DynamoDB now supports up to 100 actions per transaction" (September 2022). The earlier figure was not extracted from the announcement.
- [E ddb-bw] The non-atomic batch path is smaller in count and larger in bytes: "A single call to BatchWriteItem can transmit up to 16MB of data over the network, consisting of up to 25 item put or delete operations". The advice for more is a loop over `UnprocessedItems`.
- [E sp-lim] Spanner publishes both kinds: "Commit size (including indexes and change streams) 100 MiB" and "Mutations per commit (for Mutation API) (including indexes) 80,000". The count is in cells, not rows: "Insert and update operations count with the multiplicity of the number of columns they affect ... Delete and delete range operations count as one mutation regardless of the number of columns affected", except that secondary index changes "will be counted individually". The same page lists partitioned DML as a separate, non-atomic path with its own limit.
- No stated reason for the count caps was found on these pages.

### 2.8 TiDB, TiKV and etcd

- [E tidb-txn] TiDB removed its count cap: "TiDB previously limited the total number of key-value pairs for a single transaction to 300,000. This restriction was removed in TiDB v4.0." The byte cap stayed: "By default, TiDB sets the total size of a single transaction to no more than 100 MB ... The maximum value of `txn-total-size-limit` is 1 TB." The v4.0 page gave that maximum as 10 GB [E tidb-txn40].
- [E tidb-txn] The stated reason is memory: "Because optimistic transactions first cache the changes in private memory, TiDB limits the size of a single transaction", and "the memory usage of the TiDB process is scaled up comparing with the transaction size, up to two to three times or more of the transaction size".
- [E tidb-cfg] The byte cap was then replaced by a memory quota: "In TiDB v6.5.0 and later versions, this configuration is no longer recommended. The memory size of a transaction will be accumulated into the memory usage of the session, and the `tidb_mem_quota_query` variable will take effect when the session memory threshold is exceeded." The cap went from key-value bytes to measured memory, which includes per-entry overhead.
- [E tidb-kv] [E tidb-cfgsrc] The old cap counted key and value bytes only: `TxnEntrySizeLimit` "is limit of single entry size (len(key) + len(value))", `TxnTotalSizeLimit` "is limit of the sum of all entry size" (`pkg/kv/kv.go:59-62`); defaults 6 MiB and 100 MiB (`pkg/config/config.go:59-69`).
- [E tidb-cfg] A statement-count cap remains in one mode only: `stmt-count-limit`, default 5000, "takes effect only in the retryable optimistic transaction". [E tikv-cfg] The replicated unit has its own cap: TiKV `raft-entry-max-size`, "The hard limit on the maximum size of a single log", default 8 MiB.
- [E tidb-pipe] Internal splitting, experimental since v8.0.0: with pipelined DML "TiDB streams data directly to the storage layer during DML operations, instead of buffering it entirely in memory", to "perform large-scale data operations without being constrained by TiDB memory limits". In this mode "transaction size is not limited by the TiDB configuration item `txn-total-size-limit`" [E tidb-cfg].
- [E tidb-nt] The non-atomic path: a non-transactional DML statement "is a DML statement split into multiple SQL statements ... at the expense of transactional atomicity and isolation. Usually, memory-consuming transactions need to be split into multiple SQL statements to bypass the transaction size limit. Non-transactional DML statements integrate this process into the TiDB kernel".
- [E etcd-cfg] etcd publishes both kinds, both configurable flags: `--max-txn-ops`, "Maximum number of operations permitted in a transaction", default 128; `--max-request-bytes`, "Maximum client request size in bytes the server will accept", default `1.5 * 1024 * 1024` (`server/embed/config.go:62-65`, `:620-621`). Errors: "too many operations in txn request" and "request is too large" (`rpctypes/error.go:28`, `:56` [E etcd-err]).
- [E etcd-lim] Reason for the byte cap: "etcd is designed to handle small key value pairs typical for metadata. Larger requests will work, but may increase the latency of other requests." No reason for the op cap was found in the files read.

---

## 3. Comparison

| System | What is capped | Default | Configurable | Counts per-op overhead | Advice or mechanism for larger writes |
|---|---|---|---|---|---|
| kv today | Key plus value bytes; ops until PR 180 | 8 MiB; 10,000 | No | No | None |
| FoundationDB | Bytes of the commit request; time | 10,000,000 bytes; 5 s | Lower only | No. Conflict range keys are counted | Many small transactions plus an indirection |
| RocksDB `WriteBatch` | Encoded buffer bytes | None | Yes, `max_bytes` | Framing only | None needed by default |
| RocksDB transactions | Encoded buffer bytes | None | Yes, `max_write_batch_size` | Framing only | Write-unprepared flush threshold; experimental memtable bypass |
| LevelDB | Nothing | None | No | Not applicable | Not applicable |
| Pebble | Format limit only | 4 GB | No | Yes, in the large-batch test | Flushable batch skips the memtable above half the memtable size |
| CockroachDB | Encoded Raft command; lock-tracking memory | 64 MB; 4 MiB | Cluster settings | Yes, encoded size | Loop over row-limited batches |
| SQLite | Statement bytes; parameter count | 1e9; 32,766 | Compile time, lower at run time | Not applicable | Cache spill; rollback journal for very large transactions on old versions |
| LMDB | Dirty pages in memory; map size | 131,071 pages | Compile time; map size at open | Yes, unit is pages | Page spill |
| IndexedDB, Chromium | One put's serialized bytes | About 127 MiB | No | Keys and index keys counted | Values over 64 KiB wrapped in a blob |
| IndexedDB, Firefox | One put's IPC message; clone size | About 255 MiB; 1042 MiB | Preferences | Keys and index keys counted | Values over 1 MB stored outside the database |
| Firestore | Request bytes; time | 10 MiB; 270 s | No | Yes, request encoding | Chunk. Op cap of 500 removed in 2023 |
| DynamoDB transaction | Ops and item bytes | 100; 4 MB | No | Unconfirmed | `BatchWriteItem` loop, not atomic |
| Spanner | Commit bytes and mutations | 100 MiB; 80,000 | No | Count is per cell and per index entry | Partitioned DML, not atomic |
| TiDB | Memory of the session; was key-value bytes, and before v4.0 also 300,000 entries | Memory quota; was 100 MB | Yes | Yes since v6.5, no before | Pipelined DML; non-transactional DML |
| etcd | Ops and request bytes | 128; 1.5 MiB | Flags | Yes, request encoding | None stated |

---

## 4. Synthesis

### 4.1 Patterns that recur

- [I] **Byte cap only** is the common end state. FoundationDB has always had it. Firestore and TiDB arrived at it by deleting a count cap. Embedded engines never had a count cap.
- [I] **Op cap plus byte cap** survives where an op is a unit of metered or replicated server work (DynamoDB, Spanner, etcd). None of them gives memory as the reason, and none of the pages read gives any reason. kv has no such per-op server cost, so these are weak precedents for kv.
- [I] **The cap is measured on the protected resource.** Request bytes when the resource is a network message or a Raft entry. Memtable entry size when the resource is a memtable (Pebble). Measured memory when the resource is the process heap (TiDB after v6.5). Pages when the resource is a page list (LMDB). A cap in a different unit from the resource is the case that needed fixing: TiDB's key-value byte cap understated memory by "two to three times or more" and was replaced.
- [I] **Configurable caps are operator knobs on a single authority**: a cluster setting, a server flag, a compile-time constant, or a per-transaction option inside one process. FoundationDB, the one system where many clients share the limit, lets a client only lower it.
- [I] **Past the memory bound there are two mechanisms.** Streaming before commit (RocksDB write-unprepared, TiDB pipelined DML, SQLite cache spill, LMDB page spill) needs a way to hide and roll back uncommitted data on disk. A sorted side layer (Pebble flushable batch, RocksDB `commit_bypass_memtable`) needs the read path to treat the batch as one more run. Both are marked experimental in RocksDB and TiDB.
- [I] **No cap is a documented hazard when the write is logged before it is applied.** Pebble's account of the RocksDB death loop is the clearest statement.

### 4.2 Reasons the systems give

- Memory: TiDB ("cache the changes in private memory"), SQLite's parameter cap ("prevent excessive memory allocations"), Pebble (memtable growth and the out-of-memory loop), LMDB (dirty list).
- Shared-service latency and availability: FoundationDB ("performance issues and database availability can (briefly) be impacted"), etcd ("may increase the latency of other requests"), RocksDB and LevelDB group commit ("do not slow down the small write too much").
- Transport: Chromium and Firefox IndexedDB (IPC message size), CockroachDB and TiKV (Raft entry size).
- Storage engine fit: Chromium's wrap threshold ("LevelDB ... was not designed with large values in mind").
- Not stated: every op-count cap surveyed.

### 4.3 What this suggests for each kv option

All of this subsection is inference.

- **Keep 8 MiB fixed.** Well supported as a shape: a fixed, small, non-negotiable cap is what FoundationDB does, and 8 MiB is close to FoundationDB's 10 MB, Firestore's 10 MiB and TiKV's 8 MiB Raft entry. IndexedDB allows far more, so the figure is kv's own choice. What it protects is flush memory (one record must fit in a flush run at the smallest budget) and the memtable overshoot. Against the minimum `compactionMemoryBytes` of 8 MiB the figure is already tight: one maximal record equals the whole budget. That argues against raising it, and is a reason to write the rationale down.
- **Add a fixed per-op charge.** Supported by Pebble, which sizes a batch by memtable entry size for exactly this decision, and by TiDB's move from key-value bytes to measured memory. It is also the only option that restores what the op cap did after PR 180: bound the number of objects a batch creates in every tab and in the fold. A charge equal to the memtable's `ROW_OVERHEAD` makes the batch cap and the memtable's `bytes` the same unit, so "`memtable ≤ memtableBytes + one batch`" becomes true as written. At 256 bytes per op an 8 MiB cap admits at most 32,768 empty ops, three times the old op cap, with a single error message and a single number to document. It also closes the zero-byte case (deletes of the empty key).
- **Make the cap an `openDb` option, or derive it from `compactionMemoryBytes`.** Weakly supported. The precedents for configurable caps have one authority. In kv the record is shared: a tab that opens with a large cap writes a record that a host running at another tab's smaller `compactionMemoryBytes` must fold, and that every other tab must apply to its own memtable. FoundationDB's lower-only rule is the pattern that fits a shared log: a caller-side option that only lowers the cap would be safe, and raising it would need a value stored in the database and agreed by all openers. Deriving the cap from the budget has the same problem in a different form, because the budget is the minimum over open tabs and changes as tabs come and go.
- **Split a large batch across several WAL records in one IndexedDB transaction.** The precedents (write-unprepared, pipelined DML) show this is a feature with its own protocol, not a detail. IndexedDB would make the append atomic for free. The rest of kv assumes one record is one atomic batch: tabs apply the tail record by record, and a flush run may end after any record. A split batch would need a group marker that the tail reader, the fold and the flush boundary all honour. It would bound flush memory per record, which is the one thing the fixed cap does not do well, so it is the right direction if large atomic writes are ever required. Nothing surveyed suggests they are; `document-store-prior-art.md` item F rates them not-needed.
- **Remove the cap.** Supported only by engines that then needed a second mechanism (Pebble's flushable batch) or that document the failure (RocksDB). kv persists the record before any tab or the host applies it, so an oversized record would fail every later fold and every later open, which is the death loop Pebble describes. Chromium would also reject the row near 127 MiB with its own error. Not supported.

---

## 5. Recommendation

Inference, kept apart from the findings.

1. Keep the op cap removed (PR 180). Firestore and TiDB did the same, and no embedded engine has one.
2. Keep one fixed byte cap, and count each op as its key bytes, its value bytes and a fixed 256 bytes, the same figure the memtable charges per row. This is the Pebble pattern. It keeps a single limit and makes the memory bound in `bounded-compaction-memory.md` hold in the memtable's unit.
3. Leave the figure at 8 MiB unless a measurement says otherwise, and record the reason in `docs/design.md`: one record must fit in a flush run at the smallest budget, and the memtable may overshoot by one batch.
4. Do not add an `openDb` option that can raise the cap. If a knob is wanted, make it lower-only, as FoundationDB does.
5. Do not split batches across records and do not remove the cap. Revisit splitting only with a concrete need for an atomic write above the cap; the chunk-and-hide pattern covers bulk load and index backfill.

Evidence that would change this: a measurement showing the per-op object cost in Chrome is far from 256 bytes (change the charge, not the design); a real workload that needs more than about 32,000 small ops in one atomic batch (then weigh a lower charge or record splitting); or a finding that the flush fold needs much more than one record's bytes of memory at the 8 MiB budget (then lower the cap or raise the minimum budget).

---

## 6. What I did not verify

- The 185 bytes per op object figure. It comes from the task brief. The repo's own figure is the 256-byte `ROW_OVERHEAD` estimate.
- PR 180 itself was not read. Its effect is taken from the task brief. `check.ts` on `main` at `b95d132` still has the op cap.
- Whether empty keys are rejected anywhere outside `check.ts`. If they are, the zero-byte batch case in section 1 does not arise; the small-key case still does.
- Whether a single `put` goes through the 8 MiB batch check. The value limit is 16 MiB and the batch limit is 8 MiB; how they interact on the `put` path was not traced.
- Any per-transaction size limit in IndexedDB. None was found in the Chromium renderer files or Firefox files read; the browser-side back ends were not searched. Chromium's newer SQLite back end for IndexedDB was not read at all.
- WebKit's per-value limit. Only a quota check was found in three files.
- That Chromium's 64 KiB wrap applies to a bare `ArrayBuffer` value. The threshold is confirmed; the path was not traced.
- Any engine-level size limit on a `BroadcastChannel` message or a structured clone outside IndexedDB. The HTML standard states none.
- The reason for any op-count cap (etcd, DynamoDB, Spanner, Firestore's former 500). No primary source read states one.
- DynamoDB's transaction limit before September 2022, and whether the 4 MB aggregate counts attribute names or request framing.
- Spanner's history of the mutation limit.
- RocksDB's reason for `max_write_batch_size`. The header gives none. Whether `WriteBatchWithIndex` counts its index memory toward `max_bytes` was not checked; the cap is on the underlying batch.
- CockroachDB's product documentation on transaction size beyond the bulk-delete page. The claim that SQL splits mutations by `kv.raft.command.max_size` rests on one source comment.
- LMDB's default map size: `lmdb.h:855` says 10485760 bytes, `mdb.c:779` defines `DEFAULT_MAPSIZE 1048576`. Not resolved. MDBX was not read.
- FoundationDB's five second limit was not re-read; it is cited from the earlier note.
- TiKV's large-transaction protocol itself (the v4.0 change). Only TiDB's documentation of the removed limit was read.

---

## 7. Sources

Repo, checkout at `b95d132`: `packages/kv/src/check.ts`, `packages/kv/src/store/memtable.ts`, `docs/design.md` (sections "WAL records", "Append", "Memtable", "Flush", "Memory budget", "Limits", "Seeing other tabs' writes"), `docs/research/bounded-compaction-memory.md` (`:205-246`, `:328-336`), `docs/research/document-store-prior-art.md` (`:168-175`, `:290-297`).

External, fetched 2026-11-11, raw unless marked:

- `fdb-lim` https://raw.githubusercontent.com/apple/foundationdb/main/documentation/sphinx/source/known-limitations.rst
- `fdb-knobs` https://raw.githubusercontent.com/apple/foundationdb/main/fdbclient/ClientKnobs.cpp
- `fdb-opt` https://raw.githubusercontent.com/apple/foundationdb/main/fdbclient/vexillographer/fdb.options
- `fdb-native` https://raw.githubusercontent.com/apple/foundationdb/main/fdbclient/NativeAPI.cpp
- `fdb-commit` https://raw.githubusercontent.com/apple/foundationdb/main/fdbclient/include/fdbclient/CommitTransaction.h
- `rdb-opt` https://raw.githubusercontent.com/facebook/rocksdb/main/include/rocksdb/options.h
- `rdb-wbh` https://raw.githubusercontent.com/facebook/rocksdb/main/include/rocksdb/write_batch.h ; `rdb-wb` same repo `db/write_batch.cc` ; `rdb-wbi` `db/write_batch_internal.h` ; `rdb-wt` `db/write_thread.cc`
- `rdb-wbwi` https://raw.githubusercontent.com/facebook/rocksdb/main/include/rocksdb/utilities/write_batch_with_index.h
- `rdb-txn` https://raw.githubusercontent.com/facebook/rocksdb/main/include/rocksdb/utilities/transaction_db.h
- `ldb-wb` https://raw.githubusercontent.com/google/leveldb/main/db/write_batch.cc ; `ldb-wbh` `include/leveldb/write_batch.h` ; `ldb-impl` `db/db_impl.cc`
- `pb-doc` https://raw.githubusercontent.com/cockroachdb/pebble/master/docs/rocksdb.md
- `pb-batch` https://raw.githubusercontent.com/cockroachdb/pebble/master/batch.go ; `pb-open` `open.go` ; `pb-db` `db.go` ; `pb-mem` `mem_table.go` ; `pb-opt` `options.go`
- `crdb-base` https://raw.githubusercontent.com/cockroachdb/cockroach/master/pkg/kv/kvserver/kvserverbase/base.go ; `crdb-raft` `pkg/kv/kvserver/replica_raft.go` ; `crdb-set` `docs/generated/settings/settings.html`
- `crdb-del` https://raw.githubusercontent.com/cockroachdb/docs/main/src/current/v25.2/bulk-delete-data.md
- `sq-h` https://raw.githubusercontent.com/sqlite/sqlite/master/src/sqliteLimit.h
- `sq-lim` https://www.sqlite.org/limits.html (HTML, stripped) ; `sq-wal` https://www.sqlite.org/wal.html (HTML, stripped) ; `sq-atomic` https://www.sqlite.org/atomiccommit.html (HTML, stripped)
- `lmdb-h` https://raw.githubusercontent.com/LMDB/lmdb/mdb.master/libraries/liblmdb/lmdb.h ; `lmdb-c` same directory `mdb.c` ; `lmdb-midl` `midl.h`
- `idb-spec` https://raw.githubusercontent.com/w3c/IndexedDB/main/index.bs
- `chr-mojom` https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/public/mojom/indexeddb/indexeddb.mojom ; `chr-txn` https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/indexeddb/idb_transaction.cc ; also read `idb_object_store.cc`, `idb_value_wrapping.h` and `.cc`, `modules/broadcastchannel/broadcast_channel.cc`
- `ff-mgr` https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/indexedDB/IndexedDatabaseManager.cpp ; `ff-store` same directory `IDBObjectStore.cpp` ; `ff-actors` `ActorsParent.cpp` ; `ff-ipc` https://raw.githubusercontent.com/mozilla-firefox/firefox/main/ipc/chromium/src/chrome/common/ipc_channel.h
- `wk-udb` https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/indexeddb/server/UniqueIDBDatabase.cpp ; also read `server/SQLiteIDBBackingStore.cpp` and `IDBObjectStore.cpp`
- `html-msg` https://html.spec.whatwg.org/multipage/web-messaging.html (HTML, stripped)
- `fs-rel` https://cloud.google.com/firestore/docs/release-notes (HTML, stripped) ; `fs-quota` https://firebase.google.com/docs/firestore/quotas (HTML, stripped; same table at https://cloud.google.com/firestore/quotas)
- `ddb-tx` https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html (HTML, stripped) ; `ddb-bw` https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchWriteItem.html (HTML, stripped) ; `ddb-new` https://aws.amazon.com/about-aws/whats-new/2022/09/amazon-dynamodb-supports-100-actions-per-transaction/ (HTML, headline only)
- `sp-lim` https://cloud.google.com/spanner/quotas (HTML, stripped)
- `tidb-txn` https://raw.githubusercontent.com/pingcap/docs/master/transaction-overview.md ; `tidb-txn40` https://raw.githubusercontent.com/pingcap/docs/release-4.0/transaction-overview.md
- `tidb-cfg` https://raw.githubusercontent.com/pingcap/docs/master/tidb-configuration-file.md ; `tikv-cfg` same directory `tikv-configuration-file.md` ; `tidb-pipe` `pipelined-dml.md` ; `tidb-nt` `non-transactional-dml.md`
- `tidb-cfgsrc` https://raw.githubusercontent.com/pingcap/tidb/master/pkg/config/config.go ; `tidb-kv` https://raw.githubusercontent.com/pingcap/tidb/master/pkg/kv/kv.go
- `etcd-cfg` https://raw.githubusercontent.com/etcd-io/etcd/main/server/embed/config.go ; `etcd-err` https://raw.githubusercontent.com/etcd-io/etcd/main/api/v3rpc/rpctypes/error.go
- `etcd-lim` https://raw.githubusercontent.com/etcd-io/website/main/content/en/docs/v3.5/dev-guide/limit.md
