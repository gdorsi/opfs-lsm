# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it. Under each table is the machine and the commit of its run. Every table here ran on an Apple M5 Max. Runs differ in load, so compare numbers inside one table, not across two.

## Storage calls

Each workload holds 100,000 entries with 16-byte keys and 100-byte values, except the two 8 KiB rows, which hold 6,000 values of 8 KiB under 40-byte keys. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. A rate is the operations over the time from the first storage call to the last, with the store open left out: the opens have their own rows. kv runs with `reserveBytes: 0`, not its default of 24 MiB, since the reserve file holds no data and would count in the disk bytes and its write would land in a timed phase. The bench builds its inputs before the first call and checks the results after the last, so the calls run back to back. A read of a missing key looks up a key that falls between two stored keys. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

<!-- bench:table storage-calls -->
| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 45.4k ops/s | 748k ops/s | 16× |
| Random point reads | 20.5k ops/s | 846k ops/s | 41× |
| Reads of missing keys | 22.6k ops/s | 1.58M ops/s | 70× |
| Full ordered scan | 635k ops/s | 4.76M ops/s | 7.5× |
| Seeks of 100 keys | 4.77k ops/s | 43.5k ops/s | 9.1× |
| Single put, awaited one at a time | 14.8k ops/s | 13.9k ops/s | 0.94× |
| Read-modify-write in one transaction | 0.111 ms | 0.0840 ms | 1.3× |
| Every 8 KiB value in a fresh tab, 500 neighbouring keys a read | 91.1k ops/s | 178k ops/s | 1.9× |
| Every 8 KiB value in a fresh tab, 500 scattered keys a read | 99.7k ops/s | 65.3k ops/s | 0.66× |
| Opening the database in a fresh tab | 24.5 ms | 9.14 ms | 2.7× |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.4 to 2.9, commit ce378c55. Full results: [2026-11-25T09-30-12-apple-m5-max](results/2026-11-25T09-30-12-apple-m5-max.md).
<!-- /bench:table -->

