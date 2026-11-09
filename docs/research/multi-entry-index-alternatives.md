# Text search without per-put index entries

Question: the multi-entry index writes one index key per token or prefix per row, so a put is expensive. What gives us string and text search without that per-put cost?

## Decision

**Update 2026-11-06, later the same day: stop at D.** Reading the kv code for the projections work (A) found that it does not fit the plan below as written, so the program stops at D (3.4), shipped in PRs 67 and 68. A is parked, not rejected. The original decision follows, kept for the record.

Why A is parked:
- Compaction does not clean up stale derived records. The derived key holds the sort key, a delete reaches the ingest fold as a row key with no value, so kv cannot compute the derived key to tombstone, and the merge drops only older versions of the same key (`engine.ts:127-158`). A title edit is fine because the derived key is unchanged; deletes and sort-key changes leave orphans. "No compaction change" and "cleanup at compaction" cannot both hold. Exactness needs an old-value lookup at ingest or a Rust merge hook.
- The ingest fold runs in the SharedWorker from IndexedDB records and has no memtable, so it cannot reuse memtable projections.
- The declaration cannot ride the `watch` message: two SharedWorkers can serve one database, and a host that never saw it writes runs without derived records. It must be stored in the IndexedDB meta store.
- The derived prefix must be reserved from user writes, existing databases need a backfill, and collections must dedupe candidates and re-match the predicate, because the no-merge per-run scan returns stale text from older runs.
- The formal models have no property for derived records.

Revisit A if a table needs about 500k rows or more: D's rare-word search is about 1 s per million rows (E1). The cheapest start is projections sorted by sort key, leaving one orphan per deleted row and relying on validation, with the ingest lookup added later. A row-key-sorted variant removes the cleanup problem but loses newest-first early exit, which hurts one-letter prefixes (unmeasured).

**Update, same day: the SST format change is allowed again.** The constraint "no new SST section" was the user's, and it is lifted. Consequences (inference [I], from the research in `docs/research/derived-index-prior-art.md` and `docs/research/landing-projections-and-fast-misses.md`):
- Family B (derive at flush and compaction, inside the immutable file; Lucene, Tantivy, Cassandra SAI) is viable. A per-run section is rebuilt from the live rows of each run written, so orphans do not exist, no tombstones or old-value lookups are needed, no derived prefix is written into the user keyspace, and backfill happens by compaction (runs without a section fall back to a normal scan until compacted).
- Still required: the extraction rule stored in the IndexedDB meta store (not sent in `watch`), validation by `get` on candidates (an older run can hold stale text for an overwritten row), a Rust encoder and merge that extract text from JSON values with a declarative rule (a path plus a normaliser and word splitting, not a user function), a format version, a `view` scan API, a formal property, and one shared word-splitting and lowercasing rule for Rust and JS tested on non-ASCII text.
- What it buys over `view.scanRuns` plus D: no extra put key (3.0 to 2.0 ops per row, E0), about 27 MiB instead of about 93 MiB of text at 1M rows (E2), one buffer decode per run instead of a cursor over every record (about 0.7 s total in E2b), and E3-style per-run pruning or a sorted word dictionary inside the section for faster misses. It costs Rust, the format and the declaration.
- Order stays: collections-only `entriesOf` and `diffEntries`, then `view.scanRuns` with `Table.search` on it, then the per-run section only if a Chrome benchmark shows the 0.7 s build, the memory, or the extra key per put matters. `scanRuns` should return a type a run can fill from D keys or from a column, so the section later slots in behind it.

**Update, same day: how much of indexing belongs in kv.** The goal is a flexible storage engine for any kind of database, so kv should stay generic. [I] throughout; nothing here is built or measured.
- The per-run section with a built-in JSON text extractor would make kv a document-store engine: it would need JSON paths, lowercasing, word splitting and a tokenizer shared by Rust and JS. Other flexible engines keep secondary indexes in layers above the core (RocksDB with MyRocks, CockroachDB and TiKV over a plain KV, the FoundationDB Record Layer, LMDB). WiredTiger and Berkeley DB derive keys inside the engine, and both still read the old row on write (`docs/research/derived-index-prior-art.md`).
- Three levels by how much kv owns:
  - **Level 0.** kv offers atomic `update`, snapshots and `view.scanRuns` (unmerged range scans per source) and knows nothing about indexes. Collections derives keys with read-before-write and searches the D keys per run. Miss about 35-39 ms at 1M rows.
  - **Level 1.** Level 0 plus a generic per-run collector hook: kv feeds a plugin the entries in key order at flush and compaction and stores the blob it returns in the run, without knowing what the blob is. Open problem: compaction runs in wasm, so the plugin must be wasm shipped as bytes and stored in IndexedDB, or kv must decode every merged output back into JavaScript. Neither is researched.
  - **Level 2.** Level 1 with a built-in JSON text extractor in Rust. Largest cost, strongest coupling.
- Decision: level 0 now. Design the `scanRuns` return type so a run can later supply a plugin blob instead of D keys. Add the collector hook only when a second kind of index needs it (a vocabulary, a Bloom filter, a vector index), because a plugin interface designed against one use is likely wrong. Indexes stay a collections concern, and kv grows only by generic read mechanisms.
- Open: what other databases are meant to run on kv, and whether collections should be one possible layer among several. A concrete second use would test whether level 0's primitives are enough.

Original decision, superseded by the updates above:

Decided 2026-11-06. Details and numbers are in sections 3 to 6.

- **Design: A as projections (3.1).** kv derives ordinary `p/<name>/<sortKey>/<rowKey> -> text` records during the ingest fold, so the SST format, the Rust encoder and the compaction merge do not change. The memtable projects lazily and caches the result. Collections searches through one per-run scan API (3.8) and validates candidates with point gets.
- **Sequencing: D first, then A.** D (3.4) is collections-only, costs 3 kv ops per row against 18.4 today (E0), and is fast enough up to about 100k rows (E1). A replaces D's per-put key with ingest-time derivation: no put cost, and about 35 ms for a rare word at 1M rows against about 1 s for D (E2b).
- **Discarded:** E3 and design C, because they need a new SST section; the earlier column variant of A with an SST v2 section; B, E and F as listed in section 4.
- **Why accepted:** put cost leaves the ack path; ingest is about 1.5x a rows-only ingest (E5); the tail search is about 2.5 ms at the default trigger (E4); two-tab visibility follows from the tail being the memtable every tab already builds from the WAL, and any two-tab issue will be handled at implementation (E6 is deferred until A exists).

Carried into implementation, none of which blocks the decision:
- **Deletes and sort-key changes (3.1, open question 2):** start with validation by `get`, a documented rule that the sort key is immutable, and cleanup at compaction; add an old-value lookup at ingest only if churn makes stale records matter.
- **Per-run build cost (E2b):** about 23 ms per run, about 0.7 s at 1M rows, so build lazily per run or off the main thread.
- **String memory:** about 27 MiB per tab at 1M rows; evict least-recently-used runs.
- **Untested environments:** all numbers are MemoryFs, Node (V8) and synthetic titles. Real OPFS, Chrome, and other engines' string search are unmeasured.
- **E6:** the multi-tab Chrome proof, once A exists.
- **Stale doc:** `docs/design.md:418-421` says the ingest trigger is 4 MiB; `ingest-policy.ts:23-25` sets 1 MiB.

---

