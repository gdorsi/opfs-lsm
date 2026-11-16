# Goal-driven benchmarks

Question: can a synthetic dataset plus a fixed set of goals ("count the todo issues of a project", "the first 50 todo issues with assignee and label names") replace the benchmarks that drive example apps, with less overlap between access patterns and coverage of index-driven loads and joins whose rows sit on many 32 KB pages? Is there prior art?

Conventions as in the other research notes. **[E]** external fact, cited with the owner's URL. **[R]** repo fact, cited by path. **[I]** inference. **[M]** measured in this checkout. Fetched 2026-11-16.

---

## 0. Answer

1. Yes, for the questions the engine has to answer. "Dataset plus business questions" is how most database benchmarks work: TPC-H, TPC-C/E, LDBC SNB, JOB, LinkBench. db_bench and YCSB, which the kv half of the suite copies, are the exception (§5).
2. The tool for "no overlap" is LDBC's query × choke-point matrix: each query is designed against named technical challenges, and a gap is fixed by changing a query (§6). §3 applies it to this suite.
3. Two LDBC choke points name what the example apps never isolated: CP-3.3 *scattered index access* and CP-3.2 *dimensional clustering* (§6). In docstore, an index page of 50 is one range plus 50 point gets, each on whatever 32 KB page its row landed on [R: packages/docstore/src/snapshot.ts].
4. Realism moves from the app into the generator. Skew and correlation are built in (§7). The store is built by replaying a history, not by bulk-loading the final state, because an LSM's shape depends on write order (§7). Bindings are curated so a goal's reps do comparable work (§10).
5. Example apps still catch what a goal cannot: adapter and live-query overhead, rendering competing for the main thread, sync running alongside reads, several tabs. Keep one workload per shipped adapter, and drop the app benchmarks whose patterns a goal now owns (§3).
6. First numbers at `small` (§4): the goals separate the libraries by access pattern in a way the app benchmarks never did, and they point at specific docstore API gaps (no index values in a query, no group-by, no offset).

---

## 1. What the current suite measures

[R: bench/README.md] The suite has two halves.

- **Engine workloads.** db_bench and YCSB A to F on raw keys. They isolate engine paths, but six YCSB mixes and five db_bench fills overlap heavily, and no key is an index entry pointing at a row.
- **App workloads.** linearlite, whiteboard, pages and todos run headless. Each number mixes the app's model, TanStack DB, sync and storage. The linearlite data is denormalized (the assignee is a string on the issue, with no labels or projects) and loaded in one sync, so no join and no aged store is ever measured.

Batched small-value ingest appears in five workloads. Blob append plus prefix load appears in every CRDT workload. Index pages appear in three.

## 2. The shape

Two whole shapes were sketched and compared.

- **Goal contract (chosen).** A dataset declares a spec type: goal name → params and answer, with a doc comment as the answer spec [R: bench/datasets/tracker/types.ts]. Every contender implements every goal with its own library's query API and indexes, as LDBC and js-framework-benchmark allow (§5, §8). The oracle answers each goal by brute force over plain Maps. `tsc` fails while a contender, the oracle or the curation misses a goal.
- **Declarative plans over a shared executor (rejected).** A goal is a small logical plan, and one executor runs it through a five-call access interface each contender supplies. Every contender would make the same access sequence, but the executor would be a query engine living in the bench. It would fix docstore's access path, so a docstore API that answers a goal better could never show. SQLite's planner would need a second lowering of the plan to SQL. Two interpreters of one plan language are a list kept in step by hand.

Three parts of the rejected sketch were kept:

- the `recent` writes on top of a settled store;
- the goal on a list a bulk edit just emptied (`drainedPage`);
- the plan to make coverage a checked list (§3).

The rules, and why:

- **Rows as given, plus native indexes. No app-maintained derived state.** TPC-H bans auxiliary structures that span tables, because materialized views turned TPC-D into lookups. LDBC allows precomputation that stays consistent under updates (§5, §10). The question here is what a library gives an app, so anything the library declares natively is allowed (an index, and a native aggregate if docstore ever ships one). Counters and copied names kept by app code are not.
- **History, not bulk load.** Import 70%, age with the rest as sync batches, settle, then write `recent` on top. Bulk-loading sorted rows is the LSM's best case (§7).
- **Cold per goal.** One fresh page per goal: `cold` is the first call after open, `first` calls the other bindings once, and `warm` repeats them. A fresh tab is the only cold measurement fair to engines whose caches a page cannot drop (§10).
- **Curated bindings.** Up to 5 bindings near one cost quantile, picked by a seeded picker, the same for every rep and contender (§10).

