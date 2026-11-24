# Derive index entries above the engine, at write time, from the old row

Status: shipped. docstore derives every index entry from the stored document, reads the old row in the same kv `update`, and writes only the difference ([docstore README](../../packages/docstore/README.md), "Indexes" and "Schema versions"). Per-run scans for text queries (option ii below) were not built.

Date: researched 2026-11-06 at commit `433e94e`, when the `collections` package held the indexes. Nothing was run for this note. Its numbers were measured on 2026-11-06 in Node with in-memory storage, not Chrome or OPFS, through `collections`, which docstore replaced.

## Question

Is there prior art for a "derive key" API, where an engine or a layer calls a user function that derives index entries from a row? Where should that function run for one approach to every index kind: sorted, compound, multi-entry, text and unique?

## Verdict

Every system that keeps its indexes exact derives the entries where the schema lives, at write time, with the old row in hand. It reads the old row, derives the old and the new entries, deletes the old entries that are not in the new set, and puts the new ones, in one transaction. Berkeley DB, WiredTiger, FoundationDB Record Layer, CockroachDB and TiDB all work this way. Engines that derive inside the storage layer pay for it, as Tarantool vinyl, Cassandra and RocksDB show below. For kv the derive step belongs in the layer above it, and the old-row read costs what a point `get` costs.

What became of each option:

- **i. One `derive` and one diff for every index kind.** Shipped in docstore. An entry that a write leaves unchanged is not written again.
- **i-b. One text entry per row, not one key per word or prefix.** Shipped as docstore's `text` index: one entry per document, its value the lowercased words.
- **ii. `view.scanRuns`, a scan of each run without the merge, for text misses.** Not built. A text query filters the merged scan with `valueContains` (design.md, "Reads").
- **iii. A persisted spec fingerprint.** Shipped as more than that: a versioned catalog with index ids and states (docstore README, "Schema versions").
- **iv. Unique indexes through the same `update`.** Shipped. The unique key's value is the owner id ([document-store-prior-art.md](document-store-prior-art.md)).
- **v. Skip eager cleanup for text and validate at read.** Not recommended, not built.

## The numbers behind the key design

All from 2026-11-06, Node, in-memory storage, through `collections`. Two separate runs on two schemas, so compare within a run only.

- First run, 5,000 todo-shaped rows through `Table.putMany`: a term key for every prefix of every word cost 20.2 kv ops per row (16.2 of them term keys), whole words 7.0, no term index 4. Term-index reads took 5 to 270 µs.
- Second run: one text entry per row cost 3.0 ops per row against 2.0 without it, and 40.5k against 51k rows/s in bulk. A text query whose word matched nothing took about 1 s at 1M rows through the merged scan, and about 35 to 39 ms with per-run scans.
- A point get for an absent key took about 0.7 µs over 5 sources. On that date each tab held every live run in memory. kv now caches pages up to `cacheBytes` (design.md, "Reading a run"), so an old-row read beyond the cache goes to OPFS.

The lesson that transfers is that ops per row come from the key design, not from the family. Every system below also writes one key per extracted element. A write that deletes and re-puts every entry of an unchanged row costs 1 + 2N ops for N entries, where a diff costs 1. That count came from reading the code, not from a run.

## Prior art, one line per fact

Derive at write time, old row in hand:

- Berkeley DB `DB->associate` runs its callback on the new record and on the fetched old one, deletes old keys missing from the new set, and skips equal ones (`db_cam.c:2222-2270`). The callback is not persisted, and the manual calls writing a primary without its secondaries associated "generally unsafe".
- WiredTiger stores an extractor's name in the index definition, and the code behind the name must be registered at each open. The table cursor reads the old row, removes its index keys and inserts the new ones (`cur_table.c:608-650`, branch `mongodb-7.0`). The `immutable` option skips that work and corrupts the index when the claim is wrong.
- FoundationDB Record Layer stores key expressions as data in its metadata. User code enters only as a `FunctionKeyExpression` found by name. `StandardIndexMaintainer.update` drops the entries present in both the old and the new record before writing.
- CockroachDB's `Updater.UpdateRow` encodes old and new entries in the SQL layer and writes them in one KV batch, with `CPut` for unique entries (`updater.go:233-330`).
- IndexedDB has key paths and no functions. Chromium derives index keys in the renderer, and the browser process only checks uniqueness and writes them (`idb_object_store.cc:285-321`, `index_writer.cc:35-70`). It is the same split as kv's SharedWorker, which never runs app code.

Derive inside the LSM, at flush or compaction:

- Tarantool vinyl refuses functional indexes (`vinyl.c:695-698`). Its deferred DELETE writes secondary deletes at primary compaction, which needs a WAL-logged system space, `_vinyl_deferred_delete`, and a recovery trigger (`vinyl.c:4574-4660`).
- Cassandra's `Index.Indexer` sees the old row only as far as the memtable holds it ("may not represent the totality of the data"), and can be called in any order and twice (`Index.java:595-680`). SAI does not index tombstones and filters again at read.
- RocksDB has no hook that writes a key under another prefix. A compaction filter decides one key at a time, a merge operator resolves one key's operands, and a properties collector only reads.
- Lucene and Tantivy derive at segment build. That works because the index lives in the same immutable segment as the data.