Conventions. **[R]** = repo fact, cited as `file:line`. **[E]** = external fact, cited with the owner's URL. **[I]** = my inference, not verified by a source or a run. Numbers marked *(run)* are ones I measured on 2026-11-06 in this checkout (Node 24, MemoryFs, laptop); they are single runs, not tuned benchmarks.

Method caveat. External pages were read through a fetch tool that summarises with a small model, so the quoted fragments should be re-checked against the page before being quoted in public. The two LSM papers were read from the PDF text locally and are more reliable. The FTS5 page is long and only partly read (sections 4, 6 and 9 were covered).

---

## 1. Repo facts

### 1.1 How the multi-entry index writes

- A multi-entry index writes one key per distinct array element, and per combination for compound paths. `table.ts:22-28` (`multiEntry` doc), `table.ts:94-107` (`readIndexValues`), capped at 1,000 keys per row (`table.ts:32`, test `multi-entry.test.ts:111-134`).
- `putMany` reads the previous rows, deletes their old index keys, then `tx.put`s the row and every new index key, in one `db.update` (`table.ts:187-199`). So every put pays a read-before-write plus 1 + N puts and up to N deletes. `update` diffs old and new keys (`table.ts:207-227`); `delete` and `clear` also compute and delete all keys (`table.ts:286-332`).
- Index values are empty (`EMPTY`, `table.ts:41,197`); all information is in the key: `i/` + table + index + typed value + id.
- Every key is a WAL op in the IndexedDB record of that batch. A batch is capped at 10,000 ops and 8 MiB (`docs/design.md:516-523`), which is why the todo example seeds in batches counted by ops, not rows (`examples/todo/model.ts:20-25`).
- The todo example's index is `byTermNewest` on `["terms","newest"]`, where `terms` holds every prefix (length 1 to 12) of every title word, and `terms` is also stored inside the row JSON (`examples/todo/model.ts:26-28,38-39,57,117-125`; `examples/todo/README.md:51`).

### 1.2 Queries that must work today

- Word-prefix match, AND across typed words, case-insensitive, newest first, cursor paged, page size 50: "each typed word starts a word of the title, ignoring case, so 'mil' finds 'Buy milk' but 'lk' doesn't" (`examples/todo/README.md:31`; `examples/todo/model.ts:135-139` `matchesFilter`). The query reads `byTermNewest` for the longest word and checks the other words on each row (`examples/todo/README.md:55`).
- Substring (`includes`) is what the example did before the term index (`packages/collections/scripts/bench-search.ts:167-177`). No ranking (BM25 etc.) exists or is asked for; no phrase or fuzzy search.
- Order matters: results are newest first with a stable cursor (`Table.page`, `table.ts:236-280`).

### 1.3 Quantified overhead

*(run)* `Table.putMany` into a recording stub, 5,000 todo-shaped rows, indexes `byNewest`, `byOldest`, `byTitle`, `byTermNewest`, random 2-5 word titles from a 10-word vocabulary (avg word 5.3 letters), UUID ids:

| Variant | KV ops per row | term keys per row | avg term key bytes | term-key bytes per row | all key+value bytes per row |
|---|---|---|---|---|---|
| all prefixes (todo example) | 20.2 | 16.2 | 76 | 1,232 | 1,743 |
| whole words only | 7.0 | 3.0 | 78 | 238 | 673 |
| (no term index: 4 ops by `opsFor` formula, `model.ts:25`) | 4 | 0 | | 0 | about 440 (derived) |

So prefix terms are about 5x the ops and about 4x the WAL bytes of a row with no term index. `bench-search.ts` has no put timer, and neither has `bench-index-runs.ts`; neither measures put latency or ack time. This is a gap in the repo benches (see experiment E0).

Storage after flush and compaction, `pnpm bench:search` at 100,000 todos *(run)*:

| Layout | Run MiB | Term index share of record bytes |
|---|---|---|
| prefixes | 91.5 | 79% |
| `TERMS=words` | 29.1 | 47% |

SST bytes per index entry, `bench-index-runs` 20,000 rows, UUID ids *(run)*: 53.3 B raw, 46.6 B LZ4 per index-only entry; whole run 78.8 B raw per entry. Index entries were 96,812 of 116,812 entries (4 indexes, one multi-entry `byTag`). Every compaction level rewrites these entries again (leveled, ratio 10: `docs/design.md:459-469`, merge decodes and re-encodes everything `docs/design.md:482-493`).

Query side *(run)*, 100,000 todos:

| Query | p50 |
|---|---|
| substring walk (page `byNewest`, decode row, `includes`), no match | 746 ms |
| substring walk, one match at the end | 658 ms |
| term index, no match | 5 µs |
| term index, one match | 10 µs |
| term index, common word full page | 262 µs |
| term index, one-letter prefix full page | 272 µs |

The term index is excellent for reads, which is why the target is: keep (almost all of) that read speed without the write bill. Note the "substring walk" is slow mostly because it pages through and JSON-decodes every row, not because matching 100k strings is slow (see 2.7).

### 1.4 Architecture that constrains the design

- WAL in IndexedDB, one record per acked batch; ack = IDB commit (`docs/design.md:54-99`; `architecture/00-grounding.md:13-17`).
- Each tab keeps a memtable of all uningested WAL records, folded to one row per key, kept in key order (`docs/design.md:107-121`). Other tabs apply appends over BroadcastChannel or by reading the WAL tail (`docs/design.md:371-383`). Reads never wait on the SharedWorker (`architecture/00-grounding.md:17`, `docs/design.md:350-352`).
- The SharedWorker folds the WAL into an L0 SST once the pending op bytes reach `maxWalBytes`, 1 MiB by default (`packages/kv/src/ingest-policy.ts:23-25`; `docs/design.md:418-421` says 4 MiB, which differs from the code) (`ingest.ts:25-60`), then compacts L0 -> L1 -> ... in wasm (`docs/design.md:457-507`, `compact.ts:33-61`). The host sees only bytes; it has no schema (`packages/kv/src/host/protocol.ts:9-28`).
- An SST is bytes keys/values with a trailing bloom section, block index and a 44-byte footer; the reader rejects any file whose sections are not contiguous or whose version is not 1 (`docs/design.md:143-164,236-262`; `sst.ts:440-452`). The bloom is built from keys at encode time (`sst.ts:348`). The bloom plays no part in scans (`docs/design.md:364`).
- Runs are immutable, referenced by manifest generation, and every tab holds every live run's bytes in memory (LZ4 from L2) (`docs/design.md:45-49,271,298-301,569`). A `view` pins `appliedThrough`, the generation, memtable chunks and levels (`docs/design.md:366`).
- Platform: OPFS has no multi-file atomicity; "generation/manifest protocol owns crash consistency of the SST set" (`architecture/00-grounding.md:25`). So anything that must be visible atomically with a run belongs inside the run file.
- Project rules: "read/write performance above everything", "KISS", "consistency should be guaranteed, persistence not", "before adding a new cache, check if we can achieve the same performance with an architectural change", and no backward-compatibility concern while prototyping (`AGENTS.md:3-12`). The last one means an SST v2 is allowed.
- Range scan speed *(run)*: `bench-index-runs` "index scan" of 96,812 keys takes 3.8-6.2 ms raw, 6.4-8.3 ms LZ4 (about 40-90 ns per key) after run bytes are in memory. This is one run iterated alone; across about 100 runs through the kv merge, E1 (section 6) measured about 540 ns per key.

---