The cost of this shape is about 33 hand-written goal bodies (11 goals × 3 contenders). Each number measures the library's own path, plus the skill of whoever wrote the contender. Shortcuts get a note in `fastPath`, not a ban, as in js-framework-benchmark (§8).

## 3. Coverage and the proposed trim

One owner per access pattern. "Hit also by" lists the workloads that would be deleted. This is a proposal: no workload is deleted yet.

| access pattern | owner | hit also by |
|---|---|---|
| batched random ingest, flush and compaction, W-Amp; point get hit/miss; raw cold open | kv/fillrandom | kv/overwrite, kv/ycsb-b, kv/ycsb-c |
| sequential ingest, full scan, seek then next | kv/fillseq | kv/ycsb-e |
| zipfian mixed reads and updates | kv/ycsb-a | kv/ycsb-d (read-latest: `recentActivity`), kv/ycsb-f (read-modify-write: tracker `edit`) |
| compaction memory peak | kv/compaction-memory | |
| single awaited write | tracker `recent` (`edit`) | kv/fillsync |
| deletes, tombstones, space after aging | tracker replay + settle footprint | kv/deleterandom |
| document ingest with index upkeep | tracker replay (`import`, `sync`) | table/todos, linearlite/first-sync |
| index counts, pages, joins, deep windows, search, cold screens | tracker goals | table/todos, linearlite/browse |
| TanStack DB eager adapter | tanstack/todos | |
| TanStack DB on-demand adapter | tanstack-ondemand/queries | linearlite/browse |
| Yjs persistence | yjs/trace | yjs/many-docs, yjs/whiteboard-session |
| Automerge persistence | automerge/trace | automerge/many-docs, pages/type |
| fate persistence | fate/read-cache | fate/mutations (fate's own CPU dominates) |

25 workloads become 10. Three patterns lose their owner and need a decision:

- **Reads during a large sync** (linearlite/first-sync times the first rows while the import runs). This could become a tracker phase that runs `statusPage` while `import` batches land.
- **Paced writes under a frame budget** (yjs/whiteboard-session). This could become a tracker goal that drags issues across board columns at 60 Hz.
- **Many small docs, each loaded cold** (the many-docs workloads).

The trim also touches docs/verification.md, two research notes and the app rows on the home page, which quote these workloads [R: `git grep`].

To make it stick, the matrix should become code: one list of access patterns in `bench/core`, a required `owns` on every workload (a goal workload derives it from its goals), and a check in `bench:smoke --check` that fails when a pattern has two owners or none.

## 4. First results

[M] `node bench/cli.ts run tracker/ --size small --reps 3` on this branch, on top of main at #283: 20,000 issues, 43,000 comments, 87,000 history events. Apple M2 Pro, Chrome 157 headless, load average 1.1. Each cell is the median over 3 reps of the op's mean latency, in ms. `open` is the store's open on a fresh page. `cold` is the first goal call after it. `first` calls the other bindings once, with the engine warm and their rows not yet read. `warm` repeats them.

| goal | docstore cold / first / warm | Dexie cold / first / warm | SQLite cold / first / warm |
|---|---|---|---|
| open (any fresh page) | 17 | 2.1 | 29 |
| statusCounts | 5.6 / 1.2 / 0.41 | 10.6 / 9.3 / 8.0 | 1.6 / 0.35 / 0.26 |
| statusPage | 7.1 / 3.8 / 0.42 | 2.5 / 1.3 / 1.0 | 2.9 / 1.1 / 0.50 |
| drainedPage | 6.2 / – / 1.3 | 10.2 / – / 6.2 | 2.0 / – / 0.29 |
| deepWindow | 12.6 / 6.7 / 1.9 | 18.3 / 14.1 / 12.4 | 2.2 / 0.83 / 0.43 |
| issueThread | 5.4 / 1.7 / 0.14 | 1.5 / 0.66 / 0.43 | 1.9 / 0.32 / 0.36 |
| triagePage | 13.4 / 6.0 / 1.3 | 4.7 / 3.6 / 2.9 | 6.8 / 2.8 / 2.3 |
| labelPage | 6.4 / 3.3 / 0.35 | 7.0 / 6.0 / 4.7 | 8.3 / 3.4 / 2.9 |
| myIssues | 9.6 / 4.8 / 0.48 | 2.4 / 1.4 / 1.2 | 4.0 / 1.2 / 0.74 |
| recentActivity | 3.6 / – / 0.63 | 2.1 / – / 1.2 | 2.5 / – / 0.70 |
| assigneeLoad | 14.8 / 5.9 / 4.3 | 11.9 / 10.1 / 9.1 | 3.2 / 0.70 / 0.50 |
| search | 6.3 / 2.5 / 0.27 | 6.2 / 6.9 / 5.8 | 2.4 / 1.1 / 0.77 |

| writes | docstore | Dexie | SQLite |
|---|---|---|---|
| import, 44 batches of 1,000 rows (total) | 0.80 s | 2.9 s | 1.0 s |
| sync, 875 batches of 50 events (total) | 3.2 s | 5.8 s | 11.7 s |
| one edit | 0.61 | 0.40 | 1.1 |
| bulk: 1,027 issues to done | 61 | 155 | 85 |
| reread: a list read right after an edit | 1.7 | 15.3 | 0.43 |

What the goals show that the app workloads could not:

- **Warm reads are docstore's strength.** It is fastest warm on 7 of 11 goals, because reads run on the tab's main thread from its page cache, with no IPC.
- **Cold and `first` reads are its weakness, and the pattern is CP-3.3.**
  - `statusPage` `first` takes 3.8 ms against 1.3 and 1.1, and `myIssues` 4.8 against 1.4 and 1.2. Each of the 50 rows can sit on a different 32 KB page, which a tab loads from OPFS on first touch.
  - Opening adds 17 ms per fresh page, against 2 ms for Dexie.
  - The next experiment is to count the distinct pages per goal: a smaller read unit, or a row layout that clusters by a hot index, are the candidates.
- **API gaps show up as numbers.**
  - `assigneeLoad` costs 4.3 ms warm against 0.5 for SQLite: docstore has no group-by and no index values in a query, so it makes 480 counts.
  - `deepWindow` costs 1.9 against 0.43: there is no offset, so it walks ids and then reads rows.
- **Tombstone-heavy ranges cost 3×.** `drainedPage` returns 7 rows in 1.3 ms warm, while `statusPage` returns 50 in 0.42. The bulk edit left the range mostly deletes above the settled levels.
- **Writes are strong.**
  - Sync batches are 1.8× faster than Dexie and 3.6× faster than SQLite, which pays one worker round trip per statement.
  - The import is 1.3× faster than SQLite and 3.7× faster than Dexie.

An earlier run on main before #282, at load average 8 to 10, showed the same pattern, with docstore's `first` page reads about twice as slow. #282 added kv's read-ahead in scans.

Two caveats about cold:

- IndexedDB's backend lives in the browser process, which outlives the tab. A fresh tab is therefore a warmer start for Dexie than for kv or SQLite, which read OPFS from a new tab or worker. That matches a reload, not a browser restart.
- Every contender's `cold` also pays JIT warm-up of its own code in the new tab.

---

Sections 5 to 10 are the prior art.

## 5. Dataset + goals benchmarks

| | Dataset | Goals | Precomputation | Validation | Overlap control |
|---|---|---|---|---|---|
| TPC-H | dbgen, uniform values, deliberately correlated dates | 22 SQL templates, parameters uniform random (Cl. 2.1.3.2) | MVs effectively banned (Cl. 1.5.7) | qualification DB, fixed parameters, Appendix C answers | none explicit, analyzed post hoc |
| TPC-C | 9 record types scaled by warehouses, NURand skew | 5 transactions, fixed mix | n/a | 12 consistency conditions, ACID tests | mix ratios |
| TPC-E | EGen, 33 tables, "realistic content", 300 initial trade days | 12 transactions | n/a | ACID, audit | mix ratios |
| CH-benCHmark | TPC-C schema + Supplier/Nation/Region | TPC-C txns + 22 TPC-H queries rewritten for that schema | as TPC | as TPC | n/a |
| LDBC SNB | Datagen, correlated, skewed, deterministic, SF 0.003–30000 | English + reference SQL/Cypher, any API | allowed if consistent under updates | validation set + cross-validation | choke-point matrix |
| JOB | real IMDB, 21 tables, 3.6 GB CSV | 33 structures × 2–6 variants = 113 | n/a (research) | n/a | variants differ only in selections |
| LinkBench | synthetic graph fit to a production trace | 10 operations, trace mix | n/a | n/a | ops from trace |

**TPC-H** [E: https://www.tpc.org/TPC_Documents_Current_Versions/pdf/TPC-H_v3.0.1.pdf]
- Cl. 1.5.7: an auxiliary-structure directive "may reference no more than one base table", and only primary-key, foreign-key or date columns. Nothing may materialize columns "derived from more than one table".
- Cl. 5.2.7: settings may not "make reference to specific tables, indices or queries" to hint the optimizer.
- Cl. 2.3.1: validation runs the same text and driver on an unmodified qualification DB with default parameters and must match Appendix C.
- Query text must be the spec SQL or an approved variant. That is the opposite of idiomatic.
- Why MVs are banned [E: Boncz/Neumann/Erling, https://homepages.cwi.nl/~boncz/snb-challenge/chokepoints-tpctc.pdf]: tiny MVs can hold "the parameterized answers". Oracle's 1998 Million Dollar Challenge exploited this, and TPC-D split into TPC-R (MVs allowed) and TPC-H (outlawed).
- The generator correlates dates on purpose (`l_shipdate = o_orderdate + random[1:121]`), so date clustering gives locality across the join.

**TPC-C** [E: https://www.tpc.org/tpcc/detail5.asp, spec v5.11]: skew via `NURand(A,x,y)` (Cl. 2.1.6). Correctness is checked as 12 post-run invariants such as `W_YTD = sum(D_YTD)` (Cl. 3.3.2). That is a cheap oracle.

**TPC-E** [E: https://www.tpc.org/tpce/default5.asp, spec v1.14.0]: the initial population is the trade history the SUT would produce in 300 "Initial Trade Days". The dataset is defined as a history.

**CH-benCHmark** [E: https://db.in.tum.de/research/projects/CHbenCHmark/]: the growing database makes the OLTP insert rate interfere with OLAP response times [E: Funke et al., https://www.tpc.org/tpctc/tpctc2011/slides_and_papers/Metrics_for_Measuring_the_Performance_of_the_Mixed_Workload_CH_benCHmark.pdf].

**LDBC SNB Interactive** [E: spec https://arxiv.org/abs/2001.02299; SIGMOD'15 https://ir.cwi.nl/pub/23380/23380B.pdf]
- Complex reads cover 1–3-hop neighbourhoods. Short reads are O(log n) lookups (profile view, post view) chained to complex reads by a random walk over their results. Updates come from Datagen's timeline.
- The calibration target is 10% of time on updates, 50% on complex reads and 40% on short reads, with "each query type tak[ing] approximately equal amount of CPU time (i.e., queries that touch more data run less frequently)".
- The v2 mix by operation count is about 8% complex, 72% short, 20% inserts and 0.2% deletes.
- Indexes and MVs are declared in the schema as Explicit Auxiliary Data Structures, the same for every run. The driver may not post-process values.
- A run is a 30-minute warm-up plus a 2-hour measurement.

**JOB** [E: https://www.vldb.org/pvldb/vol9/p204-leis.pdf]
- Variants differ only in their selections, yet they have "different optimal query plans that yield widely differing (sometimes by orders of magnitude) runtimes".
- Synthetic generators use "the very same simplifying assumptions (uniformity, independence, principle of inclusion) that query optimizers make".

**LinkBench** [E: https://research.facebook.com/publications/linkbench-a-database-benchmark-based-on-the-facebook-social-graph/]
- Built from a 6-day trace of a MySQL shard behind TAO, so it holds cache-miss reads plus writes. `assoc_range` is 50.7% of operations, `obj_get` 12.9%, `assoc_count` 4.9%.
- Heavy-tailed out-degree and Zipf hotness, *loosely* correlated by blending two distributions with probability p_corr.
- The run is a bulk load, then a request phase where the graph grows. Results come at steady state after warm-up.

## 6. Choke-point design and the coverage matrix

- Definition [E: Boncz et al.]: "Choke points are those technological challenges underlying a benchmark, whose resolution will significantly improve the performance of a product." Their Table 1 rates each of the 28 choke points' impact on each of the 22 queries as light, medium or strong.
- Method [E: SIGMOD'15 §3]: users supply the scenarios and systems architects name the choke points. Each query is designed against them. In Q9, for example, the planner must choose index nested-loop joins for the first two joins and a hash join for the last.
- Matrix [E: SNB spec Table A.1]: rows are BI 1–20 and IC 1–14, and columns are the choke points. Each choke point also lists the queries that cover it. A gap is fixed by changing a query: IC 14 was replaced in v2 to cover CP-7.6.
- Choke points relevant to a browser document store [E: SNB spec App. A]:
  - CP-3.3 *Scattered index access patterns*: "efficiency of index lookup is very different depending on the locality of keys". Covered by IC 5, 7–14.
  - CP-3.2 *Dimensional clustering*: identifiers chosen to create locality. SIGMOD'15 suggests time-increasing post ids, so "created before date X" becomes a range read with no sort.
  - CP-1.3 *Top-k pushdown* and CP-2.4 *Sparse foreign key joins*.
  - CP-6.1 *Inter-query result reuse*: few distinct parameter values let a result cache answer repeated queries.
  - CP-9.x updates: insert and delete nodes and edges, including recursive deletes.

## 7. Data realism and write history

- **Correlation by construction.** LDBC Datagen [E: spec §3.3] uses a Facebook-like degree distribution and homophily via "correlation dimensions". Flashmob events cluster posts in time, and the output is deterministic regardless of the number of cores. LinkBench models only the correlations its trace showed.
- **Trace-derived synthesis** [E: Cao et al. FAST'20, https://www.usenix.org/conference/fast20/presentation/cao-zhichao]
  - In YCSB, "hot KV-pairs are either randomly allocated across the whole key-space or clustered together". It caused "at least 500% more read-bytes" and "only 17% of the cache hits" of the real workload. Their key-range model reached +43% read bytes and 77% of the cache hits.
  - db_bench `mixgraph` takes the fitted parameters: generalized Pareto value sizes and scan lengths, power-law key access, two-term-exponential key-range hotness, sine QPS. A key range should be about one SST [E: https://github.com/facebook/rocksdb/wiki/RocksDB-Trace%2C-Replay%2C-Analyzer%2C-and-Workload-Generation].
- **Aging**
  - Conway et al. [E: https://www.usenix.org/conference/fast17/technical-sessions/presentation/conway]: a thousand `git pull`s slowed reads up to 30×, and writing the same small files in different orders slowed reads 15–175×.
  - Geriatrix [E: https://www.usenix.org/conference/atc18/presentation/kadekodi]: unaged results overstate performance by up to 30% on HDD and 75% on SSD, and rankings can flip.
  - Impressions says aging must precede benchmarking [E: https://static.usenix.org/events/fast09/tech/full_papers/agrawal/agrawal.pdf].
- **Steady state** [E: Didona et al., https://www.vldb.org/pvldb/vol14/p364-didona.pdf]: RocksDB showed 2.6–3.6× its steady-state throughput in the first 15 minutes (Pitfall 1). Pitfall 4 is testing a single dataset size.
- **Bulk load or history?** [I] An LSM's final contents do not fix its on-disk shape. Write order and timing do:
  - how many runs exist and how much they overlap;
  - the tombstones and superseded versions that updates leave behind;
  - whether one issue's index entries sit in one block or are spread over many runs.

  A sorted bulk load of the final state is the best case. Every benchmark above that has updates loads a *prefix* of a simulated history and replays the rest (LDBC 90/10, TPC-E's 300 days, LinkBench's growth phase). So: **replay at least a tail of history**, and report the engine's shape when measurement starts.

## 8. UI-level goal benchmarks

- **Speedometer 3** [E: https://browserbench.org/Speedometer3.0/about.html, https://github.com/WebKit/Speedometer]
  - TodoMVC apps add, complete and remove 100 todos in many frameworks.
  - A test is an unmeasured prepare step plus measured steps, each split into a sync phase and an async phase.
  - The score is the inverse of the geometric mean. Workloads are "complete user journeys".
  - Changes need two of the three browser projects, and a new version needs all three [E: Governance.md].
  - It "should not be used as a way to compare the performance of different JavaScript frameworks."
- **js-framework-benchmark** [E: https://github.com/krausest/js-framework-benchmark]
  - Fixed goals (create 1k or 10k rows, update every 10th row, select, swap, remove, append, clear, startup, memory), timed with rendering from the Chrome timeline.
  - The HTML "must be identical with the one created by the reference implementation vanillajs", and `isKeyed` must pass. Both act as an output oracle.
  - Shortcuts get *notes*, not bans: manual DOM (#772), explicit event delegation (#801), rAF (#796), per-row selection flags (#800). "Please don't over-optimize."
  - Only keyed implementations are run. The score is a weighted geometric mean.

## 9. Local-first and browser DBs with a task-tracker dataset

- **Zero / gigabugs** [E: https://zero.rocicorp.dev/docs/samples]: a Linear-style tracker with 1.2M bugs and over 1 GB of data that loads "from cold start in < 2s".
  - The repo's generator [E: https://github.com/rocicorp/mono/blob/main/apps/zbugs/scripts/generate-synthetic.ts] defaults to 1M issues, 100 projects and 100 users, seeded with xoshiro128**.
  - Projects are drawn as `floor(r²·n)`, comments are exponential with mean 3, labels are uniform 1–3 per issue, 70% of issues are open and 70% are assigned uniformly. `created` is independent of id.
  - A real seed of Zero's own GitHub issues also ships. [I] It is not stated whether `gigabugs_v3` comes from this script.
  - No goal suite: client benches are micro. Release notes 1.8 claim `issue.related('creator').related('comments')` hydrates "about 1.3x faster" with no method [E: https://zero.rocicorp.dev/docs/release-notes/1.8].
- **ElectricSQL linearlite** [E: https://github.com/electric-sql/electric/blob/main/examples/linearlite/db/generate_data.js]: uniform faker status and priority, 0–1 comments, no labels or projects. No benchmark.
- **Others.** A qualitative LiveStore vs Vulcan linearlite gist [E: https://gist.github.com/tantaman/f5faa1c627b69aa68f45066f17eae2a1]. A closed TanStack DB "linearlarge" PR [E: https://github.com/TanStack/db/pull/891]. Micro or CRUD suites from Replicache [E: https://doc.replicache.dev/concepts/performance], PGlite [E: https://pglite.dev/benchmarks] and wa-sqlite [E: https://github.com/rhashimoto/wa-sqlite]. Nothing found for Triplit, InstantDB, TinyBase or LiveStore.

## 10. Pitfalls

- **Precomputed answers:** TPC-D's MVs, CP-6.1 result reuse, parameters with few distinct values (TPC-H has 5 region names).
- **Query-specific tuning** [E: Raasveldt et al. DBTest'18, https://hannes.muehleisen.org/publications/DBTEST2018-performance-testing.pdf]: everything in a standard benchmark is known ahead of time. The fix is to also run "a set of different queries".
- **Parameter choice** [E: Gubichev & Boncz TPCTC'14, https://webvm.db.in.tum.de/~gubichev/papers/tpctc_parameters.pdf]
  - Uniform bindings over IMDB gave one template a runtime variance of 17·10⁴.
  - Requirements: bounded variance, a stable distribution across streams, and the same optimal plan for every binding.
  - Curation takes intermediate counts from generation and greedily picks bindings with similar counts. Very different cases become separate variants.
  - SNB v2 buckets parameters per simulated day, so they never target rows not yet inserted or already deleted.
- **Cold vs hot** (Raasveldt): report cold and hot runs separately. A cold run measured by mistake is often warm. Leaving out preprocessing such as index builds is unfair, and results must be verified.


## Could not fetch or not found

- The absurd-sql post (jlongster.com/future-sql-web) and the TinyBase performance guide both returned 404.
- The CH-benCHmark DBTest'11 PDF was not read: I used the project page and the metrics paper instead. For Impressions I only had the abstract.
- The cells of TPC-H Analyzed's Table 1 are shading, which was lost in PDF extraction.
- I found no query benchmarks for Triplit, InstantDB or LiveStore.
- Zero's `zql-benchmarks` appear only in a search summary of the 1.7 notes, not on the fetched page or on `main`.
