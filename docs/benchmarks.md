# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it. Under each table is the machine and the commit of its run. Every table here ran on an Apple M2 Pro that other work shared, so the load average under a table is high and some cells split into two clusters. Runs differ in load, so compare numbers inside one table, not across two.

## Storage calls

Each workload holds 100,000 entries with 16-byte keys and 100-byte values, except the two 8 KiB rows, which hold 6,000 values of 8 KiB under 40-byte keys. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. A rate is the operations over the time from the first storage call to the last, opening the store included. The bench builds its inputs before the first call and checks the results after the last, so the calls run back to back. A read of a missing key looks up a key that falls between two stored keys. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

<!-- bench:table storage-calls -->
| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 26.8k ops/s | 401k ops/s | 15× |
| Random point reads | 16.9k ops/s | 447k ops/s | 26× |
| Reads of missing keys | 16.5k ops/s | 994k ops/s | 60× |
| Full ordered scan | 444k ops/s † | 1.86M ops/s | 4.2× |
| Seeks of 100 keys | 3.63k ops/s | 13.4k ops/s | 3.7× |
| Single put, awaited one at a time | 9.03k ops/s | 7.71k ops/s | 0.85× |
| Read-modify-write in one transaction | 0.186 ms | 0.138 ms | 1.3× |
| Every 8 KiB value in a fresh tab, 500 neighbouring keys a read | 56.6k ops/s † | 96.4k ops/s | 1.7× |
| Every 8 KiB value in a fresh tab, 500 scattered keys a read | 61.4k ops/s | 34.8k ops/s | 0.57× |
| Opening the database in a fresh tab | 0.326 ms | 5.13 ms | 0.064× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 2.6 to 5.9, commit 1e24b5ec. Full results: [2026-11-22T11-32-45-apple-m2-pro](results/2026-11-22T11-32-45-apple-m2-pro.md).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time: the runs do not separate kv's from IndexedDB's. Over the whole mix, half of it reads, kv is ahead, at 11.2k against 7.32k ops/s. The two 8 KiB rows are `kv/large-values`: kv is faster when a read asks for neighbouring keys, and slower when its keys are scattered over the store. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`.

<!-- bench:table framework-adapters -->
| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Open and load 91,000 rows | 915 ms | 247 ms | 3.7× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 12.9k rows/s | 112k rows/s | 8.7× |
| TanStack DB | Serial insert, one row per transaction | 4.93k rows/s | 6.76k rows/s | 1.4× |
| Yjs | Cold load of 500 notes | 2.72k notes/s | 10.7k notes/s | 3.9× |
| Yjs | Editing trace written in one burst, 25,700 updates with no yield between keystrokes | 2.28k edits/s | 23.8k edits/s | 10× |
| Yjs | One keystroke typed at 60 Hz, with its persistence | 0.230 ms | 0.321 ms | 0.72× |
| Automerge | Cold load of 500 notes | 1.43k notes/s | 2.03k notes/s | 1.4× |
| Automerge | Write 500 notes | 634 notes/s | 673 notes/s | 1.1× |
| fate | Cold load of 100 lists of 100 records | 1.56k records/s | 3.37k records/s | 2.2× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 1.9 to 5.1, commit 1e24b5ec. Full results: [2026-11-22T11-44-02-apple-m2-pro](results/2026-11-22T11-44-02-apple-m2-pro.md).
<!-- /bench:table -->

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and `@nkzw/fate-indexeddb`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode. Opening a collection loads its 91,000 rows, so that row is a time and the others are rates. The Yjs editing trace is a burst: 25,700 updates written with no yield between keystrokes, so kv's group commit folds them into few writes while y-indexeddb commits one transaction per update. The paced row below it is one keystroke typed at 60 Hz, which is what an editor feels.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. Then they open the document cold in a fresh tab, once before kv settles and once after, at size `small`. A cold open is the whole phase: it opens the store, loads the document and checks its text. The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

<!-- bench:table typing-reopening -->
| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, with its persistence | 0.230 ms | 0.321 ms | 0.584 ms | 0.607 ms | 0.72× | 0.96× ‡ |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | | |
| Cold open before the settle | 8.25 ms | 14.4 ms | 57.7 ms | 62.9 ms | 0.57× | 0.92× |
| Cold open after the settle | 8.28 ms | 14.5 ms | 58.0 ms | 63.8 ms | 0.57× | 0.91× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 2.2 to 4.8, commit 1e24b5ec. Full results: [2026-11-22T11-44-02-apple-m2-pro](results/2026-11-22T11-44-02-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).
<!-- /bench:table -->

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 6.6 ms before the settle and 5.4 ms after for Yjs, 4.0 ms and 4.0 ms for Automerge.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite for filters made of equality and `in`, as [bench/README.md](../bench/README.md) describes. The page query filters with `gte` on `createdAt`, so SQLite still loads the owner's tail for it. Both collections hold 100,000 rows and load only what a query asks for.

<!-- bench:table on-demand-sqlite -->
| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 48.9 ms | 7.70 ms | 6.4× |
| First query after a cold open, 6,250 rows | 88.3 ms | 77.8 ms | 1.1× |
| Warm query of one owner, 6,250 rows | 97.2k rows/s | 183k rows/s | 1.9× |
| 10 rows by id | 1.54k queries/s | 3.87k queries/s | 2.5× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 1.6 to 2.8, commit 1e24b5ec. Full results: [2026-11-22T11-54-07-apple-m2-pro](results/2026-11-22T11-54-07-apple-m2-pro.md).
<!-- /bench:table -->

[bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster.

<!-- bench:table goals -->
| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 4.36 / 3.56 † | 5.43 / 0.166 | 4.73 † / 0.172 † | 1.1× / 0.96× ‡ |
| First 50 todo issues, with assignee and label names | 2.36 / 1.24 † | 7.10 / 0.532 | 9.10 † / 0.370 † | 0.78× / 1.4× |
| The column a sprint close just emptied | 9.92 / 6.10 | 6.03 / 0.265 † | 5.66 / 0.740 | 1.1× ‡ / 0.36× |
| Rows at 90% of a project's list | 10.5 / 8.60 † | 6.14 / 0.360 | 10.9 † / 0.415 | 0.56× / 0.87× |
| An issue with its comments and their authors | 1.62 / 0.436 | 6.16 / 0.259 † | 7.06 / 0.116 † | 0.87× ‡ / 2.2× |
| First 50 open issues by priority, with comment counts | 4.65 / 2.59 | 7.23 / 0.419 | 13.9 † / 0.686 † | 0.52× / 0.61× |
| First 50 open issues with a label | 29.8 / 25.6 | 13.1 / 4.03 | 10.5 † / 0.445 | 1.2× / 9.1× |
| First 50 open issues assigned to a person | 2.96 / 1.67 | 7.76 / 0.543 | 10.2 † / 0.452 † | 0.76× / 1.2× |
| The 50 most recently updated issues | 2.27 / 1.40 | 6.84 / 0.792 | 4.77 † / 0.542 | 1.4× / 1.5× |
| Open issues per person, top 10 | 5.93 / 3.78 | 7.01 / 0.360 | 5.79 † / 0.425 | 1.2× / 0.85× |
| First 20 issues whose title contains a word | 7.20 / 5.05 | 7.04 / 0.670 | 8.19 † / 0.285 † | 0.86× ‡ / 2.4× |
| Opening the store in a fresh tab, before the todo issues goal | 2.34 | 27.8 | 14.5 | 1.9× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 3.4 to 7.5, commit 1e24b5ec. Full results: [2026-11-22T11-58-43-apple-m2-pro](results/2026-11-22T11-58-43-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

<!-- bench:table writes -->
| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, mean of 47 batches of up to 1,000 rows | 62.6 ms | 21.1 ms | 13.8 ms | 1.5× |
| Sync, mean of 851 batches of about 50 changes | 6.73 ms | 13.0 ms | 2.72 ms | 4.8× |
| One edit | 0.415 ms | 1.99 ms | 0.332 ms † | 6.0× |
| Sprint close, 1,054 issues in one batch | 160 ms | 65.0 ms | 53.4 ms | 1.2× |
| The 50 latest issues, read again after every 10th sync batch | 1.45 ms | 0.556 ms | 0.550 ms | 1.0× ‡ |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 3.4 to 7.5, commit 1e24b5ec. Full results: [2026-11-22T11-58-43-apple-m2-pro](results/2026-11-22T11-58-43-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The last row is a read: after every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be.

Warm, docstore answers 6 of the 11 goals fastest, because a tab reads on its own main thread from its page cache. SQLite is faster on 4: the column a sprint close emptied, the deep window, the open issues by priority, by 39%, and the open issues per person, by 15%. The runs do not separate the two on the issues per status. Cold, docstore is faster than SQLite on 4 of the 11 goals and slower on 4, and it is the slowest of the three stores on 6: a fresh tab loads from OPFS each 32 KB page its rows sit on, and the rows of one list are scattered over many pages. Open issues per person reads index entries alone, with no document, so cold it is the fastest of the three. The emptied column costs docstore the most: the deletes of the sprint close still sit above the settled runs, and the scan steps over each deleted entry until a compaction drops it. A deep window walks every index entry up to the window on docstore, whose index has no count to jump by: `offset` passes over them without copying a key or reading a document. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no statement once the schema exists, so its first query in a fresh tab also reads the schema. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch. The last column is SQLite's time over docstore's, both on demand.

<!-- bench:table live-queries -->
| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 180 ms | 81.6 ms | 8.51 ms | 58.1 ms | 6.8× |
| First answer: a project's todo column | 21.8 ms | 24.2 ms | 23.2 ms | 39.4 ms | 1.7× |
| First answer: open issues with a label | 16.7 ms | 16.8 ms | 26.1 ms | 34.8 ms | 1.3× |
| First answer: a person's open issues | 12.4 ms † | 12.5 ms | 5.75 ms | 8.25 ms | 1.4× |
| First answer: the 50 latest issues | 5.24 ms † | 3.36 ms | 9.41 ms | 10.2 ms | 1.1× |
| A sync batch, no screen open | 3.87 ms | 1.14 ms | 1.12 ms | 26.1 ms | 23× |
| A sync batch, four screens open | 6.66 ms | 4.02 ms | 5.92 ms | 119 ms | 20× |
| Frames dropped over 426 batches, screens open | 2 | 1 † | 27 † | 210 | |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 1.8 to 2.6, commit 1e24b5ec. Full results: [2026-11-22T12-07-20-apple-m2-pro](results/2026-11-22T12-07-20-apple-m2-pro.md).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds about 3 ms to a batch on IndexedDB, 3 ms on eager docstore and 5 ms on docstore on demand. On SQLite it adds 93 ms. A [CPU profile](results/2026-11-16T22-25-41-apple-m2-pro-cpu-profile.txt) of that phase, from an earlier run, shows the tab idle two thirds of the time, waiting for SQLite's worker, and decoding the rows the worker sends back is the largest share of the rest. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **19.5 kB** of JavaScript to your main bundle (gzip, 57.5 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 19.5 kB | 57.5 kB | at import |
| SharedWorker chunk | 13.5 kB | 41.2 kB | on the first `openDb` |
| wasm engine | 13.3 kB | 28.9 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **46.2 kB** | **127.6 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.1 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 26.8 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the main-thread JS passes 19.45 kB gzip or the after-open brotli total passes its budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
