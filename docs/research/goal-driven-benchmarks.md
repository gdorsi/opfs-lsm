# A dataset plus goals replaces the app benchmarks

Status: shipped. `tracker/goals` replaced the app benchmarks, and each access pattern has one owning workload. bench/README.md describes both, in "Goal workloads" and "Adding a workload or contender", and docs/benchmarks.md publishes the goal numbers.

Date: 2026-11-16, sources fetched that day. The first run was on size `small`, on top of main at #283, in Chrome 157 headless on an Apple M2 Pro at load average 1.1, with `node bench/cli.ts run tracker/ --size small --reps 3`. The published goal tables supersede its numbers, so this note keeps only the four that drove a change.

## Question

Can a synthetic dataset plus a fixed set of goals ("count the todo issues of a project", "the first 50 todo issues with assignee and label names") replace the benchmarks that drive example apps, with less overlap between access patterns and coverage of index-driven loads and joins whose rows sit on many 32 KB pages? Is there prior art?

Before the change, the app benchmarks (linearlite, whiteboard, pages, todos) mixed the app's model, TanStack DB, sync and storage in each number. The linearlite data was denormalized and loaded in one sync, so no join and no aged store was ever measured. The engine half, db_bench and YCSB A to F on raw keys, overlapped heavily, and no key was an index entry pointing at a row.

## Verdict

1. Yes. "Dataset plus business questions" is how most database benchmarks work: TPC-H, TPC-C, TPC-E, LDBC SNB, JOB and LinkBench. db_bench and YCSB are the exception.
2. LDBC's query by choke-point matrix is the tool for "no overlap". Each query is designed against named technical challenges, and a gap is fixed by changing a query. The suite's form of it is one owning workload per access pattern, checked in code by `bench/core/patterns.ts` and `bench:smoke --check`.
3. Two LDBC choke points name what the example apps never isolated: CP-3.3, scattered index access, and CP-3.2, dimensional clustering.
4. Realism moves from the app into the generator. Skew and correlation are built in, the store is built by replaying a history, and bindings are curated so a goal's reps do comparable work.
5. Example apps catch what a goal cannot, such as rendering that competes for the main thread, or several tabs. That is a reason to test them, not to benchmark them.

## The shape chosen, and the one rejected

**Goal contract (chosen).** A dataset declares a spec type of goals. Every contender answers every goal with its own library's query API and indexes, as LDBC and js-framework-benchmark allow, and an oracle checks every answer. The cost is a hand-written goal body per goal and contender, so each number also measures the skill of whoever wrote the contender. Shortcuts get a note in `fastPath`, not a ban, as in js-framework-benchmark.

**Declarative plans over a shared executor (rejected).** A goal would be a small logical plan, and one executor would run it through a five-call access interface each contender supplies. Every contender would make the same access sequence, but the executor would be a query engine living in the bench. It would fix docstore's access path, so a docstore API that answers a goal better could never show. SQLite's planner would need a second lowering of the plan to SQL. Two interpreters of one plan language are a list kept in step by hand. Three of its parts were kept: the `recent` writes on top of a settled store, the goal on a list a bulk edit just emptied (`drainedPage`), and coverage as a checked list.

The rules a contender follows, and their sources:

- **Rows as given, plus native indexes, and no app-maintained derived state.** TPC-H bans auxiliary structures that span tables, because materialized views turned TPC-D into lookups. LDBC allows precomputation that stays consistent under updates. The question here is what a library gives an app, so anything the library declares natively is allowed. Counters and copied names kept by app code are not.
- **History, not bulk load.** An LSM's final contents do not fix its on-disk shape. Write order and timing decide how many runs exist and how much they overlap, which tombstones and superseded versions remain, and whether one issue's index entries share a block. A sorted bulk load is the LSM's best case. Every benchmark below that has updates loads a prefix of a simulated history and replays the rest.
- **Cold per goal.** A fresh tab is the only cold measurement fair to engines whose caches a page cannot drop.
- **Curated bindings.** Bindings near one cost quantile, picked by a seeded picker, the same for every rep and contender, after Gubichev and Boncz.

## Workloads the trim removed

On 2026-11-16, each removed workload's timed ops were checked against an owner that makes the same call on the same contenders at the same layer:

- `kv/overwrite`: its batched puts are `kv/fillrandom`'s, and the old versions compaction drops are in `kv/ycsb-a`'s settle and `kv/compaction-memory`'s rounds.
- `kv/ycsb-b`, `kv/ycsb-c`: `kv/ycsb-a`'s zipfian reads and updates, in other proportions.
- `kv/ycsb-d`: its inserts are single blind puts, as `kv/ycsb-a`'s updates are. Its reads of the latest keys read data above the settled levels, as `kv/ycsb-a`'s and `kv/fillrandom`'s unsettled reads do.
- `kv/ycsb-e`: its scans of 1 to 100 keys are a seek followed by nexts, as in `kv/fillseq`.
- `table/todos` and its family: `tracker/goals` compares docstore with Dexie, and with SQLite.

`kv/fillsync`, `kv/deleterandom` and `kv/ycsb-f` each made a call no other kv workload made, so they became phases of `kv/fillrandom` and `kv/ycsb-a`. The four app workloads (`linearlite/first-sync`, `linearlite/browse`, `yjs/whiteboard-session`, `pages/type`) went too. Reads during a large sync moved to the tracker replay, paced typing and a reopen before the settle to the trace workloads, the tracker screens to `tracker/goals`, and live-query overhead to `tanstack-live/screens`.