## 2. External facts, by candidate

### 2.1 Lucene / Tantivy segment-based inverted index, "index at flush"

- Lucene: "Indexes evolve by: 1. Creating new segments for newly added documents. 2. Merging existing segments." "Each segment is a fully independent index, which could be searched separately." "Deleted documents are dropped when segments are merged." Files: `.tim` term dictionary, `.tip` term index, `.doc` postings, `.pos` positions. https://lucene.apache.org/core/9_10_0/core/org/apache/lucene/codecs/lucene99/package-summary.html
- Lucene buffers documents in RAM and flushes a segment when the buffer reaches a size (`setRAMBufferSizeMB`, default 16 MB) or a doc count; default merge policy is `TieredMergePolicy`. https://lucene.apache.org/core/9_10_0/core/org/apache/lucene/index/IndexWriterConfig.html
- Tantivy: "A tantivy index is a collection of smaller independent immutable segments." The in-memory representation is converted "into an on-disk immutable representation" at the end of a batch or on a memory limit; merges run in separate threads "eventually get rid of tombstoned documents"; the term dictionary is an FST; postings are in blocks of 128 docs. https://raw.githubusercontent.com/quickwit-oss/tantivy/main/ARCHITECTURE.md
- Elasticsearch (Lucene) accepts a visibility lag: "A refresh makes all operations performed on an index since the last refresh available for search", refreshed every second by default (only on indices searched in the last 30 s). https://www.elastic.co/docs/manage-data/data-store/near-real-time-search

Reading: the tokenisation and postings work happens once per segment write, not once per document write. Term strings are stored once per segment with a postings list, not once per (term, doc). Search-visible latency before flush is handled by refresh, which we cannot copy (see 3).

### 2.2 SQLite FTS5

- The index is "a series of b-trees". "Level-0 b-trees are the smallest, as they contain the contents of a single transaction." "Each time a new transaction is committed, a new b-tree containing the contents of the committed transaction is written" (section 6.1). `automerge` "determines how many smaller b-trees are merged together at a time", default 4, max 16, 0 disables; `crisismerge` default 16 "merged immediately"; `usermerge` default 4; the `merge` command merges "until roughly N pages of merged data have been written". https://sqlite.org/fts5.html (sections 6.1, 6.2, 6.8, 6.14)
- Structure: "Each time a write to the FTS5 table is committed, one or more (but usually just one) new segment b-trees are added"; each segment has a level; a "structure record" lists the current segments and in-progress merges (section 9.2). Prefix indexes are separate keyspaces, "up to 31 prefix indexes" (`fts5_index.c` header). https://sqlite.org/fts5.html ; https://raw.githubusercontent.com/sqlite/sqlite/master/ext/fts5/fts5_index.c
- Prefix option: "A prefix index is a separate index that records the location of all instances of prefix tokens"; without one "querying for a prefix token can be slow, as it requires a range scan" (section 4.2). So FTS5 itself documents the same trade we face: a prefix index costs write and space, a range scan of the term dictionary costs read time.
- Trigram tokenizer gives substring search and indexed `LIKE` / `GLOB`; "Substrings consisting of fewer than 3 unicode characters do not match any rows" in full-text queries (section 4.3.4). `detail=none` stores only rowids; the doc's size test: 743 MiB (full), 340 MiB (column), 134 MiB (none) (section 4.6).
- How it batches: the batching unit is the transaction, because one segment is written per commit with each term's doclist merged inside the segment. FTS5 still maintains the index at write time; what it avoids is a separate key per (term, row) and uses background merges to bound segment count. In-memory: the `Fts5Index` struct comment mentions "accumulation of tokens and doclists within the in-memory hash tables before they are flushed to disk" (`fts5_index.c`).
- Reading: FTS5 is what "index at flush" looks like inside a transactional store. The analogue in this repo is "one segment per ingest", not "one segment per put", because the WAL is the transaction log (`docs/design.md:54-99`).

### 2.3 RocksDB / LevelDB: structures built when an SST is created

- RocksDB: "when the filter policy is set, every newly created SST file will contain a Bloom filter"; full filters are one per file, partitioned filters split by key range; "When Options.prefix_extractor is set, a hash of the prefix is also added to the bloom"; 9.9 bits per key gives 1% false positives. https://github.com/facebook/rocksdb/wiki/RocksDB-Bloom-Filter
- Prefix bloom: "Users can only use prefix bloom filter to read inside a specific prefix", and the prefix is defined by `prefix_extractor` on the key. So it answers "does this run have this key prefix" not "does this value contain this word". https://github.com/facebook/rocksdb/wiki/Prefix-Seek
- Hook for user-defined per-SST summaries: `TablePropertiesCollector`, one object per table file, called sequentially with `AddUserKey(key, value, type, seq, file_size)` as entries are added and `Finish(properties)` when the table is built; a factory can return `nullptr` to skip a file. The results land in the SST's properties block. https://raw.githubusercontent.com/facebook/rocksdb/main/include/rocksdb/table_properties.h
- LevelDB: `FilterPolicy` reduces disk reads for `Get`, and a custom policy can transform keys; Bloom "reduce[s] ... unnecessary disk reads needed for Get() calls by a factor of approximately a 100". https://raw.githubusercontent.com/google/leveldb/main/doc/index.md
- Reading: both systems build per-SST summaries at flush and compaction time, over entries that went through the write path with no extra write ops. Neither natively searches inside values; RocksDB's `TablePropertiesCollector` shows the pattern where the engine calls user code for each entry while writing a table, which is where a text summary could be built.

### 2.4 LSM secondary index research

- Luo and Carey, "LSM-based Storage Techniques: A Survey" (VLDBJ 2019/2020), section 3.7: secondary indexes and filters are the two LSM auxiliary structures; "maintaining these structures during data ingestion comes with extra cost". Qader et al. (SIGMOD 2018) found that "the eager inverted list scheme incurs a large overhead on data ingestion because of the point lookups and high write amplification", while filters (min/max or Bloom on secondary keys) "were found to be very effective with small storage overhead for time-correlated workloads"; Diff-Index defines four maintenance schemes: sync-full, sync-insert, async-simple, async-session; DELI (Tang et al.) cleans secondary indexes lazily during primary merges. https://arxiv.org/abs/1812.07527 (PDF text, section 3.7)
- Luo and Carey, "Efficient Data Ingestion and Query Processing for LSM-Based Storage Systems" (VLDB 2019): "Existing LSM-based systems, such as AsterixDB, MyRocks, and Phoenix, employ an eager strategy to maintain auxiliary structures by prefacing each incoming write with a point lookup ... it leads to significant overhead during ingestion". Their Validation strategy does not clean the secondary index on ingestion; queries validate candidates against the primary index (direct validation or timestamp validation), so "secondary indexes are not always guaranteed to be up-to-date and can thus return obsolete entries". https://arxiv.org/abs/1808.08896 (PDF text, sections 1, 4)
- Filters in this literature are per-component min/max or Bloom summaries and are "only effective for time-correlated fields since components are naturally partitioned based on time" (survey, section 3.7).
- Reading: `Table.putMany` is the Eager strategy of those papers: it reads prior rows and deletes old index keys inside the write transaction (`table.ts:187-199`). The cheapest structural fix in the literature is Validation: do not maintain, verify at query time.

### 2.5 Per-run n-gram and token Bloom summaries, trigram index, signature files