The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time. Over the whole mix, half of it reads, kv is ahead, at 23.9k against 17.0k ops/s. The two 8 KiB rows are `kv/large-values`: kv is faster when a read asks for neighbouring keys, and slower when its keys are scattered over the store. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`.

<!-- bench:table framework-adapters -->
| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Open and load 91,000 rows | 594 ms | 110 ms | 5.4× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 20.1k rows/s | 196k rows/s | 9.7× |
| TanStack DB | Serial insert, one row per transaction | 7.45k rows/s | 10.4k rows/s | 1.4× |
| Yjs | Cold load of 500 notes, store open and check included | 146 ms | 73.0 ms | 2.0× |
| Yjs | Editing trace written in one burst, 25,700 updates with no yield between keystrokes | 2.25k edits/s | 33.8k edits/s | 15× |
| Yjs | One keystroke typed at 60 Hz, main-thread time | 0.125 ms | 0.153 ms | 0.82× |
| Automerge | Cold load of 500 notes, store open and check included | 249 ms | 180 ms | 1.4× |
| Automerge | Write 500 notes | 947 notes/s | 996 notes/s | 1.1× |
| TanStack Query | Cold restore of 644 queries, open / restore | 7.22 ms / 6.22 ms | 12.8 ms / 5.09 ms | 0.57× / 1.2× |
| TanStack Query | Refetch of 10 queries, each persisted | 1.47 ms | 1.19 ms | 1.2× ‡ |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.6 to 2.9, commit ce378c55. Full results: [2026-11-25T09-42-46-apple-m5-max](results/2026-11-25T09-42-46-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).
<!-- /bench:table -->

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and, for TanStack Query, idb-keyval under its per-query persister. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode. Opening a collection loads its 91,000 rows, so that row is a time and the others are rates. The Yjs editing trace is a burst: 25,700 updates written with no yield between keystrokes, so kv's group commit folds them into few writes while y-indexeddb commits one transaction per update. The paced row below it is one keystroke typed at 60 Hz, which is what an editor feels. The TanStack Query rows restore a cache of 644 queries in a fresh tab, as the store's open then the restore, and then refetch 10 queries at a time, timed until their writes are stored.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. A keystroke is timed from the edit to the end of the task after it: what persistence costs the main thread, not the time until the write is stored. Then they open the document cold in a fresh tab, once before kv settles and once after, at size `small`. A cold open is the whole phase: it opens the store, loads the document and checks its text. The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

<!-- bench:table typing-reopening -->
| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, main-thread time | 0.125 ms | 0.153 ms | 0.292 ms | 0.308 ms | 0.82× | 0.95× ‡ |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | | |
| Cold open before the settle | 10.4 ms | 19.2 ms | 45.6 ms | 44.8 ms | 0.54× | 1.0× ‡ |
| Cold open after the settle | 9.82 ms | 29.2 ms | 44.9 ms | 44.4 ms | 0.34× | 1.0× ‡ |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.4 to 2.6, commit ce378c55. Full results: [2026-11-25T09-42-46-apple-m5-max](results/2026-11-25T09-42-46-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).
<!-- /bench:table -->

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 13.3 ms before the settle and 22.5 ms after for Yjs, 6.2 ms and 5.7 ms for Automerge.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite for filters made of equality and `in`, as [bench/README.md](../bench/README.md) describes. The page query filters with `gte` on `createdAt`, so SQLite still loads the owner's tail for it. Both collections hold 100,000 rows and load only what a query asks for.

<!-- bench:table on-demand-sqlite -->
| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 41.9 ms | 10.3 ms | 4.1× |
| First query after a cold open, 6,250 rows | 56.6 ms | 52.0 ms | 1.1× |
| Warm query of one owner, 6,250 rows | 148k rows/s | 294k rows/s | 2.0× |
| 10 rows by id | 2.43k queries/s | 5.71k queries/s | 2.3× |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.2 to 1.9, commit ce378c55. Full results: [2026-11-25T09-53-07-apple-m5-max](results/2026-11-25T09-53-07-apple-m5-max.md).
<!-- /bench:table -->

[bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster. The two board rows time the 6 reads a project's board asks for as it opens: the issues per status, a page of each of the 4 open statuses and the open issues per person. The first row starts the 6 in one task and times to the last answer, and the second awaits each before it starts the next.

<!-- bench:table goals -->
| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 3.99 / 2.27 | 4.08 / 0.142 † | 2.90 / 0.115 | 1.4× / 1.2× |
| First 50 todo issues, with assignee and label names | 2.17 / 0.813 | 5.19 / 0.416 | 2.87 / 0.187 | 1.8× / 2.2× |
| The column a sprint close just emptied | 8.13 / 4.53 | 4.60 / 0.177 † | 4.74 / 0.568 | 0.97× ‡ / 0.31× |
| Rows at 90% of a project's list | 10.6 / 6.08 | 4.62 / 0.284 | 7.24 / 0.257 | 0.64× / 1.1× |
| An issue with its comments and their authors | 2.00 / 0.352 | 4.61 / 0.207 | 4.49 / 0.0870 | 1.0× ‡ / 2.4× |
| First 50 open issues by priority, with comment counts | 4.72 / 2.00 | 5.34 / 0.331 | 8.43 / 0.378 | 0.63× / 0.88× |
| First 50 open issues with a label | 21.2 / 15.6 | 9.87 / 2.60 | 7.11 / 0.306 | 1.4× / 8.5× |
| First 50 open issues assigned to a person | 2.83 / 1.24 | 5.67 / 0.425 | 3.32 / 0.247 | 1.7× / 1.7× |
| The 50 most recently updated issues | 2.01 / 0.912 | 5.06 / 0.613 | 2.80 / 0.410 | 1.8× / 1.5× |
| Open issues per person, top 10 | 5.85 / 2.66 | 5.18 / 0.284 | 3.66 / 0.330 | 1.4× / 0.86× |
| First 20 issues whose title contains a word | 7.20 / 3.46 | 4.49 / 0.224 | 5.90 / 0.180 | 0.76× / 1.2× |
| A project's board, 6 reads started together | 9.79 / 6.37 | 8.98 / 1.57 | 6.03 / 0.761 | 1.5× / 2.1× |
| The same 6 reads, one after the other | 11.5 / 7.10 | 9.29 / 1.69 | 6.59 / 0.791 | 1.4× / 2.1× |
| Opening the store in a fresh tab, before the todo issues goal | 19.8 † | 24.3 | 18.3 | 1.3× |

Medians of 5 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.0 to 1.9, commit ce378c55. Full results: [2026-11-25T07-52-24-apple-m5-max](results/2026-11-25T07-52-24-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

<!-- bench:table writes -->
| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, mean of 47 batches of up to 1,000 rows | 40.1 ms | 16.5 ms | 9.16 ms | 1.8× |
| Sync, mean of 851 batches of about 50 changes | 4.10 ms | 10.8 ms | 1.71 ms | 6.3× |
| One edit | 0.270 ms | 3.61 ms | 0.213 ms | 17× |
| Sprint close, 1,054 issues in one batch | 97.7 ms | 51.8 ms | 29.4 ms | 1.8× |
| The 50 latest issues, read again after every 10th sync batch | 0.939 ms | 0.395 ms | 0.411 ms | 0.96× ‡ |

Medians of 5 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.0 to 1.9, commit ce378c55. Full results: [2026-11-25T07-52-24-apple-m5-max](results/2026-11-25T07-52-24-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).
<!-- /bench:table -->

The last row is a read: after every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be.

Warm, docstore answers 8 of the 11 goals fastest, because a tab reads on its own main thread from its cache. SQLite is faster on 3: the column a sprint close emptied, the open issues by priority and the open issues per person. Cold, docstore is faster than SQLite on 6 of the 11 goals and slower on 3, the deep window, the open issues by priority and the title search, and the runs do not separate the two on the emptied column and the issue with its comments. Three of the 6 are the todo issues, a person's issues and the recent issues: their index entries hold the fields of an issue card, so a fresh tab reads no issue document for them. On the other lists a fresh tab loads from OPFS each 32 KiB block its rows sit in, and the rows of one list are scattered over many blocks. docstore has the highest cold median of the three stores on one goal, the open issues by priority. The emptied column costs docstore the most: the deletes of the sprint close still sit above the settled runs, and the scan steps over each deleted entry until a compaction drops it. A deep window walks every index entry up to the window on docstore, whose index has no count to jump by: `offset` passes over them without copying a key or reading a document. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no statement once the schema exists, so its first query in a fresh tab also reads the schema. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

A board's 6 reads end sooner started together than one after the other on Dexie, cold and warm, by 1.2× and 1.1×. On docstore they end 1.1× sooner cold (6.03 ms against 6.59 ms), and warm the runs do not separate the two, since a warm read is work on the tab's main thread with nothing to wait for. On SQLite the warm board takes 1.57 ms together against 1.69 ms in turn, and cold the runs do not separate the two.

### At 200,000 issues

A larger workspace from the same simulation, against Dexie: 200,000 issues, 600 people, 120 projects and 60 labels. Its sprint close holds about 7,500 issues, which docstore writes in batches of 1,000 events, and those writes sit above the stored data when the goals run. Each cell is cold / warm in ms, as above. The last column is Dexie's time over docstore's: above 1×, docstore is faster.

<!-- bench:table goals-large -->
| Goal | Dexie | docstore | docstore vs Dexie |
| --- | ---: | ---: | ---: |
| Issues per status in a project | 8.81 / 7.76 | 2.46 / 0.119 | 3.6× / 65× |
| First 50 todo issues, with assignee and label names | 2.82 / 0.969 | 3.36 / 0.212 | 0.84× / 4.6× |
| The column a sprint close just emptied | 56.5 / 57.0 | 8.18 / 1.55 | 6.9× / 37× |
| Rows at 90% of a project's list | 21.7 / 21.2 | 11.4 / 0.344 | 1.9× / 61× |
| An issue with its comments and their authors | 1.96 / 0.367 | 4.58 / 0.101 | 0.43× / 3.6× |
| First 50 open issues by priority, with comment counts | 8.78 / 6.29 | 14.6 / 0.361 | 0.60× / 17× |
| First 50 open issues with a label | 12.5 / 8.92 | 10.6 / 0.291 | 1.2× / 31× |
| First 50 open issues assigned to a person | 4.05 / 1.60 | 3.67 / 0.266 | 1.1× ‡ / 6.0× |
| The 50 most recently updated issues | 2.02 / 0.988 | 3.44 / 0.463 | 0.59× / 2.1× |
| Open issues per person, top 10 | 8.86 / 5.53 | 4.96 / 0.511 | 1.8× / 11× |
| First 20 issues whose title contains a word | 7.70 / 3.62 | 7.24 / 0.173 | 1.1× / 21× |
| A project's board, 6 reads started together | 14.8 / 12.8 | 6.67 / 0.997 | 2.2× / 13× |
| The same 6 reads, one after the other | 17.2 / 13.1 | 7.42 / 0.996 | 2.3× / 13× |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.1 to 2.0, commit ce378c55. Full results: [2026-11-25T08-47-47-apple-m5-max](results/2026-11-25T08-47-47-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).
<!-- /bench:table -->

Warm, docstore is faster than Dexie on all 11 goals, from 2.1× to 65×. Cold, it is faster on 6 and slower on 4, the todo issues, the issue with its comments, the open issues by priority and the recent issues, and the runs do not separate the two on a person's open issues. IndexedDB cannot put an array field, the issue's labels, in one index with other fields. So Dexie walks the project's issues newest first, tests each one's labels and status, and stops after 50 matches, which reads more issues the rarer the label is. docstore's index holds the label, the project, the status and the update time, so it walks the entries of each open status newest first, together, and stops after 50 issues. Started together, the board's 6 reads end sooner than in turn on both stores when cold, by 1.2× on Dexie and 1.1× on docstore. Warm, docstore's times are equal and the runs do not separate Dexie's.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch. The last column is SQLite's time over docstore's, both on demand.

<!-- bench:table live-queries -->
| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 161 ms | 54.0 ms | 8.99 ms | 54.6 ms | 6.1× |
| First answer: a project's todo column | 15.6 ms | 17.4 ms | 17.1 ms | 27.8 ms | 1.6× |
| First answer: open issues with a label | 12.4 ms | 12.0 ms | 16.3 ms | 23.8 ms | 1.5× |
| First answer: a person's open issues | 10.6 ms | 8.76 ms | 4.02 ms | 5.98 ms | 1.5× |
| First answer: the 50 latest issues | 2.27 ms | 2.33 ms | 6.50 ms | 7.36 ms | 1.1× |
| A sync batch, no screen open | 2.32 ms | 0.670 ms | 0.643 ms | 12.7 ms | 20× |
| A sync batch, four screens open | 4.08 ms | 2.56 ms | 3.74 ms | 76.4 ms | 20× |
| Frames dropped over 426 batches, screens open | 0 | 0.5 | 8.5 | 70 | |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.8 to 3.0, commit ce378c55. Full results: [2026-11-25T09-58-56-apple-m5-max](results/2026-11-25T09-58-56-apple-m5-max.md).
<!-- /bench:table -->

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds about 2 ms to a batch on IndexedDB, 2 ms on eager docstore and 3 ms on docstore on demand. On SQLite it adds 64 ms. A [CPU profile](results/2026-11-16T22-25-41-apple-m2-pro-cpu-profile.txt) of that phase, from an earlier run, shows the tab idle two thirds of the time, waiting for SQLite's worker, and decoding the rows the worker sends back is the largest share of the rest. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **19.4 kB** of JavaScript to your main bundle (gzip, 56.5 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 19.4 kB | 56.5 kB | at import |
| SharedWorker chunk | 13.8 kB | 41.1 kB | on the first `openDb` |
| wasm engine | 6.6 kB | 16.3 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **39.8 kB** | **114.0 kB** | |

For comparison, Dexie is 31.3 kB gzip and `y-indexeddb` adds 1.1 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 20.4 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the main-thread JS passes 19.7 kB gzip or the after-open brotli total passes its budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
