# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it. Under each table is the machine and the commit of its run. Every table here ran on an Apple M2 Pro that other work shared, so the load average under a table is high and some cells split into two clusters. Runs differ in load, so compare numbers inside one table, not across two.

## Storage calls

Each workload holds 100,000 entries with 16-byte keys and 100-byte values, except the two 8 KiB rows, which hold 6,000 values of 8 KiB under 40-byte keys. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. A rate is the operations over the time from the first storage call to the last, opening the store included. The bench builds its inputs before the first call and checks the results after the last, so the calls run back to back. A read of a missing key looks up a key that falls between two stored keys. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

<!-- bench:table storage-calls -->
| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 22.7k ops/s | 392k ops/s † | 17× |
| Random point reads | 15.2k ops/s † | 450k ops/s | 30× |
| Reads of missing keys | 17.3k ops/s | 1.02M ops/s † | 59× |
| Full ordered scan | 384k ops/s | 1.88M ops/s | 4.9× |
| Seeks of 100 keys | 3.25k ops/s † | 13.5k ops/s | 4.1× |
| Single put, awaited one at a time | 9.05k ops/s | 7.63k ops/s † | 0.84× ‡ |
| Read-modify-write in one transaction | 0.187 ms † | 0.172 ms | 1.1× ‡ |
| Every 8 KiB value in a fresh tab, 500 neighbouring keys a read | 51.8k ops/s † | 88.7k ops/s | 1.7× |
| Every 8 KiB value in a fresh tab, 500 scattered keys a read | 60.6k ops/s | 33.3k ops/s | 0.55× |
| Opening the database in a fresh tab | 0.317 ms | 5.44 ms | 0.058× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 5.6 to 15.6, commit 694d5abe. Full results: [2026-11-21T13-16-06-apple-m2-pro](results/2026-11-21T13-16-06-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time: the runs do not separate kv's from IndexedDB's. Over the whole mix, half of it reads, kv is ahead, at 11.2k against 7.32k ops/s. The two 8 KiB rows are `kv/large-values`: kv is faster when a read asks for neighbouring keys, and slower when its keys are scattered over the store. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`.

<!-- bench:table framework-adapters -->
| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Open and load 91,000 rows | 1.02 s † | 299 ms † | 3.4× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 9.80k rows/s † | 105k rows/s | 11× |
| TanStack DB | Serial insert, one row per transaction | 3.30k rows/s † | 5.04k rows/s | 1.5× ‡ |
| Yjs | Cold load of 500 notes | 1.90k notes/s † | 8.78k notes/s † | 4.6× |
| Yjs | Editing trace written in one burst, 25,700 updates with no yield between keystrokes | 2.13k edits/s † | 18.5k edits/s | 8.7× |
| Yjs | One keystroke typed at 60 Hz, with its persistence | 0.130 ms † | 0.156 ms † | 0.83× ‡ |
| Automerge | Cold load of 500 notes | 1.33k notes/s | 2.02k notes/s | 1.5× |
| Automerge | Write 500 notes | 627 notes/s | 668 notes/s | 1.1× |
| fate | Cold load of 100 lists of 100 records | 1.18k records/s | 3.14k records/s | 2.7× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 2.8 to 18.5, commit 694d5abe. Full results: [2026-11-21T13-51-06-apple-m2-pro](results/2026-11-21T13-51-06-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and `@nkzw/fate-indexeddb`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode. Opening a collection loads its 91,000 rows, so that row is a time and the others are rates. The Yjs editing trace is a burst: 25,700 updates written with no yield between keystrokes, so kv's group commit folds them into few writes while y-indexeddb commits one transaction per update. The paced row below it is one keystroke typed at 60 Hz, which is what an editor feels.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. Then they open the document cold in a fresh tab, once before kv settles and once after, at size `small`. A cold open is the whole phase: it opens the store, loads the document and checks its text. The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

<!-- bench:table typing-reopening -->
| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, with its persistence | 0.130 ms † | 0.156 ms † | 0.288 ms † | 0.521 ms † | 0.83× ‡ | 0.55× ‡ |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | | |
| Cold open before the settle | 8.36 ms | 16.5 ms | 59.0 ms | 63.6 ms | 0.50× | 0.93× |
| Cold open after the settle | 8.20 ms | 16.5 ms | 58.8 ms | 66.3 ms | 0.50× | 0.89× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 2.6 to 17.5, commit 694d5abe. Full results: [2026-11-21T13-51-06-apple-m2-pro](results/2026-11-21T13-51-06-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 7.3 ms before the settle and 7.3 ms after for Yjs, 5.2 ms and 5.6 ms for Automerge.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite for filters made of equality and `in`, as [bench/README.md](../bench/README.md) describes. The page query filters with `gte` on `createdAt`, so SQLite still loads the owner's tail for it. Both collections hold 100,000 rows and load only what a query asks for.

<!-- bench:table on-demand-sqlite -->
| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 85.8 ms | 12.6 ms | 6.8× |
| First query after a cold open, 6,250 rows | 92.2 ms | 97.2 ms † | 0.95× ‡ |
| Warm query of one owner, 6,250 rows | 89.9k rows/s | 160k rows/s | 1.8× |
| 10 rows by id | 1.29k queries/s | 2.91k queries/s | 2.3× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 5.5 to 21.0, commit 694d5abe. Full results: [2026-11-21T14-04-55-apple-m2-pro](results/2026-11-21T14-04-55-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

[bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster.

<!-- bench:table goals -->
| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 4.54 / 3.30 | 5.34 / 0.196 | 4.93 / 0.192 † | 1.1× ‡ / 1.0× ‡ |
| First 50 todo issues, with assignee and label names | 2.35 / 1.24 | 7.03 / 0.543 | 10.0 / 0.375 | 0.70× / 1.4× |
| The column a sprint close just emptied | 8.35 / 5.87 | 5.90 / 0.312 | 6.14 / 0.772 | 0.96× ‡ / 0.40× |
| Rows at 90% of a project's list | 11.4 † / 10.4 † | 6.22 / 0.368 | 11.0 / 0.414 | 0.56× / 0.89× |
| An issue with its comments and their authors | 1.70 / 0.479 | 6.19 / 0.294 | 6.82 / 0.134 | 0.91× / 2.2× |
| First 50 open issues by priority, with comment counts | 4.69 / 2.63 | 7.25 / 0.422 | 14.9 / 0.832 | 0.49× / 0.51× |
| First 50 open issues with a label | 29.1 / 26.1 | 13.3 / 4.21 | 12.2 / 0.567 | 1.1× ‡ / 7.4× |
| First 50 open issues assigned to a person | 2.96 / 1.65 | 7.74 / 0.574 | 12.6 / 0.622 | 0.62× / 0.92× ‡ |
| The 50 most recently updated issues | 2.34 / 1.24 † | 6.74 / 0.787 | 5.15 / 0.542 | 1.3× / 1.5× |
| Open issues per person, top 10 | 6.15 / 3.73 | 6.98 / 0.367 | 5.88 / 0.438 | 1.2× / 0.84× |
| First 20 issues whose title contains a word | 7.22 / 5.02 | 7.03 / 0.640 | 8.07 / 0.283 | 0.87× / 2.3× |
| Opening the store in a fresh tab, before the todo issues goal | 2.36 | 27.1 | 14.8 | 1.8× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 4.4 to 11.9, commit 694d5abe. Full results: [2026-11-21T14-18-57-apple-m2-pro](results/2026-11-21T14-18-57-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

<!-- bench:table writes -->
| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, mean of 47 batches of up to 1,000 rows | 63.9 ms | 21.2 ms | 13.9 ms | 1.5× |
| Sync, mean of 851 batches of about 50 changes | 6.86 ms | 13.3 ms | 2.77 ms | 4.8× |
| One edit | 0.428 ms | 1.17 ms | 0.337 ms | 3.5× |
| Sprint close, 1,054 issues in one batch | 161 ms | 64.4 ms | 46.7 ms | 1.4× |
| The 50 latest issues, read again after every 10th sync batch | 1.45 ms | 0.584 ms | 0.577 ms | 1.0× ‡ |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 4.4 to 11.9, commit 694d5abe. Full results: [2026-11-21T14-18-57-apple-m2-pro](results/2026-11-21T14-18-57-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).
<!-- /bench:table -->

The last row is a read: after every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be.

Warm, docstore answers 5 of the 11 goals fastest, because a tab reads on its own main thread from its page cache. SQLite is faster on 4: the column a sprint close emptied, the deep window, the open issues by priority, by 49%, and the open issues per person, by 16%. The runs do not separate the two on the issues per status and on a person's open issues. Cold, docstore is faster than SQLite on 2 of the 11 goals and slower on 6, and it is the slowest of the three stores on 5: a fresh tab loads from OPFS each 32 KB page its rows sit on, and the rows of one list are scattered over many pages. Open issues per person reads index entries alone, with no document, so cold it is the fastest of the three. The emptied column costs docstore the most: the deletes of the sprint close still sit above the settled runs, and the scan steps over each deleted entry until a compaction drops it. A deep window walks every index entry up to the window on docstore, whose index has no count to jump by: `offset` passes over them without copying a key or reading a document. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no statement once the schema exists, so its first query in a fresh tab also reads the schema. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch. The last column is SQLite's time over docstore's, both on demand.

<!-- bench:table live-queries -->
| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 210 ms | 95.4 ms | 11.1 ms | 71.7 ms | 6.5× |
| First answer: a project's todo column | 23.3 ms | 24.4 ms | 24.8 ms | 42.8 ms | 1.7× |
| First answer: open issues with a label | 17.8 ms | 17.9 ms | 29.0 ms | 41.2 ms | 1.4× |
| First answer: a person's open issues | 13.1 ms | 12.8 ms | 6.24 ms | 8.51 ms | 1.4× |
| First answer: the 50 latest issues | 5.36 ms | 3.35 ms | 9.85 ms | 10.4 ms | 1.1× ‡ |
| A sync batch, no screen open | 4.52 ms | 1.32 ms † | 1.58 ms | 28.3 ms | 18× |
| A sync batch, four screens open | 8.68 ms | 4.66 ms | 6.80 ms | 128 ms | 19× |
| Frames dropped over 426 batches, screens open | 2 | 1 † | 31 | 288 | |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 3.2 to 16.0, commit 694d5abe. Full results: [2026-11-21T15-13-18-apple-m2-pro](results/2026-11-21T15-13-18-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds about 4 ms to a batch on IndexedDB, 3 ms on eager docstore and 5 ms on docstore on demand. On SQLite it adds 100 ms. A [CPU profile](results/2026-11-16T22-25-41-apple-m2-pro-cpu-profile.txt) of that phase, from an earlier run, shows the tab idle two thirds of the time, waiting for SQLite's worker, and decoding the rows the worker sends back is the largest share of the rest. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **19.4 kB** of JavaScript to your main bundle (gzip, 57.4 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 19.4 kB | 57.4 kB | at import |
| SharedWorker chunk | 13.5 kB | 41.2 kB | on the first `openDb` |
| wasm engine | 13.3 kB | 28.9 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **46.2 kB** | **127.5 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.1 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 26.8 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the main-thread JS passes 19.45 kB gzip or the after-open brotli total passes its budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
