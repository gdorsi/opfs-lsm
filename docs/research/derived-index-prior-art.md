# Derived keys in LSM and key-value stores: prior art, and what it means for indexes in @opfs-lsm

Question: is there prior art for a "derive key" API (an engine or layer calls a user-supplied function that derives secondary or index entries from a row), and what does it mean for the secondary indexes in `@opfs-lsm/kv` and `@opfs-lsm/collections`? The goal is one simple approach to the whole indexes surface (sorted, compound, multi-entry, full-text, maybe unique), not a better term index only. Follows `docs/research/multi-entry-index-alternatives.md` (MEIA) and `docs/research/landing-projections-and-fast-misses.md` (LPFM).

## Answer in ten lines

1. Prior art is unanimous on one point: the derive function runs where the schema lives, at write time, with the old row in hand. Berkeley DB, WiredTiger, FoundationDB Record Layer, CockroachDB and TiDB all read the old row, derive old and new keys, delete the old ones and put the new ones in one transaction (section 3.1). `Table.putMany/update/delete` in collections is that design already (R1.1).
2. Engines that do derive inside the storage layer pay for it. Tarantool's vinyl (an LSM) does not support functional indexes at all (`vinyl.c:695`) and needed a WAL-logged system space to defer secondary deletes to compaction (3.2). Cassandra's secondary-index hook gets old row data only from the memtable and explicitly not the SSTables (3.2). RocksDB has no hook that emits keys (3.3).
3. Derivation at flush or compaction (Lucene, Tantivy, Cassandra SAI) works because the index lives inside the same immutable file as the data, so nothing goes stale. That needs a file-format change and a function runner next to the engine (3.2). Both are ruled out here by the constraints (R1.3, R1.4).
4. Where a user function is involved, nobody lets it run unconstrained: Tarantool needs deterministic, sandboxed, immutable functions; SQLite needs deterministic functions; FoundationDB serialises a named key expression into persisted metadata and looks the function up in code (3.4). Browsers go further: IndexedDB has no functions, only key paths, and Chromium computes the keys in the renderer, not in the storage process (3.5).
5. The persisted-declaration pattern (iii) is real and cheap: IndexedDB, FoundationDB and SQLite store the index definition in the database; Berkeley DB does not and its manual calls out the resulting risk (3.4, 3.1).
6. The 18.4 ops per row is a property of "one key per prefix per word", not of the family. Whole words are 7.0 ops, D is 3 (R1.5, MEIA 1.3). Every system above also pays one key per extracted element.
7. One cost in our code is not inherent: `putMany` deletes every old index key and re-puts every new key even when unchanged, and kv does not dedupe, so a re-put of an unchanged row costs about 2N+1 ops where a diff costs 1 (R1.1). FoundationDB and Berkeley DB skip unchanged entries (3.1).
8. The lazy family (validate at read, Luo and Carey) exists to avoid a disk point lookup per update. Here every tab holds every run in memory, so the premise is weaker, and `Table.search` already validates by `get` (R1.6, 3.6).
9. Recommendation: keep derivation in collections, make it one `derive(id, doc) -> entries` plus one diff for all index kinds (PR1, collections only). Then LPFM's `view.scanRuns` plus `Table.search` on it (PR2). Persist a spec fingerprint only if schema drift between tabs is observed (PR3, optional).
10. Reject: a derive callback in kv or the SharedWorker, ingest-time derivation in kv (parked A), a new SST index section, and a lazily built index fed by `changes` (section 6).

---

Conventions as in MEIA. **[R]** repo fact, cited `file:line`. **[E]** external fact, cited with the owner's URL or source file (tags like `bdb-src` resolve in section 8). **[I]** my inference. **(run)** is not used here: I ran nothing in this task; all numbers are quoted from MEIA and LPFM, which measured them.

Method caveat. External pages were read two ways. Source files and headers were downloaded with `curl` and read locally (Berkeley DB, WiredTiger, RocksDB, Tarantool, Cassandra `TableViews.java` and `Index.java`, CockroachDB `updater.go`, Chromium and the IndexedDB spec, the Luo and Carey PDF through `pdftotext`). A few pages were read through a fetch tool that summarises with a small model and are marked "(summary)": `DB->associate`, FoundationDB `StandardIndexMaintainer.java`, Cassandra MV and SAI pages, SQLite `expridx` and FTS5, the TiDB page. Re-check those quotes before using them publicly. Lucene and Tantivy are reused from MEIA 2.1 (Tantivy `ARCHITECTURE.md` re-read; Lucene not re-fetched).

---

## 1. Repo facts

### 1.1 Where derivation lives today

- [R] Index and search keys are derived in collections, not kv. `Table.indexKeys` and `searchEntry` compute them from the row (`packages/collections/src/table.ts:192`, `:203`).
- [R] `putMany` calls `db.update(pks, ...)`, which reads the previous rows. For each previous row it deletes every old index key (`table.ts:252`), then puts the row and every new index key (`:261`). There is no diff of old against new keys in `putMany`. `update` does diff (`:282-291`). `delete` and `clear` delete all keys (`:390`, `:406`).
- [R] kv does not dedupe ops: `collectBatch` pushes every `put` and `delete` in order, and `checkBatch` copies each into the output (`packages/kv/src/db.ts:339-360`, `packages/kv/src/check.ts:60-86`). A batch is limited by op count (`check.ts:63`). So a re-put of an unchanged row with N index keys is 1 + 2N ops [I: from the two lines above; I did not run it].
- [R] `Db.update(keys, body)` reads the old values and writes in one IndexedDB transaction; "no other write can land between the reads and the commit" (`db.ts:156-163`, impl `db.ts:625-640`). This is the only atomicity primitive the indexes use.
- [R] A search key is one per row, `s/<table>/<sortBy>/<id>`, value is the normalised text; `Table.search` scans them in `sortBy` order, checks word prefixes, then reads rows by `snap.get` and drops rows that no longer exist (`table.ts:38-48`, `:491-523`). It does not re-match the row text.

