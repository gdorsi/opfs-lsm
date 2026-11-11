# Landing projections (A) and making a miss fast at 1M rows

Question: how can we land A (kv "projections"), and how do we make a search for a word that matches nothing fast at 1M rows (D takes about 1 s)? Follows `docs/research/multi-entry-index-alternatives.md` (cited below as MEIA), whose Decision section parked A.

Conventions as in MEIA. **[R]** repo fact, cited `file:line`. **[E]** external fact, cited with the owner's URL. **[I]** my inference. **(run)** a number I measured on 2026-11-06 in this checkout (Node 24, in-memory runs, 18-core laptop). Single runs unless a range is given.

What I did not verify is listed in section 8. Short version: no Chrome, no OPFS, no IndexedDB, synthetic row layout, no prototype of the kv derivation itself.

---

## 0. Answer in ten lines

1. A is two separable ideas: (i) a per-run read of ordinary records without the k-way merge, and (ii) kv writing those records at ingest. The 35 ms came from (i) alone. The records E2b scanned were D's own `s/<table>/<sortKey>/<id>` keys, not records written by a kv derivation [R: `packages/collections/scripts/bench-search-projection.ts:2-6`]. So (i) can land on D today with no declaration, no reserved prefix, no backfill and no orphan problem.
2. Land order: **PR1** kv `view.scanRuns` (read-only, generic). **PR2** collections `Table.search` through it with per-run strings, dedupe and re-match. **PR3 (optional, only if bulk put cost matters)** derive-at-ingest, with collections writing explicit tombstones and kv deriving only puts.
3. Of the five parking problems, PR1 and PR2 hit none except number 4 (dedupe and re-match), which is collections-only. Problems 1, 2, 3 and 5 only exist for ingest-time derivation (PR3).
4. For PR3 I would pick explicit tombstones from collections (alternative a), with read-repair (d) as the safety net. Old-value lookup at ingest (b) needs every run's bytes in the SharedWorker. A compaction hook (c) cannot see the rows, because rows and derived records sit under different prefixes.
5. Derive-at-ingest buys little: +1 op per put is 3.0 vs 2.0 kv ops per row and 40.5k vs 51k rows/s in bulk (MEIA E0, lines 284-293). Single puts are about 0.2 ms either way.
6. Misses: with per-run strings, an absent word costs **39 ms** at 1M rows (run), over the 50 ms target only by margin. Merged D scan is **316 ms** warm in this layout (run).
7. A **vocabulary of whole-word keys** `w/<table>/<word>` makes a single-word miss **about 7 us** (run) through the existing kv merge. Prefixes need no stored keys, because key order gives prefix existence by one seek.
8. The premise "distinct words per ingest are far fewer than rows" is false for small ingests: 0.86 distinct words per row per 4,000-row ingest on real English, 2.1 on Zipf (run). Writing the vocabulary from every ingest costs about as much as D's one key per row. Write it once per word instead (about 0.055 to 0.66 keys per row over 1M rows, run), or derive it in memory from the per-run strings (266 ms once per tab, run, no writes).
9. The vocabulary speeds up single-token misses and AND queries where one token is absent. It does nothing for AND queries whose words all exist but never together, and nothing for rare hits.
10. Recommendation: PR1 then PR2 now (primary). Add the in-memory vocabulary in PR2 or a PR2b. Persisted vocabulary is the fallback if cold-tab misses matter. Abandon ingest-time derivation unless bulk put cost shows up in the Chrome bench.

---

## 1. Repo facts I re-checked

### 1.1 The five parking problems, against the code

