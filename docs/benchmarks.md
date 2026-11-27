# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it. Under each table is the machine and the commit of its run. Every table here ran on an Apple M5 Max. Runs differ in load, so compare numbers inside one table, not across two.

## Storage calls

Each workload holds 100,000 entries with 16-byte keys and 100-byte values, except the two 8 KiB rows, which hold 6,000 values of 8 KiB under 40-byte keys. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. A rate is the operations over the time from the first storage call to the last, with the store open left out: the opens have their own rows. kv runs with `reserveBytes: 0`, not its default of 24 MiB, since the reserve file holds no data and would count in the disk bytes and its write would land in a timed phase. The bench builds its inputs before the first call and checks the results after the last, so the calls run back to back. A read of a missing key looks up a key that falls between two stored keys. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

<!-- bench:table storage-calls -->
| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 42.9k ops/s | 718k ops/s | 17× |
| Random point reads | 20.0k ops/s | 907k ops/s | 45× |
| Reads of missing keys | 23.7k ops/s | 1.97M ops/s | 83× |
| Full ordered scan | 636k ops/s | 4.82M ops/s | 7.6× |
| Seeks of 100 keys | 4.93k ops/s | 44.7k ops/s | 9.1× |
| Single put, awaited one at a time | 14.6k ops/s | 13.1k ops/s | 0.90× |
| Read-modify-write in one transaction | 0.115 ms | 0.0875 ms | 1.3× |
| Every 8 KiB value in a fresh tab, 500 neighbouring keys a read | 90.4k ops/s | 181k ops/s | 2.0× |
| Every 8 KiB value in a fresh tab, 500 scattered keys a read | 102k ops/s | 66.0k ops/s | 0.65× |
| Opening the database in a fresh tab | 23.7 ms | 7.72 ms | 3.1× |
| The first read after that open | 0.243 ms | 1.22 ms | 0.20× |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.0 to 3.0, commit 36e2977a. Full results: [2026-11-27T08-53-38-apple-m5-max](results/2026-11-27T08-53-38-apple-m5-max.md).

No cell of fewer than 5 runs is checked for two clusters, so a median here can hide two states.
<!-- /bench:table -->