### 1.2 The schema is code, not data

- [R] `TableSchema` (name, primary key, `indexes: IndexSpec[]`, `search`) is passed to `openCollectionDb` and kept in a JS `Map` (`packages/collections/src/database.ts:4-9,12-30,45-50`; `table.ts:53-64`). Nothing writes the schema to the database. [I] Two tabs (or two app versions) that open the same database with different specs derive different keys and leave orphans for each other. LPFM already notes there is no backfill: rows written before `search` was declared are unsearchable (LPFM 1.2).

### 1.3 Constraints from the host

- [R] The SharedWorker host sees only bytes: `ClientToHost` messages are `ingest`, `watch`, `unwatch`, `ping`; `watch` carries `name`, `maxWalBytes`, `trace` (`packages/kv/src/host/protocol.ts:8-28`). It cannot receive a function or a spec today. Two SharedWorkers can serve one database (LPFM 1.1 item 3, citing `host/engine-host.ts:50-59,201-214`).
- [R] The ingest fold keeps the last op per key and emits a `del` with no value (`packages/kv/src/store/fold.ts:11-24`). A delete therefore carries no old value when it reaches the fold (LPFM 1.1 item 1).
- [R] The ingest fold has no memtable and no readers (`packages/kv/src/host/ingest.ts:25-60`; LPFM 1.1 item 2).

### 1.4 Constraints from the engine

- [R] Project rules: "read/write performance above everything", "KISS", "consistency should be guaranteed, persistence not", no backward compatibility (`AGENTS.md:3-12`).
- [R] Each tab keeps every live run file in memory (`docs/design.md:592`). A point get for an absent key costs about 0.7 us over 5 sources (LPFM 1.2, run there). [I] So a read-before-write in this engine costs microseconds, not a disk seek.
- [R] The SST has one keyspace section, a bloom and a block index; the reader rejects other layouts (`docs/design.md:143-164,236-262`; `sst.ts:440-452`, both via MEIA 1.4). A new per-run index section is a format change.
- [R] The Rust merge decodes and re-encodes whole runs and keeps the newest entry per key (`docs/design.md:482-493`; `crates/engine-core/src/compact.rs:17-33`, via LPFM 1.1 item 1).

### 1.5 Measured costs (not re-measured here)

- [R] 5,000 todo-shaped rows through `Table.putMany`: all-prefix term index 20.2 kv ops per row (16.2 are term keys); whole words 7.0; no term index 4 (MEIA 1.3). The shipped D (one search key per row) is 3.0 ops per row against 2.0 without it, 40.5k against 51k rows/s in bulk (LPFM 0, item 5).
- [R] D: a word that matches nothing costs about 1 s at 1M rows through the merged scan; about 35-39 ms with per-run scans (LPFM 0 items 1 and 6, MEIA E2b). Term index reads are 5-270 us (MEIA 1.3).

### 1.6 What is not in the repo

- [R] `scanRuns` does not exist in `packages/` (grep in this checkout, nothing found). `ViewSnapshot` exposes `walHead`, `generation`, `get`, `range` (`packages/kv/src/view.ts:13-20`).
- [R] No `reindex`, no unique index, no index-state concept in collections (grep of `packages/collections/src` for `unique` finds only the unique-id checks of `putMany` at `table.ts:226,238`, none for `reindex`; LPFM 1.2 for backfill).

---

## 2. The six questions, in one table

Read the cells as: where the function runs and who calls it / when / old value / multi-key / consistency / what the user must get right. Evidence for every cell is in section 3.

| System | Derive API | When invoked | Old value | Multi-key | Consistency | User must get right |
|---|---|---|---|---|---|---|
| Berkeley DB | `DB->associate(secondary, callback)`, C function pointer, runs in-process | every put and delete of the primary | callback re-run on the fetched old record, new and old key sets diffed | yes, `DB_DBT_MULTIPLE` | same txn if env is transactional | deterministic, no repeats in a key set, associate on every open |
| WiredTiger | `WT_EXTRACTOR.extract`, registered by name, set per index in `create` | every update of the table cursor | primary searched first, old keys removed, new inserted | yes, many `insert`s on the result cursor | one table-cursor op | deterministic in practice, or `immutable` index |
| FDB Record Layer | key expression (data) or named `FunctionKeyExpression` (code); `IndexMaintainer.update(old, new)` | every record save and delete | old record loaded by the store, expressions evaluated on both, common entries skipped | yes, `FanOut` | same FDB transaction | function registered in code, serialised by name |
| Tarantool memtx | Lua function by name, `is_multikey` | every insert/replace/delete | tuple diff | yes | same txn | `is_deterministic`, `is_sandboxed`, never changed |
| Tarantool vinyl (LSM) | none for functions; path `[*]` multikey only | n/a | deferred deletes at primary compaction | path multikey | n/a | n/a |
| RocksDB | none that emits keys | n/a | n/a | n/a | n/a | n/a |
| Cassandra 2i/SAI | `Index.Indexer` callbacks; SAI flush observer | memtable write, flush, compaction | only what is in the memtable | per implementation | eventual, validated at read | tolerate duplicates and shadowed rows |
| Cassandra MV | none (declarative) | every base write | base row read before write | no | not atomic with base | primary key rules |
| Lucene/Tantivy | analyzers and schema (data) | at segment build | none: deletes are per-segment bitsets or terms | yes, postings | refresh/commit lag | n/a |
| SQLite expression index | SQL expression with deterministic function | every row change | engine reads old row | one key per expression | same txn | `SQLITE_DETERMINISTIC` |
| SQLite FTS5 external content | user triggers | user's triggers | user must pass old values to `'delete'` | via tokenizer | same txn if triggers | keep in sync or `'rebuild'` |
| CockroachDB, TiDB | SQL layer | every row write | caller fetches old row | secondary index per row | same KV txn | n/a |
| IndexedDB | key path (data), `multiEntry`, `unique` | every `put`, `add`, `delete` | engine removes old record's index entries | yes, `multiEntry` | same txn, `ConstraintError` on unique | index changes only in version change |
| CouchDB/PouchDB | JS `map` function stored in a design doc | at query time, incrementally | engine finds rows a doc made | `emit` many | eventual | side-effect-free function |