1. **Deletes carry no value.** [R] `foldRecords` keeps the last op per key in a map and emits `{kind:"del", key, seq}` with no value (`packages/kv/src/store/fold.ts:11-24`). `ingestAll` calls it on the WAL records and nothing else (`host/ingest.ts:41`). Compaction takes the newest entry per key and drops tombstones only when the merge is `bottom` (`crates/engine-core/src/compact.rs:17-33`, TS fallback `store/engine.ts:127-158`). So an orphan `put` of a derived key is never dropped unless something writes a tombstone for exactly that key. Confirmed.
2. **The fold has no memtable and no readers.** [R] `ingestAll(wal, fs, through)` reads `wal.listUningested()`, folds, `publishL0`, `publishGeneration`, `advanceIngested` (`host/ingest.ts:25-60`). `EngineHost` keeps no `SstReader`s; `mergeNextStep` reads whole run files with `fs.read(path, 0, Infinity)` when it needs them (`host/compact.ts:41-46`). Confirmed.
3. **The declaration cannot ride `watch`.** [R] Two SharedWorkers can serve one database; an exclusive section is a chain in the host plus a Web Lock across hosts (`host/engine-host.ts:50-59,201-214`). `watch` carries only `name`, `maxWalBytes`, `trace` (`host/protocol.ts:16-22`). The IndexedDB meta store is already a key-value store (`idb/wal.ts:7,109-113`), so a new meta key needs no schema bump [I: `IDB_VERSION = 1` at `idb/wal.ts:14`, `createObjectStore` only if missing]. Confirmed.
4. **Per-run scans see stale text.** [R] A scan that skips the merge returns every version in every run. `Table.search` validates only by `snap.get(pk)` and does not re-match the row (`packages/collections/src/table.ts:520-523`). Confirmed for the current code; it is a collections change, not a kv one.
5. **No formal property for derived records.** [R] The suite is NoLostAcks, WalOverSst, ViewPin, CompactPreserve (`docs/verification.md:90-97`). `parse-ingest-order.ts` parses the order of `publishL0`, `publishGeneration`, `advanceIngested` out of `ingest.ts` by regex (`packages/kv/formal/ingest-visibility/parse-ingest-order.ts:7-22`). Derivation inside `ingestAll` must not move those three calls, or the model has to follow. Confirmed.

### 1.2 Facts that shape the plan

- [R] Runs are grouped into scan sources: each L0 run alone, one `RunLevel` per deeper level (`store/read.ts:119-199`). My 1M-row layout has 100 runs and 5 sources (run).
- [R] Each `SstReader` has a whole-key Bloom filter and `get` checks it first (`store/sst.ts:606-612,641-655`). A point get for a key that is absent costs about 0.7 us over the 5 sources (run, section 5).
- [R] `SstReader.cursor(bounds)` reads one run alone (`store/sst.ts:657-700`), so a per-run scan needs no new reader code, only an API that exposes it.
- [R] `ViewSnapshot` exposes `walHead`, `generation`, `get`, `range` and nothing else (`view.ts:13-20`). Collections cannot see the memtable tail or individual runs today.
- [R] `Db.update(keys, body)` reads the old values and writes in one IndexedDB transaction (`db.ts:625-640`). `collectBatch` is the single place where `tx.put` and `tx.delete` become ops (`db.ts:339-360`).
- [R] `Table.putMany`, `update`, `delete`, `clear` already compute the old search key from the old row and delete it when the sort key changes or the row goes (`table.ts:245-264,272-303,400-413,362-398`). D is exact today. No `reindex` or backfill exists (grep of `packages/collections/src` and `examples/todo`: none), so rows written before `search` was declared are silently unsearchable.
- [R] `db.changes` events carry `{kind, writerId, seq}` only (`changes.ts:3-9`).
- [R] The ingest trigger is 1 MiB of op bytes (`ingest-policy.ts:23-25`, per MEIA line 41).

---

## 2. Landing A

### 2.1 Alternatives for the orphan and delete problem (problem 1)

All of these concern only PR3, where kv derives records.

**(a) Explicit tombstones from collections; kv derives only puts.** Collections already reads the old row inside `db.update` (`table.ts:245-264,274-302,402-411`) and can compute the old derived key. It writes `tx.delete(oldDerivedKey)` when the row is deleted or its sort key changes, as D does now. Ordering, checked on the real `foldRecords` and `Memtable` (run, `scratchpad/fold.mts`):