- Russ Cox, trigram index: "an index of n-grams ... 3-grams (trigrams) it is"; the query is turned into AND/OR of trigrams, intersect posting lists, then "identify a set of candidate documents and then run the full regular expression search against only those documents"; index "tends to be around 20% of the size of the files being indexed" (Linux: 420 MB -> 77 MB); narrowing 36,972 files to 25 gave about 100x. https://swtch.com/~rsc/regexp/regexp4.html
- PostgreSQL `pg_trgm`: GIN or GiST index support `LIKE`, `ILIKE`, `~`, `~*`, and "a pattern with no extractable trigrams will degenerate to a full-index scan". GiST stores "a bitmap signature" per row with `siglen` 1-2024 bytes (default 12): "Longer signatures lead to a more precise search ... at the cost of a larger index". https://www.postgresql.org/docs/current/pgtrgm.html
- ClickHouse skipping indexes (docs mark `tokenbf_v1` / `ngrambf_v1` deprecated in favour of a text index): Bloom filter over tokens or n-grams of a column, used for `LIKE`, equals, `hasToken`; "Adding them to a table incurs a meaningful cost both on data ingest and on queries"; "if a value occurs even once in an indexed block, it means the entire block must be read"; with no correlation to the primary key "few blocks will be skipped". https://clickhouse.com/docs/optimize/skipping-indexes
- Elasticsearch `wildcard` field: "indexes the whole field value using ngrams and stores the full string"; the n-gram index is "a rough filter" then candidates are checked against the stored value. https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/keyword#wildcard-field-type
- Signature files in production: BitFunnel (Goodwin et al., SIGIR 2017) argues signatures can beat inverted files and reports that Bing replaced an inverted-index system for operating cost. I only saw the Microsoft Research abstract page (https://microsoft.com/en-us/research/?p=476730), not the full text, so treat details as unverified.
- Reading: a per-block or per-run Bloom summary is cheap to build at flush, supports substring (n-gram) and word queries with false positives, and always needs a verify pass. It only prunes if matches are clustered (ClickHouse correlation note). Our SST blocks are ordered by primary key (UUID in the bench), so for common words every 4 KiB block has a hit, and the summary prunes nothing. It prunes for rare words ("needle") well.

### 2.6 Suffix array, FM-index, sorted-token dictionary

- FM-index: Ferragina and Manzini, "Opportunistic Data Structures with Applications", FOCS 2000: counting a pattern in O(p) time independent of text length, in space proportional to the compressed text (k-th order entropy). Citation as given in https://en.wikipedia.org/wiki/FM-index (the original PDF link on that page is dead; I did not read the paper itself).
- Sorted-token dictionary: Lucene's term dictionary and Tantivy's FST (2.1) answer prefix queries by a range over sorted terms, and FTS5 documents the same ("range scan", 2.2). No prefix keys needed.
- Reading: suffix arrays and FM-indexes give true substring in O(p) but cost build time and memory, and our runs live in each tab's heap (`docs/design.md:569`). Not proportionate for a todo-style title search; a sorted token dictionary gives word-prefix with no prefix expansion.

### 2.7 Brute force as the baseline to beat

- `memchr` crate `memmem` (Rust substring search): "uses SIMD on x86_64, aarch64 and wasm32"; a `Finder` can be built once and reused over many haystacks. https://docs.rs/memchr/latest/memchr/memmem/index.html
- My own synthetic measurement *(run, `scratchpad/scan.mjs`, Node 24 / V8)*. Titles are 2-5 words from a 10-word vocabulary, so it is optimistic (short repetitive text):

| Rows | Text size | `titles.includes` loop (array of strings) | `indexOf` over one concatenated string | word-prefix regex over concatenated string | `indexOf` that matches many ('alp') |
|---|---|---|---|---|---|
| 100k | 1.2 MB | 1.1 ms | under 0.1 ms | 0.2 ms | 1.5 ms |
| 1M | 12.0 MB | 10.5 ms | 0.2 ms | 1.6 ms | 14.1 ms |

  The `indexOf` miss case is flattered by V8's skip search on an absent letter; take the regex row (1.6 ms per million titles) as the realistic lower bound.
- Combine with the repo's own numbers: today's 658-746 ms substring walk at 100k rows is dominated by paging, key following and JSON decode (`bench-search.ts:167-177`), not by string comparison. The real brute-force cost is bounded by how much memory must be touched: the title bytes (12 MB per million rows) if titles are laid out contiguously, versus the full row bytes if rows must be decoded.

---

## 3. Mapping onto this repo

Hook points: **H1** `Table.putMany/update/delete` (`table.ts`), **H2** WAL record, **H3** memtable (`docs/design.md:107-121`), **H4** fold at ingest (`fold.ts:14-26`, `ingest.ts:41-47`), **H5** SST encode (`sst.ts:332-405`, `crates/engine-core/src/sst.rs`), **H6** compaction merge (`compact.ts:47-52`, `compact.rs`), **H7** manifest/generation install (`compact.ts:68-88`), **H8** view pin (`docs/design.md:366`), **H9** `watch` message from tabs to the SharedWorker (`protocol.ts:17-23`).

| # | Design | Hook | Put cost (ops/row) | Query cost | Storage | Consistency story | Engine change |
|---|---|---|---|---|---|---|---|
| 0 | Today: multi-entry, all prefixes | H1 | 20.2 ops, 1.2 KB of keys (run) | 5-270 µs (run) | run MiB 91.5 at 100k, term share 79% | exact, atomic with the row | none |
| 0b | Words only + range scan of term keys for prefix | H1 | 7.0 ops (run) | one range per prefix over many terms, k-way merge by newest [I] | 29.1 MiB at 100k (run) | exact | none (collections only) |
| A | Projections: kv derives `p/<name>/<sortKey>/<rowKey> -> text` entries at ingest, as ordinary records (primary) | H4, H9 (H3 for the tail) | 0 extra on the ack path; one extra record per row written at ingest, off the ack path | per-run contiguous block of derived records, decoded once to a string and searched with `String.indexOf`: 36 ms at 1M rows for an absent word with a pre-built column (run, section 6) plus validation gets | one derived record per row (about 70 B + title), like D, but written at ingest and rewritten at compaction | validated against current rows (Luo and Carey Validation); memtable tail scanned through the same projection | none in the SST format; kv gains projections at ingest, a per-run scan, and a `watch` field |
| B | Per-run sorted token dictionary and postings in the SST (Lucene/FTS5 style) | H4, H5, H6, H9 | 0 extra | dictionary range plus postings intersect, near term-index speed [I] | postings, no per-prefix keys | same as A | larger than A (tokenizer, postings merge) |
| C | Per-block or per-run n-gram/token Bloom summary | H5, H6 | 0 extra | prune runs or blocks, then scan survivors | 10 bits per distinct n-gram per block [E: RocksDB bloom] | verify pass, false positives only | SST v2 section |
| D | One search-document key per row, scanned by range (fallback) | H1 only | +1 op | range scan through the kv merge, about 540 ns per key at 1M rows: about 1 s for a rare or absent word, 0.15 ms for a common word (run, E1 in section 6), newest-first early exit | one key (about 70 B + title) per row | exact, same WAL batch as the row | none |
| E | Deferred indexing: write token keys from a background pass (`indexedThrough`) | H1, H9 | 0 on ack path | index plus scan of `seq > indexedThrough` | same as 0, written later, coalesced | lag fixed by scanning the unindexed tail | host job, seq watermark |
| F | Suffix array / FM-index per run | H5 | 0 extra | O(p) | large | as A | big |

### 3.1 A: projections, derived records written at ingest (recommended primary)

Idea. A **projection** is a declaration to kv: "for rows under key prefix P, derive an entry `p/<name>/<sortKey>/<rowKey> -> normalised text`", where `sortKey` and the text come from named paths of the row value (for example `newest` and `title`, lowercased). kv computes the derived entries when it folds the WAL into a run (H4, `fold.ts:14-26`, `ingest.ts:41-47`) and writes them as **ordinary records** in the same run. This is D (3.4) with the second key written by kv at ingest instead of by collections at put. No new SST section, no encoder or merge change: compaction already merges ordinary records (H6), so derived records are merged, shadowed and dropped like any other key. Earlier drafts of A added an SST v2 section; this variant replaces it (it is the RocksDB `TablePropertiesCollector` idea, 2.3, moved from run metadata to ordinary records).

- Put cost: zero extra ops on the ack path. The WAL carries only the row (about 440 B derived vs 1,743 B per row in 1.3), and the read-before-write for term-key cleanup in `table.ts:187-199` goes away for this field. The derived record is paid once at ingest, in the SharedWorker, off the ack path, and rewritten at each compaction like any record.
- Key order: `p/<name>/<sortKey>/<rowKey>` sorts by `sortKey`, so inside one run the derived records are one contiguous block in `newest` order, and a run scan can stop early for common words, as E2 did.
- Query: a per-run scan (3.8, feature 3) reads each run's `p/<name>/` block directly, without the k-way merge across runs that costs about 540 ns per key (E1, section 6). The block is decoded once per run into one string and cached; `String.indexOf` on it matches the speed of `Buffer.indexOf` (3.8, feature 4). Collect candidates, order by `sortKey`, **validate** the top candidates with a point `get` (about 4-8 µs each on L2, `docs/design.md:292,313`), and stop when a page is full. A stale candidate is dropped by validation, as in Luo and Carey's Validation strategy (2.4).
- Substring, word-prefix, multi-word AND, and later regex all work on the same text; short needles of 1-2 characters work (the trigram indexes in 2.2 and 2.5 cannot do that).
- Storage: one derived record per row, the same shape as D (about 70 B of key plus the title), inside the run file, so it is pinned by the same generation and view (H8) and is atomic with the run, which respects the OPFS multi-file limit (`architecture/00-grounding.md:25`). No sidecar file, no new crash handling. It is bigger than a packed column because each record carries a key and framing; this is the price of keeping the SST format unchanged.
- Tail: the memtable keeps the projected value on each entry, computed lazily on the first scan and cached (3.8, feature 2). The memtable and the un-ingested WAL hold at most `maxWalBytes` of op bytes before ingest triggers, 1 MiB by default (`ingest-policy.ts:23-25`; `docs/design.md:418-421` says 4 MiB) (`docs/design.md:418-421`), so the tail scan is bounded, and ack visibility is unchanged because the tail is what every tab already merges over runs (`docs/design.md:107-121,371-383`).
- Multi-tab: runs are built once by the SharedWorker and installed by generation, so all tabs see the derived records after `sync` (`docs/design.md:385-395`). No per-tab build of runs; each tab only builds its own cached strings and memtable projections.
- Open design question 1, the declaration: the SharedWorker is schema-free (`protocol.ts:9-28`) and cannot receive functions. The projection must be a serialisable declaration (key prefix, sort-key path, text path, normaliser), sent in `watch` (H9) and given at open in every tab. Runs written before a projection existed simply have no `p/<name>/` block; the scan reports them so collections can fall back to a decode scan for those runs [I].
- Open design question 2, deletes and sort-key changes (the main risk): a delete carries only the row key, so kv cannot compute the derived key (it needs `sortKey`) without reading the previous value. Two options [I]: (a) at ingest, look up the previous version of each overwritten or deleted row (one point get per such row, in the SharedWorker, off the ack path) and emit a tombstone for the old derived key; or (b) accept stale derived records, rely on validation by `get` to drop them (a deleted row returns nothing; a row whose `sortKey` changed fails the equality check), and let a bottom-level compaction clean them up. Option (b) is the Validation strategy of Luo and Carey (2.4), costs nothing at ingest, and leaves garbage that grows with churn; option (a) is exact. Start with (b) and a documented rule that `sortKey` is immutable, then add (a) if churn makes the garbage matter.
- Risks: (1) the per-run scan reads a run's contiguous record block through existing SST decode; measured in E2b (section 6): about 250-280 ns per record through `SstReader.cursor`, and a one-time build of about 0.7 s at 1M rows (about 650 ns per record, key and value copied out, plus one decode to a string per run), paid per tab and per new run, so build lazily per run or off the main thread; (2) the scan blocks a tab's main thread for roughly 30-40 ms per million rows [I, section 6]; (3) at several million rows, or with long text fields, scan cost grows linearly, and design B becomes the scale-up path; (4) a common word with very many stale versions could do many validation gets (bounded by compaction dropping shadowed records at the bottom level, `docs/design.md:479-480`).

### 3.2 B: sorted-token dictionary and postings per run (scale-up of A)

Same hooks as A but the section is a front-coded sorted word list plus postings of row ordinals, built at ingest and rebuilt at merge (Lucene merges postings; FTS5 merges b-trees; 2.1, 2.2). Word-prefix queries are a binary search on the dictionary then a postings union, so no prefix keys are written. Newest-first paging needs a sort key per posting or per ordinal. Put cost zero, query near term-index speed, but more code (tokenizer, postings encode/merge in Rust). Choose only if A's scan misses a latency budget on the target dataset.

### 3.3 C: Bloom summaries (not recommended alone)

Built cheaply at H5 and merged at H6. It prunes only runs or blocks without the term. SST data blocks are key-ordered by UUID, so common words appear in every block and the filter prunes nothing (ClickHouse's own caveat, 2.5). It helps rare-word and needle queries and short-circuits whole runs. Use it as an add-on to A for L2 runs when needle queries dominate, and only if E3 shows a skip rate. Using time-ordered ids (ULID-like) would restore block correlation with `newest` [I].

### 3.4 D: one search-document key per row (recommended fallback)

`Table` writes a second key `s/<table>/<newest>/<id>` whose value is the normalised text, in the same `db.update` as the row (H1). The cost is +1 op per put (20.2 -> 5.2 ops) instead of +16, and removal on update or delete is one key, not N. Queries are one range scan in key order, so results come out newest first and `limit` can stop early; common words return quickly, rare words scan everything (measured in E1: about 540 ns per key through the kv merge at 1M rows, so about 1 s for a rare or absent word; at 100k rows 57-73 ms). Consistency is exact: it is an ordinary key in the same batch, shadowing and tombstones handled by the merge. Prefix, substring, and multi-word all work. No engine change, no SST format change, and it can be the baseline that A must beat. Downside: it still writes a second copy of the text through WAL and every compaction level, and ties `newest` into the key. If the `newest` field changes, the key moves (an update does delete plus put, as `update` already diffs keys, `table.ts:217-224`).

### 3.5 E: deferred indexing (not recommended as primary)

A background job in the SharedWorker (or any tab) reads rows above `indexedThrough` and writes ordinary index keys, coalescing repeated rewrites of the same row. This is DELI / Diff-Index async-simple style (2.4). The ack path pays nothing, but total write amplification stays (the keys still go through WAL batch, flush, and compaction), search needs the union of index and a scan of `seq > indexedThrough`, and it adds a second watermark to the consistency model (compare `ingestedThrough`, `docs/design.md:34`). It moves the cost rather than removing it.

### 3.6 Not worth it here

F (suffix array / FM-index): substring in O(p) but memory-heavy for per-tab-resident runs (`docs/design.md:569`) and complex to merge at compaction. Elasticsearch-style refresh lag (2.1) breaks the rule that an acked put is visible to the next read (`architecture/00-grounding.md:15-17`).

### 3.7 Which packages each solution touches

Packages in this repo: `@opfs-lsm/kv` (`packages/kv`: TypeScript host plus the Rust/wasm engine in `crates/engine-core`), `@opfs-lsm/collections` (`packages/collections`), and the consumer `examples/todo` (the only user of the term index, `examples/todo/model.ts:38-57,145-172`). [I] for the "what changes" column, from the hook points above; no variant is implemented yet.

| # | Solution | `@opfs-lsm/kv` (TS host) | kv Rust/wasm engine (`crates/`) | `@opfs-lsm/collections` | `examples/todo` |
|---|---|---|---|---|---|
| 0 | Today: multi-entry, all prefixes | no | no | yes, already (`multiEntry`, `table.ts:28,100`) | yes, builds `terms` and queries `byTermNewest` |
| 0b | Words only + range scan of term keys | no | no | yes: term generation moves in or stays in the app; a multi-term range merge in `page` | yes: fewer terms, prefix queries use the merge |
| A | Projections: derived records written at ingest | yes: projection declaration (in `watch` and at open), derivation in the ingest fold (H4), a memtable projection cache, a per-run scan API, **no SST format change** | no (derived records are ordinary entries; the encoder and merge are untouched) | yes: searchable-field declaration, `Table.search`, put path stops writing term keys | yes: drops `terms` and `byTermNewest`, calls `search` |
| B | Sorted token dictionary and postings per run | yes: same as A plus tokenizer and postings sections | yes: postings encode and merge | yes: same as A | yes: same as A |
| C | Per-run or per-block n-gram/token Bloom summary | yes: SST v2 section and a pruning read path | yes: filter build at encode and merge | yes: verify pass on survivors | maybe: only if it consumes the new search |
| D | One search-document key per row (fallback) | **no** (uses `db.update` and `db.range` as they are) | **no** | yes only: key helper in `codec.ts`, put, update and delete maintain the key, `Table.search` scan, searchable-field declaration | yes: drops `terms` and `byTermNewest`, calls `search`; `model.test.ts` fake updated |
| E | Deferred indexing from a background pass | yes: host job and a `seq` watermark | no | yes: index keys written by the job, search unions index and unindexed tail | yes: as 0 |
| F | Suffix array / FM-index per run | yes: new section and read path | yes: build and merge | yes: search API | maybe |

Reading it: only D (and 0b) leave `@opfs-lsm/kv` untouched. A (as projections), E and the remaining variants need a kv change, but A needs no SST format change and no Rust encoder or merge change, because its derived records are ordinary entries. B, C and F still need new SST sections and the Rust encoder, which is the main difference in effort.

### 3.8 Generic kv features needed to build A at the collections level

Goal: keep search logic (what is searchable, matching, paging, validation) in `@opfs-lsm/collections`, and give `@opfs-lsm/kv` only generic mechanisms with no mention of text, tables or search. No SST format change in this variant. [I] throughout: this is a design inference from the hook points in section 3, not verified against the kv code, and effort is not estimated.

1. **Projections derived at ingest (the core feature).** The caller declares "for keys with prefix P, derive `p/<name>/<sortKey>/<rowKey> -> value`, where `sortKey` and `value` come from named paths of the row value, with an optional normaliser such as lowercase". During the ingest fold (H4) kv writes these as ordinary records in the same run, so the existing SST encoder and compaction merge handle them unchanged. It is generic because any derived ordered view (a sorted copy of a field, a min/max source, a Bloom input) uses the same mechanism. The declaration must be data, not a function, because the SharedWorker is schema-free and cannot receive functions (`protocol.ts:9-28`); it travels in the `watch` message (H9) and every tab also needs it at open (feature 2). Needs: a derivation step in the fold, JSON path extraction in the host, and the declaration plumbing. Deletes and sort-key changes: see 3.1, open question 2.
2. **Projections also on the memtable, so tail and runs are read through one scan.** The memtable keeps the projected value on each entry, computed with the same declaration. The default is lazy: compute on the first scan that needs it and cache it on the entry, so a put pays nothing and a search pays one extraction per tail row once. An eager variant (extract at put) would charge every tab for every write it observes, because each tab builds its own memtable from the WAL and broadcast messages [I]. Shadowing is automatic, since the projection lives on the entry keyed by row key and an overwrite or delete replaces it. The ingest fold can reuse the cached projections instead of extracting again. The tail is capped at about 4 MiB before ingest triggers (`docs/design.md:418-421`), so the lazy cost is bounded. Needs: the declaration known in every tab at open, and a field on the memtable entry (`docs/design.md:107-121`).
3. **One scan API over projections, inside a view.** Something like `view.scanProjection(name)` that yields candidates from the memtable and then each run, newest to oldest, as `(rowKey, sequence, projected value)`. For a run it reads the run's contiguous `p/<name>/` record block directly instead of going through the k-way merge, and it marks runs without that block so collections can fall back to a decode scan for them. Reading through a view pins the run set (H8), so a compaction mid-search cannot change the answer, and an acked put is visible to the next search because the tail is exactly what every tab already merges over runs (`docs/design.md:371-383`). Hits come back as row keys; collections validates them with `db.get`, which already exists and handles shadowed and deleted rows (Luo and Carey "Validation", 2.4). Needs: a single-run range read that skips the merge, which kv's run reader likely already has internally [I, unchecked].
4. **Decode the block to a string once per run; no new primitive.** E2 (section 6) used Node's `Buffer.indexOf`, which browsers lack. Measured in V8 on 26.6 MiB in 104 runs (scratch script, not in the repo): decoding all columns to strings once takes 3.2 ms, and `String.indexOf` on them takes 32.6 ms for an absent word against 29.8 ms for `Buffer.indexOf`; 1.5 ms against 1.4 ms for a rare prefix. So scan the cached string per run. Cost: about one byte per character of memory for ASCII text (about 27 MiB per tab at 1M rows) and double for non-ASCII, so decode lazily and evict least-recently-used runs. Make each record self-describing in the string (a separator character, the `sortKey`, then the text) so a hit maps to its record with `lastIndexOf(separator, at)`, with no byte-offset array whose units would differ from string positions once text is non-ASCII. Only V8 was measured; Safari and Firefox have their own string search.

What stays in collections: the searchable-field declaration (turned into the projection declaration), ordering candidates by `sortKey`, the match, validation by `get`, and cursor paging.

Effort split [I]: features 1 and 2 are the real kv work (derivation in the fold, a memtable field, the `watch` field, the declaration plumbing); feature 3 is a small read-side addition; feature 4 is collections-side code. The Rust encoder and merge are untouched. If that is still too large, D (3.4) ships collections-only first.

---

## 4. Recommendation

**Primary: A, projections: kv derives `p/<name>/<sortKey>/<rowKey> -> text` records at ingest as ordinary records, searched per run through one scan API, with the memtable projected lazily and candidates validated by point gets.** It has zero per-put overhead on the ack path, keeps exact ack visibility (the tail is projected and scanned), page order (newest first) and view-pin consistency (the derived records live in the run), and needs **no SST format change and no Rust encoder or merge change**, which removes the largest cost of the earlier column design. It is KISS-compatible with `AGENTS.md:3-12`. It is D with the second key written at ingest instead of at put, plus a per-run scan that skips the cross-run merge, which is where D loses (E1). E2b measured the per-run read: an absent-word search at 1M rows takes about 35 ms after a one-time build of about 0.7 s per tab. Its two risks are that build cost (paid lazily per run) and deletes and sort-key changes (3.1, open question 2). Keep B as its scale-up if the scan is too slow at the target size.

**Fallback: D, one search-document key per row, scanned by range.** It needs no engine change, costs +1 op per put instead of +16, is exact by construction, and gives a ready baseline. Its limits are linear scan time through the kv merge (measured in E1: about 540 ns per key, so about 60-70 ms per 100k rows and about 1 s per million for a rare or absent word) and a second copy of the text through the LSM.

Cheapest immediate step if the team wants relief before any of this: `TERMS=words` (variant 0b) cuts ops per row from 20.2 to 7.0 and 100k-row run size from 91.5 to 29.1 MiB (run), but prefix queries then need a multi-term range merge.

---

## 5. Experiment plan (uses existing scripts)

Gate for every variant: p50 and p99 query time at 100k and 1M rows; put cost; run MiB; tab heap.

- **E0 put-cost baseline (missing today).** Add a timed `putMany` loop to `bench-search.ts`'s harness path (`openHarnessDb`, MemoryFs) for variants: no term index, words only, all prefixes, D (extra key). Record ops per row, ms per 1,000-row batch, WAL bytes, and flush size. Then confirm in real Chrome with the `verify-opfs-lsm` `collections-bench` recipe (`.agents/skills/verify-opfs-lsm/features/collections-bench.md`) because MemoryFs does not prove IDB cost (`.agents/skills/verify-opfs-lsm/features/README.md:3`). Pass: a number for the put overhead the user is complaining about.
- **E1 fallback D.** In `bench-search.ts`, lay out the same `todos` layout (`cut`, L0/L1/L2) plus a `s/todos/<newest>/<id> -> lowercase title` key written directly through the recording stub. Time: range scan with word-prefix match and `limit` 50 for no match, needle, common word, one-letter prefix, at TODOS=100,000 and 1,000,000. Compare to the 5-270 µs term index and to the 746 ms substring walk. Pass: p50 under about 100 ms at 1M for the no-match case and under 5 ms for common words [I thresholds, set by the product].
- **E2 primary A, upper bound.** In the same script, after `cut`, concatenate normalised titles per run into one buffer (lowercase, newline separated, with an 8-byte `newest` per record) for L0, L1, L2. Time: full-run scan (word-prefix regex, `indexOf`) over all runs, top-50 by `newest`, then `kv.get` validation of the winners. Use the LZ4 decode cost of the column too (`decode wasm lz4` row of `bench-index-runs`). Add titles of realistic length (not a 10-word vocabulary). Pass: total query p50 at 1M under the budget with the column being under 5% of run bytes.
- **E3 summaries (C). Discarded.** Per-block token Bloom summaries need a new SST section, and the chosen design (A as projections, 3.1) deliberately leaves the SST format unchanged. C also prunes little here: SST data blocks are key-ordered by UUID, so common words appear in every block (3.3). Not run.
- **E4 tail projection cost.** Fill the memtable to the 4 MiB ingest trigger (`docs/design.md:421`) and measure the extraction cost per row (JSON parse plus lowercase) for the eager variant (at put) and the lazy variant (first search, then cached), plus the scan of the cached projections. Pass: eager adds well under the current put cost per row; lazy first search under a few ms at the trigger size. **Measured, see section 6 (E4):** lazy first search at the default ingest trigger is about 2.5 ms, eager costs about 0.3 us per put; both pass.
- **E2b per-run read of derived records.** The part of A that E2 did not cover. In `bench-search-doc.ts`, read one L2 run's `p/todos/` record block without the merge (the run's own cursor or `decodeSst`), time the iteration per record, then the one-time decode of that block into a self-describing string, then `String.indexOf` over all runs at 100k and 1M rows. Pass: the decode-once cost per run is a few ms, and the total absent-word search at 1M rows stays near the 36 ms of E2 rather than the 540 ns per key merge floor. **Measured, see section 6:** the query passes (35 ms); the build does not meet the "few ms per run" target, at about 23 ms per run (about 0.7 s over the roughly 30 runs that hold the derived block), so it must be lazy or off the main thread.
- **E5 ingest derivation cost.** Use `packages/kv/scripts/compaction-cost.ts` and the ingest path to measure the added time when each row's JSON is parsed in the host to derive its record (flush of a 4.3 MB run costs 51.7 ms today, `docs/design.md:268-269`). Pass: ingest time at most about 2x today. Compaction is unchanged because the derived records are ordinary. **Measured, see section 6 (E5):** about 13.2 us per row against about 8.7 for a rows-only ingest, 1.5x, so the pass condition holds.
- **E6 multi-tab.** After E2 is prototyped, prove in Chrome that a second tab sees an acked put in search at once (tail scan) and the same results after ingest, using the `two-tab` recipe (`docs/verification.md`, `.agents/skills/verify-opfs-lsm/features/two-tab.md`); and run `verify-kv` for view-pin and compaction merge properties.

Decision rule: ship D if E1 meets the budget (it is the smallest change); do A if the put overhead from D's second key or its scan time still misses it; do B only if E2 misses at the target row count.

---

## 6. Results so far (E0, E1, E2, E2b, E4, E5)

All numbers *(run)*: single runs on 2026-11-06, Node 24, MemoryFs, synthetic titles (a third of words random). MemoryFs does not prove IndexedDB cost, so Chrome confirmation is still open. Scripts: `packages/collections/scripts/bench-put.ts`, `bench-search-doc.ts`, `bench-search-column.ts`.

### E0 put cost (20k rows, 250-row batches)

| layout | kv ops/row | bytes/row | rows/s |
|---|---|---|---|
| no term index | 2.0 | 265 | 51k |
| words only | 5.2 | 539 | 21.5k |
| all prefixes (today) | 18.4 | 1,612 | 5.2k |
| D (one search-document key) | 3.0 | 340 | 40.5k |

The all-prefix layout exceeds the kv limit of 10,000 ops per batch at 1,000 rows, so callers must chunk at about 500 rows or fewer. Single-row puts are about 0.2 ms in every layout, so the overhead shows in bulk writes.

### E1 fallback D, search by range scan (rows laid out across L0/L1/LZ4 L2 runs)

| rows | rare or absent word | common word, 1-letter prefix |
|---|---|---|
| 100k | 57-73 ms | 0.1-0.2 ms |
| 1M | about 1 s | about 0.15 ms |

This corrects the 40-90 ns per key estimate in 3.4 and section 4: the measured cost is about 540 ns per key at 1M rows. A merge-cursor-only floor (no matching) costs 578 ms at 1M, so the limit is in the kv merge of about 100 runs, not in the match. Dropping `TextDecoder` and the regex for a byte-level match cut the scan from 1,219 ms to 693 ms; paging through `rangeFollow` did not help further and hurt common words at large page sizes.

### E2 packed-column upper bound for A (per-run column scan)

| 1M rows | column scan (A) | search-document scan (D) |
|---|---|---|
| absent word | 36 ms | about 1,040 ms |
| match only in the oldest row | 36 ms | about 950 ms |
| common word, full page | 0.06 ms | about 0.16 ms |
| rare prefix, full page | 2.6 ms | not measured |

This E2 measured a **pre-built packed buffer** per run, which is an upper bound for the projections variant of A (3.1): there, each run's derived records must first be read from the existing SST format and decoded into a string, which E2b measures. Column size at 1M rows: 39.6 MiB raw (text 27.4 MiB) against 202 MiB of runs, about 20% of run bytes, above the 5% target in E2's pass condition. Not included: LZ4 decode of the column, validation gets, tail scan, build cost at flush and compaction. It used Node's `Buffer.indexOf`, which browsers lack (see 3.8, feature 4), so the 36 ms figure needs a browser-side check.

Reading it against the decision rule (section 5): D is enough to about 100k rows; A is about 30x faster than D at 1M rows and adds nothing to puts.

### E2b per-run read of derived records (design A as projections, 3.1)

Script: `packages/collections/scripts/bench-search-projection.ts`. Same layout as E1 (derived `s/todos/<newest>/<id> -> title` records as ordinary SST records in L0, L1 and LZ4 L2 runs), run files already in memory. For each run: `SstReader.cursor` over the derived key range only (no merge), values copied into one buffer, one `TextDecoder` decode to a string, a `starts` offsets array and a `newest` array, then `String.indexOf` per run and top-50 by `newest`. LZ4 block decode is included; OPFS reads, validation gets and the write side are not.

| 1M rows | result |
|---|---|
| cursor over the derived block, all runs | 266-302 ms (about 250-280 ns per record, key and value copied out) |
| full one-time build (cursor, buffer, one decode) | about 700 ms (about 650 ns per record); 27.3 MiB of strings |
| search, absent word | 34.8 ms |
| search, match only in the oldest row | 14 ms |
| search, common word | 0.1 ms |
| search, rare prefix | 1.3 ms |

At 100k rows: build 33 ms, absent-word search 3.2 ms.

Findings:
- Reading through the existing SST format reproduces the E2 query time (36 ms), not the 540 ns per key merge floor of E1. The per-run read without the merge is what makes A as projections viable.
- The cost moved to a one-time build per tab and per run: about 0.7 s at 1M rows if built all at once. Only new runs need rebuilding after an ingest or compaction, so build lazily per run or off the main thread.
- Only about 30 of 101 runs hold the derived block, because runs are cut across all key types and the derived records are one contiguous key range; the scan skips the other runs.
- A first version of the build took about 1.1 s; most of the extra over the cursor alone was a per-record `BigInt` conversion of the sort key, replaced by plain byte arithmetic.
- Memory: about 27 MiB of strings per tab at 1M rows (one byte per character for ASCII text, double for non-ASCII), as in 3.8 feature 4.

Caveats: single run on Node (V8) with MemoryFs and synthetic titles; the row key for validation is not retained per record, so a hit has to be re-read from its run; the deletes and sort-key changes issue (3.1, open question 2) is not covered; the ingest derivation cost is in E5 below.

### E5 ingest derivation cost (design A as projections, 3.1)

Script: `packages/collections/scripts/bench-ingest.ts`. 100k rows written in 250-row batches, `db.ingest()` called every 10k rows (11 ingests) and timed alone; MemoryFs, Node, synthetic titles; two runs.

| layout | ingest time | per row |
|---|---|---|
| rows only (row + `byNewest`) | 855-877 ms | 8.5-8.8 us |
| D (one derived record per row) | 1,172-1,190 ms | 11.7-11.9 us |
| all prefixes (today) | 5,034-5,284 ms | 50.3-52.8 us |
| extraction A adds in the host (decode, `JSON.parse`, read two paths, lowercase, build derived key and value) | | 1.3-1.5 us |

Estimate for A: rows-only ingest (8.5-8.8 us) + encode of the one extra record per row (the D minus rows-only gap, 2.9-3.4 us) + extraction (1.3-1.5 us) = about 13.2 us per row in both runs, 1.5x a rows-only ingest and about 4x less than today's all-prefix ingest. This meets the E5 pass condition (at most about 2x today's ingest).