## What the first run showed

Each number is the median over 3 reps of the op's mean latency, under the conditions in the Date line:

- `assigneeLoad` took 4.3 ms warm on docstore against 0.5 on SQLite. docstore had no group-by and no index values in a query, so it made 480 counts.
- `deepWindow` took 1.9 ms warm against 0.43. docstore had no offset, so it walked ids and then read rows.
- `statusPage` `first` (engine warm, rows not yet read) took 3.8 ms on docstore against 1.3 on Dexie and 1.1 on SQLite. Each of the 50 rows can sit on a different 32 KB page, which a tab loads from OPFS on first touch.

docstore has since gained `queryEntries`, which returns index values without reading documents, included fields, and `offset` ([packages/docstore/README.md](../../packages/docstore/README.md)). It still has no group-by.

## Prior art

- **TPC-H** bans auxiliary structures over more than one table (Cl. 1.5.7) and optimizer hints that name tables, indexes or queries (Cl. 5.2.7). Tiny materialized views can hold "the parameterized answers". Oracle's 1998 Million Dollar Challenge exploited this, and TPC-D split into TPC-R and TPC-H. Its generator correlates dates on purpose (`l_shipdate = o_orderdate + random[1:121]`) [https://www.tpc.org/TPC_Documents_Current_Versions/pdf/TPC-H_v3.0.1.pdf, https://homepages.cwi.nl/~boncz/snb-challenge/chokepoints-tpctc.pdf].
- **TPC-C** gets skew from `NURand` and checks correctness with 12 post-run invariants such as `W_YTD = sum(D_YTD)`, a cheap oracle [https://www.tpc.org/tpcc/detail5.asp]. **TPC-E** defines its initial population as 300 days of trade history [https://www.tpc.org/tpce/default5.asp].
- **LDBC SNB Interactive** chains short O(log n) reads to complex reads by a random walk over their results, takes updates from the generator's timeline, and declares indexes and materialized views in the schema, the same for every run [https://arxiv.org/abs/2001.02299]. Its choke points rate each query's impact, and v2 replaced IC 14 to cover CP-7.6. CP-3.3 says "efficiency of index lookup is very different depending on the locality of keys". CP-3.2 suggests time-increasing ids, so a date filter becomes a range read. CP-6.1 warns that few distinct parameter values let a result cache answer repeated queries.
- **JOB** variants differ only in their selections yet have "different optimal query plans that yield widely differing (sometimes by orders of magnitude) runtimes" [https://www.vldb.org/pvldb/vol9/p204-leis.pdf].
- **LinkBench** comes from a 6-day trace of a MySQL shard behind TAO, with `assoc_range` at 50.7% of operations, and measures at steady state after a bulk load and a growth phase [https://research.facebook.com/publications/linkbench-a-database-benchmark-based-on-the-facebook-social-graph/].
- **Cao et al. (FAST '20)** found that YCSB's placement of hot keys caused "at least 500% more read-bytes" and "only 17% of the cache hits" of the real workload [https://www.usenix.org/conference/fast20/presentation/cao-zhichao].
- **Aging.** Conway et al. slowed reads up to 30× with a thousand `git pull`s [https://www.usenix.org/conference/fast17/technical-sessions/presentation/conway]. Geriatrix found unaged results overstate performance by up to 75% on SSD, and rankings can flip [https://www.usenix.org/conference/atc18/presentation/kadekodi]. Didona et al. saw RocksDB at 2.6–3.6× its steady-state throughput in the first 15 minutes [https://www.vldb.org/pvldb/vol14/p364-didona.pdf].
- **js-framework-benchmark** checks every implementation's HTML against the vanillajs reference, and gives shortcuts notes rather than bans [https://github.com/krausest/js-framework-benchmark]. Speedometer 3 times complete user journeys and says it "should not be used as a way to compare the performance of different JavaScript frameworks" [https://browserbench.org/Speedometer3.0/about.html].
- **Local-first trackers.** Zero's gigabugs is a Linear-style tracker with 1.2M bugs, and its generator draws projects as `floor(r²·n)`, comments as exponential with mean 3, and 1 to 3 uniform labels per issue [https://github.com/rocicorp/mono/blob/main/apps/zbugs/scripts/generate-synthetic.ts]. ElectricSQL's linearlite data has uniform status and priority and no labels or projects [https://github.com/electric-sql/electric/blob/main/examples/linearlite/db/generate_data.js]. Neither ships a goal suite, and none was found for Triplit, InstantDB, TinyBase or LiveStore.

## Pitfalls

- **Precomputed answers.** TPC-D's materialized views, CP-6.1's result reuse, and parameters with few distinct values (TPC-H has 5 region names).
- **Query-specific tuning.** Everything in a standard benchmark is known ahead of time, so also run "a set of different queries" [https://hannes.muehleisen.org/publications/DBTEST2018-performance-testing.pdf].
- **Parameter choice.** Uniform bindings over IMDB gave one template a runtime variance of 17·10⁴. Curation picks bindings with similar intermediate counts, and splits very different cases into variants. SNB v2 buckets parameters per simulated day, so a binding never targets a row not yet inserted or already deleted [https://webvm.db.in.tum.de/~gubichev/papers/tpctc_parameters.pdf].
- **Cold against hot.** Report them apart. A cold run measured by mistake is often warm. In this suite every contender's cold call also pays the JIT warm-up of its own code in the new tab, and IndexedDB's backend outlives the tab, so Dexie's cold is a reload, not a browser restart.