| Scenario (ops in WAL order) | Fold result |
|---|---|
| put row+D, then del row+D, then put row+D (same fold) | D is `put@3` |
| put row+D, then del row+D | D is `del@2` |
| put row+D1, then put row+D2 and del D1 | D1 `del@2`, D2 `put@2` |
| one batch: del D then put D | `put` (last op wins) |
| one batch: put D then del D | `del` |
| memtable: put, del, put of D | `put@3` |

Last op wins in WAL order inside one fold and in the memtable, so an explicit tombstone and a re-put of one row cannot resurrect or hide the wrong version, provided that **derived puts are emitted in op order with the row's op** (or computed from the folded final state, see below). Deriving from the folded map after `foldRecords` is better [I]: a row overwritten three times in one fold is derived once, and a final-state `del` derives nothing, so the explicit tombstone stands. Cost: zero for inserts and same-sort-key updates, one op for deletes and sort-key changes, the same as D today. Readers before ingest: the memtable holds the row ops and explicit tombstones as ordinary `MemRow`s (`store/memtable.ts:6-11`); the tail scan reads rows, so tombstones under the derived prefix are irrelevant to it. Raw `db.delete(rowKey)` by non-collections code leaves an orphan; (d) covers that.
Problem it adds: collections writes into the derived prefix, so "reserved from user writes" must allow deletes. Cleaner is a kv call `tx.unproject(decl, rowKey, oldValue)` that pushes the `del` op itself, so the prefix check lives in `collectBatch` (`db.ts:339-360`) and `derive()` has one implementation shared by fold and collections.

**(b) Old-value lookup at ingest.** The host would call `latestSstEntry` per overwritten or deleted row. [R] It has no readers, and `SstReader` takes a whole file buffer (`store/sst.ts:606-632`). Reading every run to answer a handful of lookups means loading about 200 MiB at 1M rows (the size of my layout, run) into the SharedWorker, or reading footer, Bloom and index per run, which `SstReader` cannot do today. A row overwritten in the same fold also needs the earlier WAL record. [I] Heavy for little gain once (a) exists. Reject.

**(c) Compaction hook or validation pass.** [R] A merge's inputs are the runs that overlap by key range (`store/levels.ts:77-113`; `host/compact.ts:41-46`), and it works on a `BTreeMap` of just those inputs (`compact.rs:17-22`). Derived records (`p/...`) and rows (`t/...`) sit under different prefixes, so a merge of derived runs usually does not contain the rows it would validate against. [I] A hook would need cross-run lookups from inside wasm, plus a second implementation in the TS fallback (`engine.ts:135-157`). Reject.

**(d) Accept orphans; validate by `get`; bound the garbage.** Always needed as the safety net because scans without a merge return stale text. Garbage is one derived record per deleted row or sort-key change (about 70 B of key plus the title). It is unbounded over time but proportional to churn. Cleanup rules [I]: (1) **read-repair**: when validation of a candidate finds the row gone or its sort key different, collections issues `db.delete(derivedKey)` (the key is in the scan result), which compaction then drops; (2) `Table.clear` also deletes its derived range, chunked like the rows. Orphans that never match a query stay, and cost only bytes.

**(e) Collections-only, derivation off the put path.** Writing search keys lazily from `db.changes`: [R] events carry a seq but no ops, and `ViewSnapshot` exposes no tail (`changes.ts:3-9`, `view.ts:13-20`), so collections cannot tell which rows are not yet indexed, and cannot keep ack visibility without scanning every row. Total write bytes stay the same, so it moves the cost (MEIA 3.5). A tail API would be kv work again. Reject.

**(f) Extra: key the derived record by row key.** `p/<table>/<rowKey> -> <sortKey> <text>`. kv can then derive the tombstone from a bare `del` op (the derived key needs only the row key), so problems 1 and the orphan story vanish and an overwrite shadows the old record in compaction. MEIA already noted the cost: no newest-first early exit. I measured it (section 5.5): common words and one-letter prefixes go from 0.03-0.05 ms to 60-69 ms at 1M rows; absent words 44 ms instead of 39. Viable only for PR3 if the tombstone logic is judged worse than that.