Findings:
- The extra record's encode costs about twice the extraction, so parsing JSON in the host is not the main cost.
- The ingest runs in the SharedWorker, off the ack path; puts pay nothing extra.

Caveats: A's number is an estimate, the sum of a measured extra-record cost (from the D layout) and a measured extraction cost, not a run of A itself, because kv's fold was not modified; compaction is not measured (derived records are ordinary entries, so no extra parsing, but about 10% more record bytes to rewrite); MemoryFs does not include OPFS write cost; the deletes and sort-key changes options of 3.1 (a point get per overwritten or deleted row for option (a)) are not covered.

### E4 tail projection cost (memtable, design A as projections, 3.1 and 3.8 feature 2)

Script: `packages/collections/scripts/bench-tail.ts`. Todo rows (row + `byNewest`) are put without any ingest, so the whole tail is memtable (checked by listing `l0/`: empty). The tail was searched through `db.range` over the table's primary keys with an absent needle, so it scans every row. MemoryFs, Node, median of 7. The default ingest trigger is 1 MiB of op bytes (`ingest-policy.ts:23-25`), which held about 4,000 of these rows before an ingest fired; the second column raises the trigger to 4 MiB (the figure `docs/design.md` gives) to hold 16,000.

| search over the tail | 4,000 rows (default 1 MiB trigger) | 16,000 rows (4 MiB trigger) |
|---|---|---|
| a. iterate the tail only, no matching | 1.4 ms | 4.9 ms |
| b. raw-bytes substring search of the JSON value, no parse | 1.9 ms | 6.8 ms |
| c. lazy first search: parse, lowercase, match, cache | 2.5 ms | 10.6 ms |
| d. cached: one `String.indexOf` over the cached projections | 0.10 ms | 0.43 ms |
| d2. cached: per-entry strings, `indexOf` each | 0.16 ms | 0.62 ms |
| e. eager extraction per put (decode, parse, lowercase) | 0.30 us/row | 0.34 us/row |

Findings:
- The lazy variant costs about 2.5 ms for the first search at the default trigger and about 10.6 ms at a 4 MiB trigger; after that a cached search is 0.1-0.4 ms. This meets the E4 pass condition (lazy first search under a few ms at the trigger size) at the default trigger, and exceeds it at 4 MiB.
- Eager extraction adds about 0.3 us per put, in every tab that observes the write (each tab builds its own memtable). Against about 10 us per row for a rows-only put (E0), that is about 3%.
- Iterating the tail alone is 55-60% of the lazy first-search cost, so parsing only adds about 1 ms per 4,000 rows. A raw-bytes search without parsing (b) saves little over the lazy parse (c) and cannot do word-prefix matching on JSON, so the lazy cached projection is the better choice.
- The doc's 4 MiB trigger figure for the ingest policy does not match the code (1 MiB); the tail the search scans is therefore smaller than assumed in 3.1.

Caveats: the lazy cache is simulated in the bench, not on real memtable entries; the cached search joins the strings of an already-built cache and does not include the cost of invalidating on overwrite or delete; MemoryFs, Node, synthetic titles; a write-heavy tab would re-extract after each overwrite.
