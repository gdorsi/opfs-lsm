# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it. Under each table is the machine and the commit of its run. Every table here ran on an Apple M5 Max, but runs differ in load and commit, so compare numbers inside one table, not across two.

## Storage calls

Each workload holds 100,000 entries with 16-byte keys and 100-byte values. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. A rate is the operations over the time from the first storage call to the last, opening the store included. The bench builds its inputs before the first call and checks the results after the last, so the calls run back to back. A read of a missing key looks up a key that falls between two stored keys. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

<!-- bench:table storage-calls -->
| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 44.7k ops/s | 531k ops/s | 12× |
| Random point reads | 20.4k ops/s | 686k ops/s | 34× |
| Reads of missing keys | 22.8k ops/s | 1.45M ops/s | 63× |
| Full ordered scan | 598k ops/s † | 3.29M ops/s | 5.5× |
| Seeks of 100 keys | 4.61k ops/s | 22.7k ops/s | 4.9× |
| Single put, awaited one at a time | 14.3k ops/s | 12.2k ops/s | 0.85× |
| Read-modify-write in one transaction | 0.109 ms | 0.157 ms | 0.69× |
| Opening the database in a fresh tab | 0.270 ms | 4.10 ms | 0.066× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 2.2 to 3.3, commit 77b174fa. Full results: [2026-11-20T12-02-50-apple-m5-max](results/2026-11-20T12-02-50-apple-m5-max.md).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time: kv's is slower than IndexedDB's. Over the whole mix, half of it reads, the two are level, at 12.7k and 12.4k ops/s. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`.

<!-- bench:table framework-adapters -->
| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Open and load 91,000 rows | 623 ms | 149 ms | 4.2× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 21.3k rows/s | 159k rows/s | 7.5× |
| TanStack DB | Serial insert, one row per transaction | 7.65k rows/s | 6.38k rows/s | 0.83× |
| Yjs | Cold load of 500 notes | 4.62k notes/s | 14.9k notes/s | 3.2× |
| Yjs | Editing trace written in one burst, 25,700 updates with no yield between keystrokes | 2.23k edits/s | 35.4k edits/s | 16× |
| Yjs | One keystroke typed at 60 Hz, with its persistence | 0.116 ms | 0.147 ms | 0.79× |
| Automerge | Cold load of 500 notes | 2.06k notes/s | 2.80k notes/s | 1.4× |
| Automerge | Write 500 notes | 918 notes/s | 958 notes/s | 1.0× |
| fate | Cold load of 100 lists of 100 records | 2.26k records/s | 3.97k records/s | 1.8× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 1.8 to 3.0, commit 8c5f3e3a. Full results: [2026-11-20T12-32-17-apple-m5-max](results/2026-11-20T12-32-17-apple-m5-max.md).
<!-- /bench:table -->

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and `@nkzw/fate-indexeddb`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode. Opening a collection loads its 91,000 rows, so that row is a time and the others are rates. The Yjs editing trace is a burst: 25,700 updates written with no yield between keystrokes, so kv's group commit folds them into few writes while y-indexeddb commits one transaction per update. The paced row below it is one keystroke typed at 60 Hz, which is what an editor feels.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. Then they open the document cold in a fresh tab, once before kv settles and once after, at size `small`. A cold open is the whole phase: it opens the store, loads the document and checks its text. The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

<!-- bench:table typing-reopening -->
| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, with its persistence | 0.116 ms | 0.147 ms | 0.308 ms | 0.308 ms | 0.79× | 1.0× ‡ |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | | |
| Cold open before the settle | 5.98 ms | 10.5 ms | 41.8 ms | 45.2 ms | 0.57× | 0.92× |
| Cold open after the settle | 6.05 ms | 11.4 ms | 41.9 ms | 46.5 ms | 0.53× | 0.90× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 1.9 to 3.5, commit 8c5f3e3a. Full results: [2026-11-20T12-32-17-apple-m5-max](results/2026-11-20T12-32-17-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).
<!-- /bench:table -->

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 4.7 ms before the settle and 4.7 ms after for Yjs, 3.0 ms and 3.3 ms for Automerge.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite for filters made of equality and `in`, as [bench/README.md](../bench/README.md) describes. The page query filters with `gte` on `createdAt`, so SQLite still loads the owner's tail for it. Both collections hold 100,000 rows and load only what a query asks for.

<!-- bench:table on-demand-sqlite -->
| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 37.7 ms † | 6.29 ms | 6.0× |
| First query after a cold open, 6,250 rows | 59.8 ms | 57.7 ms | 1.0× |
| Warm query of one owner, 6,250 rows | 145k rows/s | 265k rows/s | 1.8× |
| 10 rows by id | 2.18k queries/s | 5.59k queries/s | 2.6× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 1.8 to 3.0, commit 8c5f3e3a. Full results: [2026-11-20T12-40-24-apple-m5-max](results/2026-11-20T12-40-24-apple-m5-max.md).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

[bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster.

<!-- bench:table goals -->
| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 3.15 / 1.94 | 3.87 / 0.128 | 2.36 / 0.101 | 1.6× / 1.3× |
| First 50 todo issues, with assignee and label names | 1.57 / 0.658 | 4.93 / 0.395 | 5.71 / 0.241 | 0.86× / 1.6× |
| The column a sprint close just emptied | 6.07 / 3.72 | 4.28 / 0.173 | 3.68 / 0.537 | 1.2× / 0.32× ‡ |
| Rows at 90% of a project's list | 6.82 / 5.15 | 4.40 / 0.270 | 6.41 / 0.270 | 0.69× / 1.0× ‡ |
| An issue with its comments and their authors | 1.20 / 0.315 | 4.40 / 0.210 † | 4.26 / 0.0777 | 1.0× ‡ / 2.7× |
| First 50 open issues by priority, with comment counts | 3.21 / 1.63 | 5.07 / 0.307 | 8.81 / 0.458 | 0.58× / 0.67× |
| First 50 open issues with a label | 18.7 / 16.9 | 9.28 / 2.63 | 7.35 / 0.359 | 1.3× / 7.3× |
| First 50 open issues assigned to a person | 1.99 / 0.981 | 5.40 / 0.416 | 7.22 / 0.366 | 0.75× / 1.1× |
| The 50 most recently updated issues | 1.54 / 0.850 | 4.82 / 0.605 | 2.94 / 0.410 | 1.6× / 1.5× |
| Open issues per person, top 10 | 3.99 / 2.45 | 4.93 / 0.266 | 3.18 / 0.310 | 1.5× / 0.86× |
| First 20 issues whose title contains a word | 4.68 / 3.24 | 4.90 / 0.479 | 5.26 / 0.172 | 0.93× ‡ / 2.8× |
| Opening the store in a fresh tab, before the todo issues goal | 1.74 | 22.1 | 11.2 | 2.0× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 3.0 to 5.8, commit 8c5f3e3a. Full results: [2026-11-20T12-46-06-apple-m5-max](results/2026-11-20T12-46-06-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

<!-- bench:table writes -->
| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, mean of 47 batches of up to 1,000 rows | 38.3 ms | 16.6 ms | 10.5 ms | 1.6× |
| Sync, mean of 851 batches of about 50 changes | 4.30 ms | 10.7 ms | 2.09 ms | 5.1× |
| One edit | 0.291 ms | 3.15 ms | 0.306 ms | 10× |
| Sprint close, 1,054 issues in one batch | 100 ms | 46.5 ms | 33.4 ms | 1.4× |
| The 50 latest issues, read again after every 10th sync batch | 0.903 ms | 0.406 ms | 0.399 ms | 1.0× ‡ |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 3.0 to 5.8, commit 8c5f3e3a. Full results: [2026-11-20T12-46-06-apple-m5-max](results/2026-11-20T12-46-06-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).
<!-- /bench:table -->

The last row is a read: after every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be.

Warm, docstore answers 7 of the 11 goals fastest, because a tab reads on its own main thread from its page cache. SQLite is faster on 2 of the other 4: the open issues by priority, by 33%, and the open issues per person, by 14%. The runs do not separate the two on the column a sprint close emptied and on the deep window. Cold, docstore is faster than SQLite on 5 of the 11 goals and slower on 4, and it is the slowest of the three stores on 4: a fresh tab loads from OPFS each 32 KB page its rows sit on, and the rows of one list are scattered over many pages. Open issues per person reads index entries alone, with no document, so cold it is the fastest of the three. The emptied column costs docstore the most: the deletes of the sprint close still sit above the settled runs, and the scan steps over each deleted entry until a compaction drops it. A deep window walks every index entry up to the window on docstore, whose index has no count to jump by: `offset` passes over them without copying a key or reading a document. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no statement once the schema exists, so its first query in a fresh tab also reads the schema. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch. The last column is SQLite's time over docstore's, both on demand.

<!-- bench:table live-queries -->
| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 123 ms | 63.8 ms | 6.65 ms | 52.2 ms | 7.9× |
| First answer: a project's todo column | 15.9 ms | 15.6 ms | 16.8 ms | 28.9 ms | 1.7× |
| First answer: open issues with a label | 12.6 ms | 12.3 ms | 20.2 ms | 24.2 ms | 1.2× |
| First answer: a person's open issues | 10.7 ms | 9.27 ms | 4.24 ms | 6.06 ms | 1.4× |
| First answer: the 50 latest issues | 2.23 ms | 3.70 ms | 6.82 ms | 7.36 ms | 1.1× |
| A sync batch, no screen open | 2.43 ms | 0.990 ms | 0.923 ms | 19.8 ms | 21× |
| A sync batch, four screens open | 4.30 ms | 2.90 ms | 4.17 ms | 82.4 ms | 20× |
| Frames dropped over 426 batches, screens open | 0 | 0 † | 14 | 59 | |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 1.7 to 2.7, commit 8c5f3e3a. Full results: [2026-11-20T12-52-00-apple-m5-max](results/2026-11-20T12-52-00-apple-m5-max.md).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds about 2 ms to a batch on IndexedDB and on eager docstore, and 3.3 ms on docstore on demand. On SQLite it adds 63 ms. A [CPU profile](results/2026-11-16T22-25-41-apple-m2-pro-cpu-profile.txt) of that phase, from an earlier run, shows the tab idle two thirds of the time, waiting for SQLite's worker, and decoding the rows the worker sends back is the largest share of the rest. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **19.2 kB** of JavaScript to your main bundle (gzip, 56.9 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 19.2 kB | 56.9 kB | at import |
| SharedWorker chunk | 13.5 kB | 41.2 kB | on the first `openDb` |
| wasm engine | 16.5 kB | 36.3 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **49.3 kB** | **134.4 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 30.1 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the main-thread JS passes 19.5 kB gzip or the after-open brotli total passes its budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