**Choice for PR3: (a) plus (d), with sort-key-ordered keys.** (f) is the fallback if tombstone writes by collections prove fragile.

### 2.2 PR order

Each PR lists the checks from `docs/verification.md:14-26` that its diff triggers.

**PR1. kv: `ViewSnapshot.scanRuns(range)`** [I design].
Yields, per source (memtable pin first, then each L0 run, then each level), an async iterator of `{key, value | undefined(tombstone), seq?}` for the range, **unmerged**, newest source first, with a stable run identity so collections can cache a decoded string per run path. No format change, no write path change.
- Files: `view.ts`, `db.ts` (`view()` passes the same `rows` and `levels`), `store/read.ts` (expose per-`SstReader` cursors; `RunLevel.cursor` merges a level's runs sequentially, which is fine since runs in a level do not overlap).
- Checks: `view()`/memtable pin row, so `formal:view-pin`; `pnpm test`. No ingest or merge files touched, so no `formal:ingest-visibility` or `compact-preserve`. Add a unit test: scanning every source and merging by newest equals `view.range`.
- Formal property to add (small): **ScanRunsSuperset**, for every key whose current value (via `get`) matches a predicate, the unmerged scan yields at least one record of that key whose newest-source copy is the current value. This is what makes "dedupe then re-match" exact. A model next to `view-pin`, same exhaustive style, over 2 runs, one memtable, cell values {miss, put1, put2, del}.
- Riskiest assumption proved here: the API shape is enough, and `RunLevel` pinned by a view survives a compaction mid-scan (`view.ts:34-47`).

**PR2. collections: `Table.search` reads through `scanRuns`.**
- Per-run cache: decode each run's derived block once to a string (E2b method, `bench-search-projection.ts`), keyed by run path, evicted by LRU; memtable rows scanned on each search (E4: about 2.5 ms lazy first, 0.1 ms cached at 4,000 rows).
- Candidates from all sources are merged by sort key (heap over per-run hit streams), **deduped by row id**, tombstones skipped, then each candidate is read with `snap.get(pk)` and the predicate is **re-matched on the current row's text** (today only `get` is checked, `table.ts:520-523`). Stale versions in older runs can then only cost a `get`, never a wrong row.
- Read-repair of orphans (rule d1).
- Keys stay D's, so existing databases need nothing new.
- Checks: row "Collections put, get, or where": `drive collections-bench`, expected to fail on main with the module-specifier error in `docs/verification.md:128`, so treat only a changed message as new; `pnpm test`. For a performance claim, a Chrome bench at 1M rows is still owed (E6 in MEIA).
- Riskiest assumption proved here: that per-run strings reach about 40 ms absent-word at 1M rows in Chrome on OPFS, and that dedupe/re-match keeps results identical to D's merged scan on a churned dataset (property test: random put/update/delete, compare to D's merged scan).

**PR3 (optional). kv: derive at ingest.** Only if the Chrome bench shows bulk put cost or WAL bytes matter. Sub-steps, each its own PR:
- **PR3a** declaration plumbing: serialisable declaration, persisted in IndexedDB `meta` under key `projections` as `{name: {version, prefix, sortPath, textPath, normaliser}}`, written under the ingest lock; `ingestAll` reads it (inside `exclusive`, `engine-host.ts:100-111`). Tabs with different declarations: the higher `version` wins and replaces the stored one; a tab with a lower version reads it back, uses it, and logs a warning. A tab never writes derived records itself. Without a stored declaration the host derives nothing.
- **PR3b** `derive()` in the fold: derive from the folded map, after `foldRecords` and before `publishL0`; keep the order of `publishL0`, `publishGeneration`, `advanceIngested` untouched. kv needs `encodeTyped`/`encodeOrderFloat64` (currently `packages/collections/src/typed.ts`), so move them into kv and re-export from collections.
- **PR3c** reserved prefix: reject `put` and `delete` under `p/` in `collectBatch` (`db.ts:339-360`) except through `tx.unproject`. Collections drops its own `s/` key.
- **PR3d** backfill: stored per projection `since = ingestedThrough at declaration time`. Data older than `since` has no derived records. A tab-side job (`Table.reindex`) scans rows by prefix and writes derived records through an internal `tx.derive(decl, rowKey, value)` in chunks of 500 rows, then raises `since` to 0 in meta. Until then `search` falls back to the PR2 path over D's keys or a decode scan. This is also the missing backfill for D today.
- Checks: `formal:kv` (all four; ingest changed), `drive two-tab` (declaration visible to a second SharedWorker or tab), `drive collections-bench`, `pnpm test`. For a bulk-put claim also `drive kv-bench` and a collections put bench.
- Formal property: **DerivedConsistent**: after any sequence of put, delete, overwrite and ingest, for every row key, the newest derived record under its current sort key exists iff the row exists; and no ingest step reorders `publishL0`, `publishGeneration`, `advanceIngested`. Model: 1 row, ≤3 ops, sort key in {s1, s2}, with and without the explicit tombstone, expected to fail without it and pass with it.

