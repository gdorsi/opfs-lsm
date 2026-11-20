# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it. Under each table is the machine and the commit of its run. Every table here ran on an Apple M5 Max, but runs differ in load and commit, so compare numbers inside one table, not across two.

## Storage calls

Each workload holds 100,000 entries with 16-byte keys and 100-byte values. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. A rate counts only the time spent inside the storage calls, opening the store included, not the bench's own work between them. A read of a missing key looks up a key that falls between two stored keys. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

<!-- bench:table storage-calls -->
| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 42.9k ops/s † | 637k ops/s | 15× |
| Random point reads | 20.5k ops/s | 1.06M ops/s | 52× |
| Reads of missing keys | 23.7k ops/s | 3.53M ops/s | 150× |
| Full ordered scan | 702k ops/s | 3.07M ops/s | 4.4× |
| Seeks of 100 keys | 5.05k ops/s | 27.8k ops/s | 5.5× |
| Single put, awaited one at a time | 14.1k ops/s | 12.2k ops/s | 0.87× ‡ |
| Read-modify-write in one transaction | 0.114 ms | 0.155 ms | 0.74× |
| Opening the database in a fresh tab | 0.269 ms | 3.77 ms | 0.071× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 2.5 to 3.9, commit 561029d1. Full results: [2026-11-20T10-28-06-apple-m5-max](results/2026-11-20T10-28-06-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time: kv's is slower than IndexedDB's. Over the whole mix, half of it reads, the two are level, at 12.9k and 12.6k ops/s. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`.

<!-- bench:table framework-adapters -->
| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Open and load 91,000 rows | 637 ms | 149 ms | 4.3× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 21.0k rows/s | 162k rows/s | 7.7× |
| TanStack DB | Serial insert, one row per transaction | 7.61k rows/s | 6.10k rows/s | 0.80× |
| Yjs | Cold load of 500 notes | 5.42k notes/s | 15.1k notes/s | 2.8× |
| Yjs | Editing trace, one update per keystroke | 2.23k edits/s | 35.9k edits/s | 16× |
| Automerge | Cold load of 500 notes | 1.84k notes/s | 2.71k notes/s | 1.5× |
| Automerge | Write 500 notes | 874 notes/s | 948 notes/s | 1.1× ‡ |
| fate | Cold load of 100 lists of 100 records | 2.19k records/s | 4.25k records/s | 1.9× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 2.5 to 4.9, commit 561029d1. Full results: [2026-11-20T10-33-38-apple-m5-max](results/2026-11-20T10-33-38-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).
<!-- /bench:table -->

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and `@nkzw/fate-indexeddb`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode. Opening a collection loads its 91,000 rows, so that row is a time and the others are rates.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. Then they open the document cold in a fresh tab, once before kv settles and once after, at size `small`. A cold open is the whole phase: it opens the store, loads the document and checks its text. The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

<!-- bench:table typing-reopening -->
| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, with its persistence | 0.172 ms | 0.202 ms | 0.424 ms † | 0.406 ms | 0.85× ‡ | 1.0× ‡ |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | | |
| Cold open before the settle | 6.41 ms | 10.5 ms | 43.8 ms | 46.0 ms | 0.61× | 0.95× |
| Cold open after the settle | 6.29 ms | 10.6 ms | 43.7 ms | 47.1 ms | 0.60× | 0.93× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 3.3 to 4.5, commit 561029d1. Full results: [2026-11-20T10-33-38-apple-m5-max](results/2026-11-20T10-33-38-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 4.7 ms before the settle and 3.5 ms after for Yjs, 3.1 ms and 3.0 ms for Automerge.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite, as [bench/README.md](../bench/README.md) describes. Both collections hold 100,000 rows and load only what a query asks for.

<!-- bench:table on-demand-sqlite -->
| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 38.4 ms | 6.39 ms | 6.0× |
| First query after a cold open, 6,250 rows | 60.1 ms | 56.3 ms | 1.1× |
| Warm query of one owner, 6,250 rows | 141k rows/s | 261k rows/s | 1.8× |
| 10 rows by id | 2.16k queries/s | 5.75k queries/s | 2.7× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 2.4 to 3.6, commit 561029d1. Full results: [2026-11-20T10-41-50-apple-m5-max](results/2026-11-20T10-41-50-apple-m5-max.md).
<!-- /bench:table -->

[bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster.

<!-- bench:table goals -->
| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 3.02 / 2.30 | 3.87 / 0.130 | 2.44 / 0.108 | 1.6× / 1.2× |
| First 50 todo issues, with assignee and label names | 1.74 / 0.785 | 5.00 / 0.400 | 6.08 / 0.241 | 0.82× / 1.7× |
| The column a sprint close just emptied | 7.24 / 3.77 | 4.37 / 0.195 | 3.90 / 0.547 | 1.1× ‡ / 0.36× |
| Rows at 90% of a project's list | 7.01 / 5.28 | 4.42 / 0.270 | 6.97 / 0.276 | 0.63× / 0.98× ‡ |
| An issue with its comments and their authors | 1.24 / 0.320 | 4.49 / 0.205 | 4.53 / 0.0727 | 0.99× ‡ / 2.8× |
| First 50 open issues by priority, with comment counts | 3.32 / 1.89 | 6.72 / 1.07 | 9.04 / 0.466 | 0.74× / 2.3× |
| First 50 open issues with a label | 19.2 / 17.4 | 9.38 / 2.72 | 7.42 / 0.363 | 1.3× / 7.5× |
| First 50 open issues assigned to a person | 2.02 / 1.03 | 6.15 / 0.752 | 7.53 / 0.376 | 0.82× / 2.0× |
| The 50 most recently updated issues | 1.56 / 0.890 | 4.95 / 0.570 | 3.00 / 0.430 | 1.7× / 1.3× |
| Open issues per person, top 10 | 7.90 / 5.04 | 4.96 / 0.276 | 3.31 / 0.308 | 1.5× / 0.90× |
| First 20 issues whose title contains a word | 4.85 / 3.48 | 4.95 / 0.497 | 5.59 / 0.169 | 0.89× / 2.9× |
| Opening the store in a fresh tab, before the todo issues goal | 1.80 | 23.0 | 11.4 | 2.0× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 3.5 to 6.8, commit 561029d1. Full results: [2026-11-20T10-47-45-apple-m5-max](results/2026-11-20T10-47-45-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).
<!-- /bench:table -->

<!-- bench:table writes -->
| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, mean of 47 batches of up to 1,000 rows | 39.0 ms | 17.6 ms | 11.2 ms | 1.6× |
| Sync, mean of 851 batches of about 50 changes | 4.43 ms | 12.0 ms | 2.29 ms | 5.3× |
| One edit | 0.304 ms | 2.81 ms | 0.339 ms | 8.3× |
| Sprint close, 1,054 issues in one batch | 106 ms | 70.5 ms | 37.2 ms † | 1.9× |
| The 50 latest issues, read again after every 10th sync batch | 0.969 ms | 0.447 ms | 0.462 ms † | 0.97× ‡ |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 3.5 to 6.8, commit 561029d1. Full results: [2026-11-20T10-47-45-apple-m5-max](results/2026-11-20T10-47-45-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The last row is a read: after every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be.

Warm, docstore answers 8 of the 11 goals fastest, because a tab reads on its own main thread from its page cache. SQLite is faster on 2 of the other 3: the column a sprint close emptied, and the open issues per person, by 10%. The runs do not separate the two on the deep window. Cold, docstore is faster than SQLite on 4 of the 11 goals and slower on 5, and it is the slowest of the three stores on 4: a fresh tab loads from OPFS each 32 KB page its rows sit on, and the rows of one list are scattered over many pages. Open issues per person reads index entries alone, with no document, so cold it is the fastest of the three. The emptied column costs docstore the most: the deletes of the sprint close still sit above the settled runs, and the scan steps over each deleted entry until a compaction drops it. A deep window walks every index entry up to the window on docstore, whose index has no count to jump by: `offset` passes over them without copying a key or reading a document. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no schema statement once the schema exists, so the warm-up those statements used to absorb now lands in its first query. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch. The last column is SQLite's time over docstore's, both on demand.

<!-- bench:table live-queries -->
| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 124 ms | 64.0 ms | 6.73 ms | 54.3 ms | 8.1× |
| First answer: a project's todo column | 16.1 ms | 15.8 ms | 17.0 ms | 29.2 ms † | 1.7× |
| First answer: open issues with a label | 12.9 ms | 12.9 ms | 20.0 ms | 24.5 ms | 1.2× |
| First answer: a person's open issues | 9.31 ms | 8.97 ms | 4.14 ms | 6.02 ms | 1.5× |
| First answer: the 50 latest issues | 3.82 ms | 3.62 ms | 6.64 ms | 7.38 ms | 1.1× |
| A sync batch, no screen open | 2.44 ms | 1.01 ms | 0.959 ms | 20.7 ms | 22× |
| A sync batch, four screens open | 4.37 ms | 3.00 ms | 4.33 ms | 85.5 ms | 20× |
| Frames dropped over 426 batches, screens open | 1 | 1 † | 16 † | 60 † | |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 2.4 to 3.4, commit 561029d1. Full results: [2026-11-20T10-53-50-apple-m5-max](results/2026-11-20T10-53-50-apple-m5-max.md).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds about 2 ms to a batch on IndexedDB and on eager docstore, and 3.4 ms on docstore on demand. On SQLite it adds 65 ms. A [CPU profile](results/2026-11-16T22-25-41-apple-m2-pro-cpu-profile.txt) of that phase, from an earlier run, shows the tab idle two thirds of the time, waiting for SQLite's worker, and decoding the rows the worker sends back is the largest share of the rest. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **19.9 kB** of JavaScript to your main bundle (gzip, 59.0 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 19.9 kB | 59.0 kB | at import |
| SharedWorker chunk | 13.5 kB | 40.9 kB | on the first `openDb` |
| wasm engine | 16.5 kB | 36.3 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **49.9 kB** | **136.2 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 30.0 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the after-open brotli total passes a budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