---

## 3. External facts, by family

### 3.1 Family A: derive at write time, same transaction, old row in hand

**Berkeley DB `DB->associate`.**
- [E bdb-assoc (summary)] The callback is `int (*callback)(DB *secondary, const DBT *key, const DBT *data, DBT *result)`. It returns 0, `DB_DONOTINDEX` (skip) or an error. With `DB_DBT_MULTIPLE` on `result->flags`, `size` is the number of keys and `data` an array of DBTs; "keys must not repeat" and repeats can leave the secondary inconsistent. The callback must not call back into the library. The page does not state determinism but the code needs it (see next bullet); `DB_IMMUTABLE_KEY` lets BDB skip the callback on updates, and wrongly claiming it corrupts the secondary.
- [E bdb-src] On a put, `__dbc_put_secondaries` inserts the new secondary keys (`db_cam.c:1473`). Then, if there was an old record, the code fetches it and calls `__dbc_del_oldskey` for each secondary unless `DB_ASSOC_IMMUTABLE_KEY` (`db_cam.c:1960-1990`). `__dbc_del_oldskey` runs the same callback on the old data to get the old key set, then compares old and new and deletes only old keys not in the new set (`db_cam.c:2222-2270`; "Returns DB_KEYEXIST if the new and old keys match"). So: read-before-write, callback run twice, unchanged keys skipped.
- [E bdb-guide] "associating each primary handle with all the appropriate secondaries is the responsibility of the application and is not enforced by Berkeley DB. It is generally unsafe, but not forbidden ... to modify a database that has secondary indexes without having those indexes open and associated." An outdated secondary "should be discarded using DB->remove() and a new one created using DB->associate()" (`DB_CREATE` populates an empty secondary by walking the primary, "can be very expensive", bdb-assoc summary). The callback is not persisted. This is the schema-drift problem of R1.2, stated by the owner.

**WiredTiger.**
- [E wt-ext] "applications can instead specify a custom extractor by implementing the WT_EXTRACTOR interface ... called by WiredTiger each time a record is updated in a table. The extract method should determine the index key(s) and call WT_CURSOR::set_key followed by WT_CURSOR::insert on the supplied result_cursor for each index key." "If any operation fails, WT_EXTRACTOR::extract must return the failure ... or the index could become out of sync with the table." The index stores the extracted key plus the hidden primary key, with an empty value.
- [E wt-h70] `extract(extractor, session, key, value, result_cursor)` receives the raw key and value; "Multiple index keys can be created for each record by calling WT_CURSOR::insert multiple times" (`wiredtiger.in:4609-4640`, branch `mongodb-7.0`). The extractor is registered with `add_extractor(name, extractor)` and chosen by name in `WT_SESSION::create` (`extractor=...`, `wiredtiger.in:1235-1236,2826-2841`). So the persisted index definition holds a name, and the code behind the name must be registered at each open.
- [E wt-cur70] Old value handling is read-before-write in the table cursor, not in the storage file: for `update`, "first delete any old index keys, then update the primary, then insert the new index keys. This is complicated by the fact that we need the old value to generate the old index keys, so we make a temporary copy of the new value", then `APPLY_CG(ctable, search)` to fetch the old row (`cur_table.c:608-650`). For `remove`, search then remove from indices (`:663-683`). The `immutable` index option "saves a remove and insert into the index whenever a value in the primary table is updated", and "if immutable is configured when updates should alter the content of the index it is possible to corrupt data" (wt-schema).
- [E wt-cur70] [I] These functions apply to the column-group cursors generically (`APPLY_CG`), so the maintenance sits above whichever file type holds the data. I did not read how a `type=lsm` colgroup interacts. `src/lsm/lsm_tree.c` exists on `mongodb-7.0` and returns 404 on `develop`; I did not investigate why. `WT_EXTRACTOR` does not appear in `develop`'s `wiredtiger.h.in` by `grep`, but `schema_create.c` on `develop` still handles the `extractor` config; I did not resolve whether the public API changed.

**FoundationDB Record Layer.**
- [E fdb-docs] "A secondary index ... is a subspace of the record store ... updated when records are inserted or updated in the same transaction so that it is always consistent with the (primary) record data." An index is a name, a type (looks up an index maintainer in a registry), a key expression ("evaluated against a stored record to produce a list of tuples for each index entry"), and options such as uniqueness. Key expressions are data: `field`, `nest`, `concat`, `FanType.FanOut` (one key per element of a repeated field), and the metadata is serialisable (`RecordMetaDataProto.MetaData`, stored by `FDBMetaDataStore`, Overview.html).
- [E fdb-docs] "The first consideration ... is whether this is a new way of storing the data or just a new way of extracting the data from the record and then storing it in the standard way. In the former case, we require a new index maintainer. In the latter ... a new key expression." The user-code hook is `FunctionKeyExpression`: found through the service loader, it has "a name, through which the expression can be found and with which it can be stored in the meta-data's protobuf", and `evaluateFunction` is "called with the record being saved". A general `KeyExpression` "must implement toProto for serialization with the meta-data". That is: persisted declaration, code registered by name.
- [E fdb-store] On save, the store loads the existing record, writes the new one, then `updateSecondaryIndexes(oldRecord, newRecord)` (`FDBRecordStore.java:596-628`, `:737-806`). [E fdb-sim (summary)] `StandardIndexMaintainer.update` evaluates the key expression on both records, and "entries present in both are dropped from both lists" before clearing the old and setting the new (default `skipUpdateForUnchangedKeys()`). Unique indexes run `checkUniqueness` in the same transaction before the set. `extending` also names a `write-only` path (`updateWhileWriteOnly`) for indexes being built online; I did not read it.