### 2.3 Why this order

PR1 and PR2 deliver the measured speedup with the smallest blast radius. PR3 carries every problem in the park list and its gain is a 20% bulk put gain and 28% fewer WAL bytes per row (MEIA E0: 340 vs 265 B per row). [I] That does not justify the risk until a real workload shows it.

---

## 3. What `scanRuns` must return so collections can dedupe and re-match

For each source: a stable id (run path, or `"mem"`), its position in newest-first order, and entries `{key, value, kind}` including tombstones. Collections then:
1. builds a string per run (cached by path) and finds hits with `String.indexOf`, mapping a hit to its record by `lastIndexOf(separator)`;
2. emits candidates per run in sort-key order, merges them by sort key across runs;
3. drops tombstone records and a candidate whose key is shadowed by a tombstone in a newer source (cheap, optional: the `get` in step 5 settles it);
4. dedupes by row id (the same id can come from several runs);
5. reads the row with `snap.get(pk)`, and keeps it only if it still exists and its current text matches every token (word-prefix test, `hasWordPrefix`, `table.ts:78-86`);
6. on a failed validation, schedules a `db.delete(derivedKey)` (read-repair).

Soundness [I, ScanRunsSuperset above]: every current row's newest derived record is in the newest source that holds its key, so the union over sources is a superset of the true matches, and validation makes it exact.

---

## 4. Fast misses: what is being measured