The open of the last two rows reads the newest manifest and opens the runs while IndexedDB opens ([research note](research/open-path-round-trips.md#ahead-of-indexeddb-2026-11-26)).

The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time. Over the whole mix, half of it reads, kv is ahead, at 23.2k against 16.4k ops/s. The two 8 KiB rows are `kv/large-values`: kv is faster when a read asks for neighbouring keys, and slower when its keys are scattered over the store. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`.

<!-- bench:table framework-adapters -->
| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Open and load 91,000 rows | 591 ms | 108 ms | 5.5× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 20.3k rows/s | 195k rows/s | 9.6× |
| TanStack DB | Serial insert, one row per transaction | 7.23k rows/s | 10.2k rows/s | 1.4× |
| Yjs | Cold load of 500 notes, store open and check included | 142 ms | 72.3 ms | 2.0× |
| Yjs | Editing trace written in one burst, 25,700 updates with no yield between keystrokes | 2.24k edits/s | 34.5k edits/s | 15× |
| Yjs | One keystroke typed at 60 Hz, main-thread time | 0.116 ms | 0.146 ms | 0.79× |
| Automerge | Cold load of 500 notes, store open and check included | 250 ms | 180 ms | 1.4× |
| Automerge | Write 500 notes | 947 notes/s | 1.01k notes/s | 1.1× |
| TanStack Query | Cold restore of 644 queries, open / restore | 7.26 ms / 6.28 ms | 11.9 ms / 5.02 ms | 0.61× / 1.3× |
| TanStack Query | Refetch of 10 queries, each persisted | 1.46 ms | 1.03 ms | 1.4× |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.0 to 2.2, commit 36e2977a. Full results: [2026-11-27T09-06-08-apple-m5-max](results/2026-11-27T09-06-08-apple-m5-max.md).

No cell of fewer than 5 runs is checked for two clusters, so a median here can hide two states.
<!-- /bench:table -->

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and, for TanStack Query, idb-keyval under its per-query persister. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode. Opening a collection loads its 91,000 rows, so that row is a time and the others are rates. The Yjs editing trace is a burst: 25,700 updates written with no yield between keystrokes, so kv's group commit folds them into few writes while y-indexeddb commits one transaction per update. The paced row below it is one keystroke typed at 60 Hz, which is what an editor feels. The TanStack Query rows restore a cache of 644 queries in a fresh tab, as the store's open then the restore, and then refetch 10 queries at a time, timed until their writes are stored.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. A keystroke is timed from the edit to the end of the task after it: what persistence costs the main thread, not the time until the write is stored. Then they open the document cold in a fresh tab, once before kv settles and once after, at size `small`. A cold open is the whole phase: it opens the store, loads the document and checks its text. The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

<!-- bench:table typing-reopening -->
| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, main-thread time | 0.118 ms | 0.153 ms | 0.294 ms | 0.302 ms | 0.77× ‡ | 0.98× ‡ |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | | |
| Cold open before the settle | 10.9 ms | 20.0 ms | 48.5 ms † | 41.1 ms † | 0.55× | 1.2× ‡ |
| Cold open after the settle | 10.1 ms | 29.3 ms | 48.8 ms † | 40.7 ms † | 0.34× | 1.2× ‡ |

Medians of 5 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.2 to 2.5, commit f96c5229. Full results: [2026-11-27T11-11-09-apple-m5-max](results/2026-11-27T11-11-09-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 13.9 ms before the settle and 22.3 ms after for Yjs, 6.6 ms and 5.6 ms for Automerge.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite for filters made of equality and `in`, as [bench/README.md](../bench/README.md) describes. The page query filters with `gte` on `createdAt`, so SQLite still loads the owner's tail for it. Both collections hold 100,000 rows and load only what a query asks for.

<!-- bench:table on-demand-sqlite -->
| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 40.0 ms | 9.14 ms | 4.4× |
| First query after a cold open, 6,250 rows | 56.5 ms | 53.3 ms | 1.1× |
| Warm query of one owner, 6,250 rows | 148k rows/s | 295k rows/s | 2.0× |
| 10 rows by id | 2.41k queries/s | 6.12k queries/s | 2.5× |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.9 to 2.6, commit 36e2977a. Full results: [2026-11-27T09-16-26-apple-m5-max](results/2026-11-27T09-16-26-apple-m5-max.md).

No cell of fewer than 5 runs is checked for two clusters, so a median here can hide two states.
<!-- /bench:table -->

[bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster. The two board rows time the 6 reads a project's board asks for as it opens: the issues per status, a page of each of the 4 open statuses and the open issues per person. The first row starts the 6 in one task and times to the last answer, and the second awaits each before it starts the next.

<!-- bench:table goals -->
| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 4.04 / 2.01 | 4.09 / 0.147 | 2.64 / 0.118 | 1.6× / 1.2× |
| First 50 todo issues, with assignee and label names | 2.22 / 0.808 | 5.18 / 0.415 | 2.78 / 0.180 | 1.9× / 2.3× |
| The column a sprint close just emptied | 7.78 / 4.40 | 4.57 / 0.178 | 4.30 / 0.634 | 1.1× / 0.28× |
| Rows at 90% of a project's list | 10.4 / 5.95 | 4.67 / 0.289 | 7.37 / 0.257 | 0.63× / 1.1× |
| An issue with its comments and their authors | 2.02 / 0.360 | 4.61 / 0.229 | 4.02 / 0.0890 | 1.1× / 2.6× |
| First 50 open issues by priority, with comment counts | 4.77 / 1.98 | 5.38 / 0.325 | 8.69 / 0.347 | 0.62× / 0.94× ‡ |
| First 50 open issues with a label | 21.0 / 15.6 | 9.49 / 2.60 | 6.91 / 0.305 | 1.4× / 8.5× |
| First 50 open issues assigned to a person | 2.80 / 1.24 | 5.74 / 0.425 | 3.24 / 0.252 | 1.8× / 1.7× |
| The 50 most recently updated issues | 1.99 / 0.902 | 5.11 / 0.601 | 2.65 / 0.477 | 1.9× / 1.3× ‡ |
| Open issues per person, top 10 | 5.90 / 2.68 | 5.22 / 0.291 | 3.47 / 0.330 | 1.5× / 0.88× |
| First 20 issues whose title contains a word | 7.18 / 3.44 | 4.47 / 0.213 | 5.89 / 0.171 | 0.76× / 1.2× |
| A project's board, 6 reads started together | 9.73 / 6.35 | 8.76 / 1.57 | 5.81 / 0.759 | 1.5× / 2.1× |
| The same 6 reads, one after the other | 11.7 / 7.07 | 9.13 / 1.66 | 6.50 / 0.770 | 1.4× / 2.2× |
| Opening the store in a fresh tab, before the todo issues goal | 19.8 | 24.2 | 16.9 | 1.4× |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 0.9 to 1.6, commit 36e2977a. Full results: [2026-11-27T09-21-52-apple-m5-max](results/2026-11-27T09-21-52-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

No cell of fewer than 5 runs is checked for two clusters, so a median here can hide two states.
<!-- /bench:table -->

<!-- bench:table writes -->
| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, mean of 47 batches of up to 1,000 rows | 39.4 ms | 15.4 ms | 8.66 ms | 1.8× |
| Sync, mean of 851 batches of about 50 changes | 4.05 ms | 10.2 ms | 1.57 ms | 6.5× |
| One edit | 0.296 ms | 2.54 ms | 0.204 ms | 12× |
| Sprint close, 1,054 issues in one batch | 88.9 ms | 51.5 ms | 25.3 ms | 2.0× |
| The 50 latest issues, read again after every 10th sync batch | 0.915 ms | 0.402 ms | 0.405 ms | 0.99× ‡ |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 0.9 to 1.6, commit 36e2977a. Full results: [2026-11-27T09-21-52-apple-m5-max](results/2026-11-27T09-21-52-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

No cell of fewer than 5 runs is checked for two clusters, so a median here can hide two states.
<!-- /bench:table -->

The last row is a read: after every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be.

Warm, docstore is faster than SQLite on 7 of the 11 goals, because a tab reads on its own main thread from its cache. SQLite is faster on 2, the column a sprint close emptied and the open issues per person, and the runs do not separate the two on the open issues by priority and the recent issues. Cold, docstore is faster than SQLite on 8 of the 11 goals and slower on 3, the deep window, the open issues by priority and the title search. Three of the 8 are the todo issues, a person's issues and the recent issues: their index entries hold the fields of an issue card, so a fresh tab reads no issue document for them. On the other lists a fresh tab loads from OPFS each 32 KiB block its rows sit in, and the rows of one list are scattered over many blocks. docstore has the highest cold median of the three stores on one goal, the open issues by priority. The emptied column costs docstore the most: the deletes of the sprint close still sit above the settled runs, and the scan steps over each deleted entry until a compaction drops it. A deep window walks every index entry up to the window on docstore, whose index has no count to jump by: `offset` passes over them without copying a key or reading a document. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no statement once the schema exists, so its first query in a fresh tab also reads the schema. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

A board's 6 reads end sooner started together than one after the other on Dexie, cold and warm, by 1.2× and 1.1×. On docstore they end 1.1× sooner cold (5.81 ms against 6.50 ms), and warm the runs do not separate the two, since a warm read is work on the tab's main thread with nothing to wait for. On SQLite the warm board takes 1.57 ms together against 1.66 ms in turn, and cold the runs do not separate the two.

### At 200,000 issues

A larger workspace from the same simulation, against Dexie: 200,000 issues, 600 people, 120 projects and 60 labels. Its sprint close holds about 7,500 issues, which docstore writes in batches of 1,000 events, and those writes sit above the stored data when the goals run. Each cell is cold / warm in ms, as above. The last column is Dexie's time over docstore's: above 1×, docstore is faster.

<!-- bench:table goals-large -->
| Goal | Dexie | docstore | docstore vs Dexie |
| --- | ---: | ---: | ---: |
| Issues per status in a project | 9.23 / 7.46 | 2.42 / 0.115 | 3.8× / 65× |
| First 50 todo issues, with assignee and label names | 3.05 / 1.03 | 3.42 / 0.212 | 0.89× / 4.9× |
| The column a sprint close just emptied | 59.2 / 60.0 | 8.98 / 1.60 | 6.6× / 38× |
| Rows at 90% of a project's list | 21.5 / 17.6 | 11.7 / 0.311 | 1.8× / 57× |
| An issue with its comments and their authors | 2.25 / 0.414 | 4.83 / 0.0973 | 0.47× / 4.3× |
| First 50 open issues by priority, with comment counts | 9.49 / 6.24 | 15.9 / 0.368 | 0.60× / 17× |
| First 50 open issues with a label | 14.1 / 9.20 | 11.5 / 0.302 | 1.2× / 30× |
| First 50 open issues assigned to a person | 4.35 / 1.52 | 3.83 / 0.263 | 1.1× / 5.8× |
| The 50 most recently updated issues | 2.24 / 1.07 | 3.59 / 0.459 | 0.63× / 2.3× |
| Open issues per person, top 10 | 9.70 / 5.49 | 4.92 / 0.523 | 2.0× / 11× |
| First 20 issues whose title contains a word | 8.99 / 3.88 | 7.68 / 0.187 | 1.2× / 21× |
| A project's board, 6 reads started together | 16.1 / 11.6 | 6.99 / 1.02 | 2.3× / 11× |
| The same 6 reads, one after the other | 17.8 / 12.4 | 7.70 / 1.00 | 2.3× / 12× |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.0 to 2.1, commit 36e2977a. Full results: [2026-11-27T10-21-01-apple-m5-max](results/2026-11-27T10-21-01-apple-m5-max.md).

No cell of fewer than 5 runs is checked for two clusters, so a median here can hide two states.
<!-- /bench:table -->

Warm, docstore is faster than Dexie on all 11 goals, from 2.3× to 65×. Cold, it is faster on 7 and slower on 4, the todo issues, the issue with its comments, the open issues by priority and the recent issues. IndexedDB cannot put an array field, the issue's labels, in one index with other fields. So Dexie walks the project's issues newest first, tests each one's labels and status, and stops after 50 matches, which reads more issues the rarer the label is. docstore's index holds the label, the project, the status and the update time, so it walks the entries of each open status newest first, together, and stops after 50 issues. Started together, the board's 6 reads end sooner than in turn on both stores when cold, by 1.1× on each. Warm, the runs do not separate the two on either store.

The writes that build this workspace: the import of the first 70% of the history, then 8,729 sync batches with no pause between them.

<!-- bench:table writes-large -->
| Writes | Dexie | docstore | docstore vs Dexie |
| --- | ---: | ---: | ---: |
| Import, mean of 442 batches of up to 1,000 rows | 51.4 ms | 14.2 ms | 3.6× |
| Sync, mean of 8,729 batches of about 50 changes | 9.79 ms | 2.61 ms | 3.8× |
| One edit | 0.672 ms | 0.286 ms | 2.4× |
| The 50 latest issues, read again after every 10th sync batch | 1.30 ms | 0.516 ms | 2.5× |

Medians of 4 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.0 to 2.1, commit 36e2977a. Full results: [2026-11-27T10-21-01-apple-m5-max](results/2026-11-27T10-21-01-apple-m5-max.md).

No cell of fewer than 5 runs is checked for two clusters, so a median here can hide two states.
<!-- /bench:table -->

The whole replay runs at 28.8k changes a second on docstore against 7,961 on Dexie. It writes faster than kv compacts, so a few batches wait for a compaction step: the slowest 0.1% of docstore's sync batches take 303 ms or more, and its slowest took 501 ms, against 52.2 ms and 101 ms on Dexie. [The research note](research/compaction-file-waits.md) has what such a batch waits for.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch. The last column is SQLite's time over docstore's, both on demand.

<!-- bench:table live-queries -->
| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 157 ms | 52.5 ms | 7.99 ms | 48.1 ms | 6.0× |
| First answer: a project's todo column | 15.5 ms | 17.2 ms | 16.9 ms | 21.1 ms | 1.2× |
| First answer: open issues with a label | 12.3 ms | 11.7 ms | 16.3 ms | 24.6 ms | 1.5× |
| First answer: a person's open issues | 10.6 ms | 8.65 ms | 4.05 ms | 6.05 ms | 1.5× |
| First answer: the 50 latest issues | 2.29 ms | 2.27 ms | 6.55 ms | 7.21 ms | 1.1× |
| A sync batch, no screen open | 2.39 ms | 0.683 ms | 0.645 ms | 12.3 ms | 19× |
| A sync batch, four screens open | 4.08 ms | 2.53 ms | 3.71 ms | 30.2 ms | 8.1× |
| Frames dropped over 426 batches, screens open | 0 | 0 | 9 | 7 † | |

Medians of 5 runs per contender, in headless Chrome 158 on Apple M5 Max, load average 1.3 to 5.5, commit 6d745547. Full results: [2026-11-27T05-43-39-apple-m5-max](results/2026-11-27T05-43-39-apple-m5-max.md).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds about 2 ms to a batch on IndexedDB, 2 ms on eager docstore and 3 ms on docstore on demand. On SQLite it adds 18 ms. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **19.7 kB** of JavaScript to your main bundle (gzip, 56.7 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 19.7 kB | 56.7 kB | at import |
| SharedWorker chunk | 13.7 kB | 40.0 kB | on the first `openDb` |
| wasm engine | 6.6 kB | 16.2 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **40.0 kB** | **112.9 kB** | |

For comparison, Dexie is 31.3 kB gzip and `y-indexeddb` adds 1.1 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 20.3 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the main-thread JS passes 19.8 kB gzip or the after-open brotli total passes its budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