**CockroachDB, TiDB/TiKV.**
- [E crdb-upd] The SQL layer derives index entries. `Updater.UpdateRow(ctx, batch, oldValues, updateValues, ...)` takes the old row values from the caller, encodes old and new secondary index entries with `rowenc.EncodeSecondaryIndex` for each index, and writes tombstones and puts into one `kv.Batch`; non-unique indexes use plain `Put` since the primary key is part of the key, unique ones `CPut` (`pkg/sql/row/updater.go:233-330,440-470`). Partial indexes skip entries whose old or new row fails the predicate (`:308-325`).
- [E tidb] TiDB encodes a row as `tablePrefix{TableID}_recordPrefixSep{RowID}` and a non-unique index as key `..._indexPrefixSep{IndexID}_indexedColumnsValue` plus RowID, value null; the page says "TiDB's SQL layer ... translates SQL statements into Key-Value operations" and does not say outright that the SQL layer builds index keys (summary; inference).

**IndexedDB (the browser's own spec).**
- [E idb-spec] An index has a key path (declarative: "extracting a key from a value using a key path") and `unique` and `multiEntry` flags: "If its multiEntry flag is true, then one record is added to the index for each of the subkeys" (§2.6, §6.1). Storing a record: if one exists, "remove the record from store using delete records from an object store", write the record, then "for each index which references store" extract the key; if invalid or an exception, "take no further actions for index" (the row is simply not in that index); `unique` violation aborts with `ConstraintError`. Delete removes "every record from index's list of records whose value is in range", that is, entries are found by their value (the primary key), so the old row is not needed in the abstract model (§6.1, §6.4). `createIndex` and `deleteIndex` "throw an InvalidStateError ... if not called within an upgrade transaction" (§4.5).
- [E chr-blink] Chromium does not run derivation in the storage process: the renderer generates the index keys per index from the value and ships them with the put (`blink/.../idb_object_store.cc:285-321` `GenerateIndexKeysForValue`; `:555-574` builds `index_keys` for `Metadata().indexes` and calls `transaction_->Put(... std::move(index_keys) ...)`). The browser process `IndexWriter` verifies uniqueness and writes them (`content/browser/indexed_db/instance/index_writer.cc:35-70`). [I] This is the same split as our SharedWorker: the process that owns the files never evaluates user logic. I did not read Firefox or WebKit.

### 3.2 Family B: derive at flush or compaction, inside the immutable file

**Lucene and Tantivy.**
- [E lucene, via MEIA 2.1] "Each segment is a fully independent index"; deleted documents are dropped at merge; documents are buffered in RAM and flushed as a segment (`setRAMBufferSizeMB`).
- [E tantivy] "A tantivy index is a collection of smaller independent immutable segments"; "tantivy is designed to handle these updates in large batches"; deletes "happen by deleting a term" and are recorded in a per-segment alive bitset file `segment_id . commit_opstamp . del`, "like all segment files, ... immutable" (`ARCHITECTURE.md:31,41,57-62`). Tokenisation is part of the schema ("1:1 relationship between a field that is being ingested and a field represented in the search index", `:118`). No old value is needed for deletes. The cost: the analyzers are the engine's, not user callbacks run in the storage layer.

**Cassandra SAI and the 2i `Indexer`.**
- [E cass-sai (summary)] "When the flush occurs, SAI writes a new SSTable index for each indexed column"; compaction rebuilds indexes for merged data; a memtable index is flushed directly to disk. "SAI does not index tombstones, so it's possible that an indexed row has been shadowed"; each matching partition gets a read and "a filter tree" re-applies the filtering. The page does not say whether SAI reads before write; that is inference.
- [E cass-idx] The pluggable `Index.Indexer` receives `insertRow(row)` ("only implies that the inserted row was not already present in the Memtable, it does not guarantee that the row does not exist in an SSTable"), `updateRow(oldRowData, newRowData)` ("the old and new rows supplied here may not represent the totality of the data ... There may be additional column data in SSTables"), and `removeRow(row)` which "is only called as part of either a compaction or a cleanup". It "may be called ... in any order", "duplicate calls" possible, and it sees updates "by iterating SSTables during streaming operations or when building or rebuilding an index" (`Index.java:595-680`). `getFlushObserver` lets an index "observe partition/cell events generated by flushing SSTable (memtable flush or compaction)" (`Index.java:380-392`). So an LSM that exposes derivation hooks exposes memtable, flush and compaction events, and every implementation must tolerate partial row views, duplicates and shadowed rows.
- [E cass-mv] `TableViews.java:184-195` builds `readExistingRowsCommand`, runs it locally and generates view updates from `(updates, existings)`: Cassandra materialized views read the base row before write. The docs page for MVs does not mention this (summary), and a known limitation about deletions shadowing missed updates is listed (cass-mv-doc).

**Tarantool vinyl (an LSM).**
- [E tnt-vinyl] `vinyl.c:695-698`: creating a functional index on a vinyl space fails with `ER_UNSUPPORTED "Vinyl" "functional index"`. The doc says the same: "The space must have a memtx engine" (`create_index.rst:596-620`).
- [E tnt-vinyl] The deferred DELETE optimisation: to write a DELETE into a secondary index "we need to look up the old tuple in the primary index, which is expensive as it implies a random disk access. We can optimize out the lookup by deferring generation of the DELETE statement until primary index compaction" (`vy_stmt.h:107-119`). During compaction, the write iterator calls a handler for each overwritten tuple "to produce a DELETE statement and insert it into secondary indexes" (`vy_write_iterator.h:196-226`). The deferred deletes are written through a system space, `_vinyl_deferred_delete`, with a trigger that restores them on WAL recovery and filters them by LSN (`vinyl.c:4574-4660`). It is a per-space option, disabled if the space has UPSERTs (`vinyl.c:1768-1780`). [I] This is design family B for a separate-LSM-per-index layout: it works because the primary compaction sees both versions of a row, but it needs its own durable log, recovery and read-skip flag. It is the closest prior art for the parked projections work (A in MEIA), and its cost agrees with the reasons A was parked.

**Luo and Carey, "LSM-based Storage Techniques: A Survey"** (family C below) also records DELI, which "enhances the sync-insert update scheme ... with a new method to cleanup secondary indexes by scanning the primary index components": obsolete records seen during a merge of the primary "are used to produce anti-matter entries" (§3.7.2). That is the same idea as vinyl's deferred delete.

### 3.3 RocksDB: no hook that emits keys

[E rocks-h] I read `table_properties.h`, `compaction_filter.h`, `slice_transform.h`, `merge_operator.h`, `index_factory.h`, `user_defined_index.h` and `table.h` from `main` on 2026-11-06. I did not search the rest of `include/rocksdb/`.
- `TablePropertiesCollector`: one object per table, called sequentially with each `AddUserKey(key, value, type, seq, file_size)` while the SST is built; `Finish` adds statistics to a properties map in the file; `NeedCompact()` can ask for further compaction; "statuses ... are currently logged when not OK, but otherwise ignored" (`table_properties.h:103-160`). It reads keys and values; it cannot write other keys.
- `CompactionFilter`: decisions are `kKeep`, `kRemove`, `kChangeValue`, `kRemoveAndSkipUntil` (and variants) on one key-value at a time (`compaction_filter.h:205-241`); "RocksDB snapshots do not guarantee to preserve the state of the DB in the presence of CompactionFilter" (`:105-108`). It cannot add a key under another prefix.
- `SliceTransform` (prefix extractor): "a generic pluggable way of transforming one string to another", "normally used for building and checking prefix Bloom filters" (`slice_transform.h:27-56`).
- `MergeOperator`: "Essentially, a MergeOperator specifies the SEMANTICS of a merge ... The library ... is concerned with the exercise of this interface, at the right time (during get, iteration, compaction)" (`merge_operator.h:19-40`). It resolves one key's operands; it does not derive other keys.
- There is a newer experimental `IndexFactory` ("EXPERIMENTAL ... may change at any time"): pluggable index for BlockBasedTable SST files, with `OnKeyAdded(key, type, ...)` per key and `AddIndexEntry` per data block, serialised into a meta block "rocksdb.user_defined_index." (`index_factory.h:1-16,70-88,163-168`; `table.h:598-602`). It indexes the SST's own keys to block handles (trie, learned index). It is an SST-format extension point, not a secondary-index derivation.
- [I] Secondary indexes on RocksDB are built by layers above it. I did not read MyRocks or other layers in this task.

### 3.4 Declarative or persisted index definitions, and function rules

- [E tnt-doc] Tarantool: the function must be persistent (`box.schema.func.create(name, {body, is_deterministic = true, is_sandboxed = true, is_multikey = true})`), "deterministic", must "access key-part values by index", "Functional indexes cannot be altered and the function cannot be changed if it is used for an index, so the only way to change them is to drop the index and create it again", "Only sandboxed functions are suitable"; "If a multikey function returns N tuples, then N keys will be added to the index" (`create_index.rst:596-620,691-695`, `tnt_create_index_func_multikey_test.lua:20-43`). Path multikey (`data[*].name`) caps a tuple at about 8,000 indexed elements (`:583-584`); our cap is 1,000 (R1.1, `table.ts:35`). The function body is stored in the database as source text and run by the engine in a sandbox.
- [E sqlite-expr (summary)] SQLite: expressions in `CREATE INDEX` "may contain function calls, but only to functions whose output is always determined completely by its input parameters"; application-defined functions "are by default considered non-deterministic and may not be used ... unless the SQLITE_DETERMINISTIC flag is used when the function is registered". The function is registered per connection, the expression is stored in the schema, and a changed function leaves a stale index until `REINDEX` (the page defers this to a separate page I did not read).
- [E fts5 (summary)] FTS5 external-content tables: "It is still the responsibility of the user to ensure that the contents ... are kept up to date ... One way to do this is with triggers." The `'delete'` command must be given the old values: "The values inserted into the other columns must match the values currently stored in the table", else "the results may be unpredictable". Triggers do not backfill. `'rebuild'` discards the index and rebuilds from the content table. I read 100,000 of 171,799 characters.
- [E couch] CouchDB and PouchDB keep the `map` function as source text in a design document inside the database: `views: { by_name: { map: function (doc) { emit(doc.name); }.toString() } }` (pouch-q). "Map functions are side effect-free functions that take a document as argument and emit key/value pairs" (couch-views, §3.2.1.7). The index is built at first query and then updated per query from the changes since the last one: "CouchDB is smart enough to find the rows in the view result that were created by a specific document" and invalidates them (couch-views). So the engine keeps a doc-id to rows map.
- [E dexie] Dexie declares indexes as a string, `&` unique, `*` multi-entry, `[A+B]` compound (`Version.stores()` page) and delegates to IndexedDB; its `creating/updating/deleting` hooks run in the tab (`Table.hook` page). [E rxdb] RxDB declares `indexes` in the JSON schema; indexed strings need `maxLength`, numbers need `minimum`, `maximum`, `multipleOf`, because RxDB "is able to know the maximum string representation length of a field, which is needed to craft custom indexes in several RxStorage implementations" (`rx-schema.html`). I did not read RxDB's storage code.
- [E pglite] PGlite describes itself as "a WASM Postgres build"; the page lists no index-derivation API beyond Postgres (about page, summary). ElectricSQL and Triplit: not verified. The Triplit docs page returned no usable content; I have no source for any claim about their index APIs.

### 3.5 Search engines for a derived text index

Covered by MEIA 2.1-2.2 (Lucene, Tantivy, FTS5 segments and automerge). Not repeated.

### 3.6 Family C: validate at read time (Luo and Carey)

- [E luo] "LSM-based Storage Techniques: A Survey", Chen Luo and Michael J. Carey, arXiv:1812.07527v3 (19 Jul 2019), §3.7.2 "Index Maintenance" (also in the survey: AsterixDB §4.5, which keeps a primary index, a primary key index and local secondary indexes and says "a record-level transaction model ... all of the indexes are kept consistent within each partition").
- "For a primary LSM-tree, an update can blindly add the new entry ... However, this mechanism does not work for a secondary index since a secondary key value can change during an update. Extra work must be performed to clean up obsolete entries."
- Diff-Index (Tan et al., EDBT 2014) schemes: "Sync-full performs these two steps synchronously during the ingestion time. It optimizes for query performance since secondary indexes are always up-to-date, but incurs a high overhead during data ingestion because of the point lookups. Sync-insert only inserts new data into secondary indexes, while cleaning up obsolete entries lazily by queries." "Async-simple ... appending updates into an asynchronous update queue."
- DELI (Tang et al., CCGrid 2015): cleanup by scanning the primary index components, integrated with the merge; "queries must always validate search results by fetching records from the primary index".
- Luo and Carey, "Efficient data ingestion and query processing for LSM-based storage systems", PVLDB 12(5) 2019, cited as [47]: "A validation strategy was proposed to maintain secondary indexes lazily in the background, eliminating the synchronous point lookup overhead. Queries must validate the primary keys returned by secondary indexes either by fetching records directly from the primary index or by searching the primary key index", and a primary key index "only stores primary keys plus timestamps" to make validation cheap. Their experiment on inverted lists: "the eager inverted list scheme incurs a large overhead on data ingestion because of the point lookups and high write amplification." I read the survey, not the 2019 paper; the numbers in [47] are not checked.
- [I] The motive in all of these is that the old-record point lookup is a random disk read. Here the lookup is an in-memory get (R1.4), which weakens the case for lazy maintenance. The part that still applies is query-time validation: scans without a merge return stale text, so a re-match is needed (LPFM 1.1 item 4).

---

## 4. What the prior art says, in order

1. **Where the function runs.** Berkeley DB, WiredTiger, Tarantool memtx, SQLite: in the engine process, same address space as the data. FoundationDB, CockroachDB, TiDB, IndexedDB (Chromium): in the layer that owns the schema, above a keyspace that stays dumb. Cassandra and Tarantool vinyl: inside the LSM, and the code shows the price (3.2). [I] Our host is schema-free by construction (R1.3), so the layer-above group is the only fit.
2. **What is persisted.** A name or an expression, not code: IndexedDB key paths, FoundationDB key expressions and function names, WiredTiger extractor names, SQLite expressions, Tarantool persisted function bodies. Berkeley DB persists nothing and says so. CouchDB persists source text.
3. **What the engine owns.** Diffing old and new key sets (BDB, FDB), skipping unchanged keys (FDB, BDB `DB_KEYEXIST`), uniqueness inside the transaction (FDB, IndexedDB, CockroachDB), and a way to rebuild (BDB `DB_CREATE`, FTS5 `'rebuild'`, FDB write-only state, IndexedDB `ConstraintError` on `createIndex`).
4. **Determinism** is demanded wherever a function is user code: Tarantool (`is_deterministic`, sandbox), SQLite (`SQLITE_DETERMINISTIC`), BDB (implicit), FDB (a function key expression "can do whatever it wants to get data from" the record, per the docs; that old and new evaluations must agree is my inference).
5. **Multi-entry is one key per element everywhere.** Tarantool, WiredTiger, BDB, FDB `FanOut`, IndexedDB `multiEntry`. Nobody solves its write amplification in the family; the answers that avoid it change the structure (Lucene/Tantivy postings per segment, MEIA 2.1) or shrink it (D).

---

## 5. For this repo

### 5.1 Which family fits

[I] Family A, in collections, with old row read in the same `db.update`. Reasons, each tied to a fact:
- The old row is already read there (R1.1), at in-memory cost (R1.4), in one IndexedDB transaction that gives atomicity and ack visibility with no new mechanism (R1.1).
- B needs either a function runner in the SharedWorker (R1.3: no schema, no functions, two hosts) or a new SST section and Rust merge hook (R1.4), and the prior art that tried B inside an LSM needed a durable side log (vinyl) or accepted partial row views (Cassandra).
- C is an optimisation for disk lookups; keep the validation, drop the idea of removing eager cleanup (3.6).

So the current design is the mainstream answer, and it is the same as BDB and WiredTiger with the function replaced by `Table` code. What it costs:
- one read of the old row per put (microseconds);
- 1 + N puts and up to N deletes per row for N index keys. `putMany` does not diff, so an unchanged-key re-put costs 1 + 2N (R1.1);
- N is per element: 16.2 for prefix terms, 3.0 for whole words, 1 for D (R1.5). That is a choice of key design, not a cost of the family.

Gaps against the mainstream, all in collections: no unique indexes, no persisted spec (R1.2), no backfill or rebuild (R1.6), three separate code paths for deriving keys.

### 5.2 Simple options for the broader surface

All options keep kv's keyspace and SST format. Put cost is kv ops per row.

| # | Option | kv change | collections change | Put cost | Query cost | Orphan or consistency | Complexity | Chosen by |
|---|---|---|---|---|---|---|---|---|
| i | One `derive(id, doc) -> entries` over all index kinds, one diff | none | replace `indexKeys`, `searchEntry`, and the three write paths with one function and one `diffEntries`; same for `delete` and `clear` | unchanged rows cost 1; changed keys cost delete + put; kinds: sorted, compound, multiEntry (N), text D (1) | unchanged | exact, same txn | small refactor, deletes code | BDB, WT, FDB, CockroachDB |
| i-b | Fewer or cheaper terms: whole words not prefixes; D | none | key design only | 7.0 or 3.0 vs 20.2 (R1.5) | whole-word: 5-270 us (R1.5); D: 1 s miss at 1M, see ii | exact | none | Lucene/Tantivy (postings once per term per segment) is the structural alternative |
| ii | `view.scanRuns`, per-run scan without merge; collections validates | new read-only API on `ViewSnapshot`, no format change | `Table.search` scans runs, dedupes, re-matches, validates by `get` | none beyond D | about 35-39 ms for a miss at 1M vs about 1 s (LPFM 0 item 6) | stale candidates dropped by validation; stale keys in older runs harmless | one kv API (LPFM PR1), one collections change (PR2) | Lucene/Tantivy search each segment independently; FTS5 many b-trees; Cassandra SAI per-SSTable |
| iii | Persist the spec fingerprint in the db; check on open; `reindex` | none (collections writes an ordinary key) | store `{table, indexes, search}` hash under a reserved prefix; compare on open; throw or rebuild; `reindex(table)` scans rows and rewrites entries | none | none | detects drift; rebuild fixes orphans | a hash and a scan | IndexedDB (schema in the DB, changes only in versionchange), FDB (metadata in the store), SQLite (schema in file), FTS5 (`'rebuild'`) |
| iv | Unique indexes through `update([pk, uniqueKey], ...)` | none | read the unique key inside the same `update`; throw `ConstraintError` if it maps to another id; one extra key read | +1 read | unchanged | exact: no other write lands between read and commit (R1.1) | small | IndexedDB, FDB, CockroachDB, BDB |
| v | Skip eager cleanup for text only, validate at read (sync-insert) | none | stop deleting old search keys on sort-key change; re-match on read | saves one delete per changed row | slightly more validation | orphans live until `clear` or a rebuild | adds a rule that read-repair must exist | Diff-Index sync-insert, DELI, SAI (3.6). Not recommended: the saving is one delete on a rare edit |

### 5.3 Rejected

- **A derive callback in kv or the SharedWorker.** The host cannot receive functions (R1.3); two hosts may serve one database; the prior art that runs user code in the engine demands deterministic, sandboxed, immutable functions (Tarantool, SQLite) and still excludes the LSM engine (vinyl). BDB's own manual warns about opening without associating (3.1), which is exactly the multi-tab case.
- **Ingest-time derivation in kv (parked A).** A delete reaches the fold with no value (R1.3), so the derived key is not computable; the only precedent that fixes this in an LSM, Tarantool's deferred DELETE, needs a durable system space, recovery triggers and a per-space flag (3.2). This agrees with MEIA's and LPFM's reasons for parking A. Revisit only with the evidence in 6.
- **A new SST index section or segment-style inverted index (Lucene, Tantivy, SAI).** Correct answer for ranking, phrase queries and very large corpora; it needs a format change, Rust encoder and merge work, and a tokenizer in the engine. The project allows a format change (R1.4), but the need is not shown (6).
- **A lazily built index fed by `changes` (CouchDB views).** Breaks ack visibility: the row would be acked but not findable (LPFM 2.1 option e reached the same conclusion; `db.changes` events carry `{kind, writerId, seq}` only, `changes.ts:3-9`). CouchDB can afford it because queries trigger the update; here a query would block on a scan.
- **Persisted function source text (CouchDB design docs, Tarantool bodies).** Would need `eval` in every tab, a sandbox and a determinism contract; the declarative specs we have (paths, `multiEntry`, `search`) cover the use cases. IndexedDB, the closest precedent for the collections API, has no functions either.

---

## 6. Recommendation

**Smallest change that improves the broader surface: option i.** One internal function, `entriesOf(id, doc): { key, value }[]`, concatenating the entries of every index (sorted and compound, multiEntry, text D, later unique) and one `diffEntries(old, new)` returning keys to delete and entries to put, used by `putMany`, `update`, `delete`, `clear`. It is the pattern in Berkeley DB (`__dbc_del_oldskey`), FoundationDB (`StandardIndexMaintainer.update`) and CockroachDB (`UpdateRow`), and it deletes more code than it adds [I: not prototyped].

**First PR (collections only, no kv change):**
1. Replace the per-index loops in `putMany` (`table.ts:229-266`), `update` (`:272-310`), `delete` (`:400-418`) and `clear` (`:362-398`) with `entriesOf` and `diffEntries`.
2. Tests: every existing index test passes unchanged; add a test that a `putMany` of an unchanged row writes only the primary op (count ops through a recording `Db`), and that changing a sort key writes the old-key delete and the new-key put.
3. Do not change key layouts, so no migration.

**Then, in this order, each its own PR:** PR2 `view.scanRuns` plus `Table.search` on it, as in LPFM section 2 (the generic read primitive; miss at 1M goes from about 1 s to about 35-39 ms). PR3 (only if drift is seen) persisted spec fingerprint with `reindex` (option iii). PR4 unique indexes (option iv), which is a few lines once `entriesOf` exists.

**Evidence that would change my mind:**
- The Chrome bench shows put latency or bulk ingest rate dominated by index keys for a realistic row (more than about 3 index keys per row after D), in OPFS and IndexedDB, not MemoryFs. That would favour option i-b (fewer keys) first, then ingest-time derivation with explicit tombstones (LPFM PR3).
- Tables above about 500k rows where a 35-39 ms miss is still too slow (MEIA parked A at that size). That would favour a persisted whole-word vocabulary (LPFM section 4) or an SST section.
- A product need for ranking, phrase or fuzzy search. That is the Lucene/Tantivy/SAI family and the format change; it is a different project.
- Two tabs running different app versions against one database in practice (orphans, wrong results). That moves PR3 up.
- A kv user that needs to write derived keys without knowing the old row. Then revisit Tarantool's deferred DELETE as a design, not before.

---

## 7. What I did not verify

- No benchmark or prototype was run. Every number is from MEIA or LPFM, measured on Node and MemoryFs, not Chrome or OPFS.
- That `putMany` writes 1 + 2N ops for an unchanged re-put is from reading `table.ts:229-266` and `check.ts:60-86`. I did not count ops with a recording stub.
- Berkeley DB, WiredTiger, Tarantool, RocksDB, Cassandra `Index.java`/`TableViews.java`, CockroachDB, the IndexedDB spec, Chromium and the Luo and Carey survey: read from source or PDF text. Berkeley DB `DB->associate` page, FoundationDB `StandardIndexMaintainer`, Cassandra MV and SAI pages, SQLite `expridx` and FTS5, TiDB: read through a summarising fetch; re-check before quoting. The Cassandra MV docs page said nothing about read-before-write; the source did.
- WiredTiger: `type=lsm` colgroup behaviour not read; `develop` has no `lsm_tree.c` and no `WT_EXTRACTOR` in `wiredtiger.h.in` by `grep`, reason not investigated. Line numbers for WiredTiger are from branch `mongodb-7.0` unless stated.
- RocksDB: only the seven headers named in 3.3; other headers not searched. MyRocks and other RocksDB layers not read.
- FoundationDB: index states (write-only, readable, disabled) and the online indexer not read.
- Cassandra SAI: no source read; "no read-before-write" is an inference from the docs page.
- IndexedDB in Firefox and WebKit: not read. Chromium's leveldb or SQLite backing-store code for delete: not read; the delete-by-value behaviour is from the spec.
- Dexie internals, RxDB storage code, PouchDB's map-reduce implementation, ElectricSQL, Triplit, PGlite beyond its about page: not read. The Triplit page returned no content.
- Luo and Carey [47] (the PVLDB 2019 paper): only the survey's summary read. The measurements about eager versus lazy come from the survey's wording, not from the figures of the original.
- Lucene: not re-fetched in this task; relies on MEIA 2.1.
- Tarantool vinyl's `defer_deletes` default and whether path multikey indexes work on vinyl: not checked.

---

## 8. Sources

Repo: `AGENTS.md`; `packages/collections/src/table.ts`, `database.ts`; `packages/kv/src/db.ts`, `check.ts`, `view.ts`, `store/fold.ts`, `host/protocol.ts`, `host/ingest.ts`; `docs/design.md`; `docs/research/multi-entry-index-alternatives.md`, `docs/research/landing-projections-and-fast-misses.md`. Checkout at `433e94e`.

External (fetched 2026-11-06):
- `bdb-assoc` https://docs.oracle.com/cd/E17276_01/html/api_reference/C/dbassociate.html (summary)
- `bdb-guide` https://docs.oracle.com/cd/E17276_01/html/programmer_reference/am_second.html
- `bdb-src` https://raw.githubusercontent.com/berkeleydb/libdb/master/src/db/db_cam.c
- `wt-ext` https://source.wiredtiger.com/mongodb-7.0/custom_extractors.html ; `wt-schema` https://source.wiredtiger.com/mongodb-7.0/schema.html
- `wt-h70` https://raw.githubusercontent.com/wiredtiger/wiredtiger/mongodb-7.0/src/include/wiredtiger.in ; `wt-cur70` https://raw.githubusercontent.com/wiredtiger/wiredtiger/mongodb-7.0/src/cursor/cur_table.c ; develop: https://raw.githubusercontent.com/wiredtiger/wiredtiger/develop/src/cursor/cur_table.c
- `fdb-docs` https://foundationdb.github.io/fdb-record-layer/Overview.html and https://foundationdb.github.io/fdb-record-layer/Extending.html
- `fdb-store` https://raw.githubusercontent.com/FoundationDB/fdb-record-layer/main/fdb-record-layer-core/src/main/java/com/apple/foundationdb/record/provider/foundationdb/FDBRecordStore.java ; `fdb-sim` same directory `indexes/StandardIndexMaintainer.java` (summary)
- `tnt-doc` https://raw.githubusercontent.com/tarantool/doc/latest/doc/reference/reference_lua/box_space/create_index.rst and `.../doc/code_snippets/test/indexes/create_index_func_multikey_test.lua` ; `tnt-vinyl` https://raw.githubusercontent.com/tarantool/tarantool/master/src/box/vinyl.c , `vy_stmt.h` , `vy_write_iterator.h` (same directory)
- `rocks-h` https://raw.githubusercontent.com/facebook/rocksdb/main/include/rocksdb/ : `table_properties.h`, `compaction_filter.h`, `slice_transform.h`, `merge_operator.h`, `index_factory.h`, `user_defined_index.h`, `table.h`
- `cass-idx` https://raw.githubusercontent.com/apache/cassandra/trunk/src/java/org/apache/cassandra/index/Index.java ; `cass-mv` https://raw.githubusercontent.com/apache/cassandra/trunk/src/java/org/apache/cassandra/db/view/TableViews.java ; `cass-mv-doc` https://cassandra.apache.org/doc/latest/cassandra/developing/cql/mvs.html (summary) ; `cass-sai` https://cassandra.apache.org/doc/latest/cassandra/developing/cql/indexing/sai/sai-concepts.html (summary)
- `lucene` https://lucene.apache.org/core/9_10_0/core/org/apache/lucene/codecs/lucene99/package-summary.html (via MEIA) ; `tantivy` https://raw.githubusercontent.com/quickwit-oss/tantivy/main/ARCHITECTURE.md
- `sqlite-expr` https://www.sqlite.org/expridx.html (summary) ; `fts5` https://sqlite.org/fts5.html (summary, partly read)
- `crdb-upd` https://raw.githubusercontent.com/cockroachdb/cockroach/master/pkg/sql/row/updater.go ; `tidb` https://docs.pingcap.com/tidb/stable/tidb-computing/ (summary)
- `idb-spec` https://w3c.github.io/IndexedDB/ ; `chr-blink` https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/indexeddb/idb_object_store.cc and `.../content/browser/indexed_db/instance/index_writer.cc`
- `couch-views` https://docs.couchdb.org/en/stable/ddocs/views/intro.html ; `pouch-q` https://pouchdb.com/guides/queries.html
- `dexie` https://dexie.org/docs/Version/Version.stores() and https://dexie.org/docs/Table/Table.hook('creating') ; `rxdb` https://rxdb.info/rx-schema.html ; `pglite` https://pglite.dev/docs/about (summary)
- `luo` https://arxiv.org/abs/1812.07527 (PDF read locally as text)