Layout (run): 1,000,000 rows, 100 runs (3 L0 raw, L1 raw, L2 LZ4, cut at the 4 MiB target), 5 scan sources, 210.7 MiB. Titles are random 2-6 word windows from real English running prose (Newton's Opticks, the vim help files, `//` comment lines of the Go standard library: 3.0M tokens, 64k distinct words). Per row: primary row, `byNewest` index key, one derived record, plus vocabulary keys (empty values). L1 holds about 5% and L0 about 2% of the rows again as separate rows, as `bench-search-doc.ts` does. No IndexedDB, no fake-indexeddb: runs are encoded with the repo's wasm encoder and read through `SstReader`, `runLevels`, `mergeCursors` from the TypeScript source. Scripts: scratchpad `layout.mts`, `run1.mts`, `run2.mts`, `v1-vocab.mjs`, `fold.mts`.

Differences from MEIA E2b: shorter titles (about 4 words, text 22.6 MiB in strings against 27.3), so the build is 211 ms here against about 700 ms there and the absent-word search 39 ms against 35 ms. I did not reconcile the build difference; the `BigInt` and title length are the visible candidates. Treat both builds as "a few hundred ms".

---

## 5. Results

### 5.1 Baseline D, merged scan (run)

Merged scan of all 1,069,980 `s/` keys with no matching: 735 ms first, 316-322 ms warm (about 300 ns per key). MEIA E1 measured 578 ms for the same floor and 540 ns per key; machine and titles differ. Matching adds to it, so an absent word is 0.4 s or more.

### 5.2 A as is: per-run strings (run)

| 1M rows | median |
|---|---|
| one-time build, all runs (cursor, buffer, one decode); 29 of 100 runs hold the block; 22.6 MiB | 211 ms (206-237) |
| absent word | **39.0 ms** |
| rare word, 3 hits | 10.0 ms |
| common word `the`, full page | 0.045 ms |
| one-letter prefixes `t`, `s`, full page | 0.030, 0.038 ms |

Under the 50 ms target, by about 11 ms. Linear in rows [I]: about 80 ms at 2M.

### 5.3 Persisted vocabulary through the kv merge (run)

Keys `w/<table>/<word>` with empty value, ordinary records; word set per layer as the compacted result would be (L2 55,083 words). A prefix lookup is `mergeCursors` over the 5 sources with `start = w/<table>/<needle>`, `limit 1`:

| Lookup | median |
|---|---|
| absent prefix `qzxv`, `0zz`, typo `mlik` | 7.4, 6.1, 7.6 us |
| present rare word, `t`, `the` | 6.8, 6.7, 6.7 us |
| exact-word point get, absent / present (per-run Bloom path) | 0.72 / 0.63 us |

A miss is one range seek, **about 7 us, independent of rows** (checked at 20k and 1M, 5.7-7.3 us). Prefixes need no stored keys: sorted order makes "any word starts with `mli`" one seek. [R] That relies on the merge seeking per source by key (`RunLevel.cursor`, `store/read.ts:152-175`). Not included: the memtable tail (E4: 0.1-2.5 ms) and tokenising the query.

### 5.4 In-memory vocabulary derived from the per-run strings (run)

Tokenise all 22.6 MiB of run strings into a `Set` and a sorted array: **266 ms** once, 55,920 distinct words; prefix lookup 47 ns. No writes, no consistency questions; stale words of deleted rows only give false positives. The cost is per tab and per new run, the same moment the strings are built (E2b). Cold-tab first search pays build 211 ms plus this 266 ms; a persisted vocabulary does not, which is its only advantage for misses.

### 5.5 Row-keyed projection (alternative f) (run)

Same 1M rows, derived key `p/<table>/<id>`, value `<13 hex sortKey> <text>`:

| 1M rows | sort-key order (5.2) | row-key order |
|---|---|---|
| build | 211 ms, 22.6 MiB | 220 ms, 36.9 MiB |
| absent word | 39.0 ms | 43.6 ms |
| rare word | 10.0 ms | 14.4 ms |
| common word `the` | 0.045 ms | **65.1 ms** (239,719 matches) |
| `t` | 0.030 ms | **69.2 ms** (471,083 matches) |
| `s` | 0.038 ms | **60.5 ms** (307,780 matches) |

So the row-keyed variant fixes orphans for free but costs every common-word query tens of ms. Strings are 63% larger because they hold the sort key per record. Dedupe by row id is not in these numbers.

### 5.6 Vocabulary size and write amplification (run, `v1-vocab.mjs`)

Words are lowercased letter/digit runs as in `wordsOf` (`table.ts:70-75`). Titles of 2-6 words. "Real" draws windows from the corpus above (capped by its 64k-word vocabulary, so it understates open-vocabulary growth: ids, names, typos). "Zipf" draws from 2M word types with weight 1/rank (s = 1), which overstates it [I: real tables sit between].

| Source | Rows | Distinct words | % of rows | Distinct prefixes (1-12) | Distinct words per 4,000-row ingest |
|---|---|---|---|---|---|
| real | 10k | 5,898 | 59% | 17,091 | 3,457 (0.86 per row) |
| real | 100k | 21,504 | 21.5% | 59,336 | same |
| real | 1M | 55,217 | 5.5% | 142,859 | same |
| Zipf | 10k | 18,845 | 189% | 30,118 | 8,489 (2.12 per row) |
| Zipf | 100k | 125,851 | 126% | 158,809 | same |
| Zipf | 1M | 664,922 | 66.5% | 680,368 | same |

Conclusions:
- Stored prefixes (about 2.6x the words on real text) are not needed, see 5.3.
- **Writing the vocabulary at every ingest** costs 0.86-2.1 keys per row, i.e. as much as D's one extra key per row. The idea that batch distinctness is far below row count only holds for large batches or very repetitive text.
- **Writing a word once** (the first time any put in this tab's session sees it, with a tab-local `Set` of words already written or seen) costs 0.055 keys per row at 1M rows (real) to 0.66 (Zipf), plus one set lookup per token. A cold tab rewrites words idempotently up to the ingest rate above, which compaction collapses (same key, newest wins: `compact.rs:17-22`).
- Reading each word before writing (an `update` key per token) adds about 4 point reads per row (about 0.7 us each on a warm tab, section 5.3, so about 3 us per row on top of roughly 20 us per bulk row [MEIA E0: 51k rows/s]) but needs no `Set`. I did not run this end to end.
- Worst case: a field full of unique tokens (ids, emails) makes the vocabulary about one key per row, i.e. D's cost, with no miss benefit for those tokens. [I]

---

## 6. Which queries each technique speeds up

| Query (1M rows) | D merged scan | per-run strings (A) | + vocabulary |
|---|---|---|---|
| one word, prefix matches nothing | 0.3-1 s | 39 ms | **about 7 us** (persisted) or **47 ns** (in memory) |
| several words, one of them matches nothing | same | 39 ms | same speedup: any token with no vocabulary prefix is a miss |
| several words, each exists, never together | same | 39 ms | **none**; falls back to the scan |
| one rare word, present | 0.3-1 s | about 10 ms | none (it exists; scan finds it) |
| common word | 0.15 ms | 0.045 ms | none |
| substring that is not a word prefix | same as D | same | none; the vocabulary is word-level |
| word that existed only in deleted rows | scan | scan | false positive, falls back to the scan; correct |

[I] The all-present, never-together case is the inverted-index case (design B) and needs postings. A per-run in-memory word set could skip runs that lack one token; I did not measure it.

---

## 7. Other techniques, and the per-run Bloom question

**(c) A per-run word Bloom stored as an ordinary record.** [I] Records are merged by key, not unioned (`compact.rs:17-22`). A record `b/<table>/<runId>` has no connection to the physical run its words end up in after a merge: compaction outputs are cut by key range and contain rows of many ingests. A Bloom per ingest seq range stays a valid superset for those rows, but a per-run scan can skip a merged run only if the set of seq ranges inside it is known, and `scanRuns` would have to report it. [R] The SST format already carries a Bloom, built from keys at encode time (MEIA 1.4, `sst.ts:348`); that is the free per-run filter, and it serves whole-word vocabulary keys (0.7 us, 5.3). One global Bloom record rewritten each ingest would be about 10 bits per word: 69 KB at 55k words, 830 KB at 665k [I: arithmetic, RocksDB gives 9.9 bits per key for 1% false positives, https://github.com/facebook/rocksdb/wiki/RocksDB-Bloom-Filter], rewritten whole at every ingest. Ordinary vocabulary keys are better: they merge by key and need no rewrite. Do not do this.

**(d) Primary-source techniques for negative lookups.**
- [E] RocksDB: "By default a hash of every whole key is added to the bloom filter"; "the whole key blooms are only used for point lookups"; with `prefix_extractor` a prefix hash is also added and can serve seeks. https://github.com/facebook/rocksdb/wiki/RocksDB-Bloom-Filter. Reading: filters answer exact keys or a declared prefix, not "any key in this range", which is why a prefix miss here is a seek, not a filter test.
- [E] Tantivy: the term dictionary maps Term to TermOrdinal with a finite state transducer (the `fst` crate), then TermOrdinal to TermInfo. https://raw.githubusercontent.com/quickwit-oss/tantivy/main/ARCHITECTURE.md. A term that is not in the FST is a miss without touching postings. The vocabulary here is that dictionary, built from ordinary sorted keys.
- [E] Lucene: "The .tip file contains an index into the term dictionary, so that it can be accessed randomly." https://lucene.apache.org/core/9_10_0/core/org/apache/lucene/codecs/lucene99/Lucene99PostingsFormat.html. That page does not say how a missing term is resolved or mention an FST; I did not follow it to `Lucene90BlockTreeTermsWriter`.
- [E] SQLite FTS5: "querying for a prefix token can be slow, as it requires a range scan" without a prefix index (section 4.2); and fts5vocab "allows users to extract information from an FTS5 full-text index directly", with a row table of one entry per distinct term (section 8). https://sqlite.org/fts5.html. So FTS5 keeps a per-segment term dictionary and also exposes it. A sorted word list answers prefix existence by range seek; FTS5 documents that a range scan over terms is its slow path only when the dictionary is large.
- [I] All three keep the term dictionary per segment and merge it with segments. Our analogue is a vocabulary as ordinary keys, which are merged by the existing compaction for free.

---

## 8. Recommendation

**Primary: PR1 then PR2, plus an in-memory vocabulary in PR2** (derived from the per-run strings, 266 ms once per tab, 47 ns per lookup). That gives about 39 ms for a rare-or-absent hit at 1M rows and a sub-microsecond miss after the first search of a tab, with no new write, no kv write-path change, no declaration, no reserved prefix, no backfill (that gap exists today and is separate), and no orphan problem. Smallest first PR: **PR1**, because everything else depends on it and it is read-only. The riskiest assumption is PR2's, "per-run strings are fast enough on Chrome and OPFS and give the same answers as D", so build a throwaway Chrome bench of PR1 plus the string cache before polishing.

**Fallback: persisted vocabulary keys written once per word** (collections, tab-local `Set`, same `db.update` as the row), if the first search in a cold tab must also be fast (it avoids the 477 ms of build plus tokenise, 5.4, for a miss). Costs 0.055-0.66 keys per row amortised, depending on how open the vocabulary is.

**Later, only if bulk put cost matters: PR3** with explicit tombstones from collections (2.1 a), read-repair (2.1 d), declaration in IndexedDB meta, backfill by `Table.reindex`.

**Abandon or pause when:**
- the Chrome bench shows the string build or the 40 ms scan above budget on a real device (then B, postings, is the scale-up, MEIA 3.2);
- the dedupe/re-match property test finds a result that differs from D's merged scan that cannot be fixed in collections;
- the unique-token case dominates real data (vocabulary about one key per row): drop the persisted vocabulary and keep the in-memory one;
- PR3 would need the SharedWorker to open runs or a Rust hook: stop at PR2.

---

## 9. Not verified

- **No Chrome, OPFS, IndexedDB, or SharedWorker.** All timings are Node 24 on in-memory run buffers; OPFS read cost and the main-thread stall are not included. Only V8 string search was measured; Safari and Firefox are unmeasured.
- The layout stacks rows by level the way `bench-search-doc.ts` does, so overwrites and tombstones across runs are not represented; stale-hit cost, dedupe and the `get` validation are not in any number.
- The vocabulary lookups use a layout where the vocabulary keys were put in the runs by the script, not by a put path; the `Set`-based write-once rule and the read-before-write variant were not run end to end. Ingest and put cost of those rules is arithmetic from the distinct-word counts.
- The kv derivation (PR3) is not prototyped: the `fold.mts` check shows the ordering of last-writer-wins in `foldRecords` and `Memtable`, nothing about derived records.
- The corpus is English prose plus Go and vim documentation, not todo titles; its distinct-word count is capped by a 64k vocabulary. The Zipf run is synthetic and has no structure of real prefixes (its prefix counts are not meaningful).
- External pages were read through a fetch tool that summarises with a small model; the Lucene page, in particular, did not state what I hoped (see section 7). Re-check quotes before reuse.
- The `existing dist/` build in `packages/kv/dist` is not from this source (it has `store/overlay.js` and `store/sst-layer.js`, which `src/store` lacks), so I imported the TypeScript source directly. I did not run `formal:kv`, `pnpm test` or any Chrome drive; the check lists above are from `docs/verification.md`, not from runs.
- `.claude/worktrees/` and the existing `bench-*.ts` in the repo were left untouched; the existing scripts import `fake-indexeddb/auto`, which I did not use.