Validate at read:

- Luo and Carey's survey (§3.7.2) lists lazy schemes (Diff-Index sync-insert, DELI, validation by primary key) whose motive is to avoid one random disk read for the old record per update.

Rules for user functions:

- Tarantool requires deterministic, sandboxed functions that cannot change while an index uses them. SQLite requires `SQLITE_DETERMINISTIC`, and a changed function leaves a stale index until `REINDEX`.

## Rejected

- **A derive callback in kv or its SharedWorker.** The host receives bytes, not functions, and two hosts may serve one database. Engines that run user code demand deterministic sandboxed functions, and vinyl still excludes them from its LSM.
- **Derivation at ingest, in kv.** On 2026-11-06 a delete reached the ingest fold without its old value, so its old entries could not be derived. Tarantool's deferred DELETE is the only LSM fix found, and it needs a durable side log and recovery.
- **An index section in the SST file (Lucene, Tantivy, SAI).** It is the right answer for ranking, phrase queries and very large corpora. It needs a format change, encoder and merge work, and a tokenizer in the engine. No need was shown.
- **An index built lazily from the change feed (CouchDB views).** An acked row would not be findable until the index caught up.
- **Function source stored in the database (CouchDB design docs, Tarantool).** Every tab would need `eval`, a sandbox and a determinism contract. Key paths cover the use cases.
- **No eager cleanup for text (sync-insert).** It saves one delete on a rare edit and requires read repair.

## What would reopen this

- In Chrome on OPFS, index keys dominate put latency for a realistic row with more than about 3 index keys.
- Text misses are too slow. Per-run scans (option ii) come first. Above about 500k rows, if a 35 to 39 ms miss is still too slow, a stored vocabulary of whole words or an SST section comes next.
- Ranking, phrase or fuzzy search is needed. That is the segment family and a format change.
- A kv user must write derived keys without knowing the old row. Then Tarantool's deferred DELETE is the design to study.

## Not verified

- These pages were read through a summarising fetch and need a re-check before quoting: Berkeley DB `DB->associate`, Record Layer `StandardIndexMaintainer`, Cassandra MV and SAI, SQLite `expridx` and FTS5, TiDB.
- Firefox and WebKit IndexedDB, MyRocks, WiredTiger `type=lsm` column groups, and the Luo and Carey PVLDB 2019 paper itself were not read.

## Sources

- Berkeley DB: https://docs.oracle.com/cd/E17276_01/html/api_reference/C/dbassociate.html, https://docs.oracle.com/cd/E17276_01/html/programmer_reference/am_second.html, https://raw.githubusercontent.com/berkeleydb/libdb/master/src/db/db_cam.c
- WiredTiger: https://source.wiredtiger.com/mongodb-7.0/custom_extractors.html, https://source.wiredtiger.com/mongodb-7.0/schema.html, https://raw.githubusercontent.com/wiredtiger/wiredtiger/mongodb-7.0/src/cursor/cur_table.c
- Record Layer: https://foundationdb.github.io/fdb-record-layer/Overview.html, https://foundationdb.github.io/fdb-record-layer/Extending.html, https://raw.githubusercontent.com/FoundationDB/fdb-record-layer/main/fdb-record-layer-core/src/main/java/com/apple/foundationdb/record/provider/foundationdb/indexes/StandardIndexMaintainer.java
- CockroachDB: https://raw.githubusercontent.com/cockroachdb/cockroach/master/pkg/sql/row/updater.go
- IndexedDB and Chromium: https://w3c.github.io/IndexedDB/, https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/indexeddb/idb_object_store.cc
- Tarantool: https://raw.githubusercontent.com/tarantool/tarantool/master/src/box/vinyl.c, https://raw.githubusercontent.com/tarantool/doc/latest/doc/reference/reference_lua/box_space/create_index.rst
- Cassandra: https://raw.githubusercontent.com/apache/cassandra/trunk/src/java/org/apache/cassandra/index/Index.java, https://cassandra.apache.org/doc/latest/cassandra/developing/cql/indexing/sai/sai-concepts.html
- RocksDB headers: https://raw.githubusercontent.com/facebook/rocksdb/main/include/rocksdb/
- Tantivy: https://raw.githubusercontent.com/quickwit-oss/tantivy/main/ARCHITECTURE.md
- SQLite: https://www.sqlite.org/expridx.html
- CouchDB views: https://docs.couchdb.org/en/stable/ddocs/views/intro.html
- Luo and Carey, "LSM-based Storage Techniques: A Survey": https://arxiv.org/abs/1812.07527
