# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it. Under each table is the machine and the commit of its run. Every table here ran on an Apple M2 Pro, except the goal benchmarks, which ran on an Apple M5 Max. Other work shared the machines during some runs, so the load average under a table can be high and some cells split into two clusters. Runs differ in load, so compare numbers inside one table, not across two.

## Storage calls

Each workload holds 100,000 entries with 16-byte keys and 100-byte values, except the two 8 KiB rows, which hold 6,000 values of 8 KiB under 40-byte keys. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. A rate is the operations over the time from the first storage call to the last, with the store open left out: the opens have their own rows. kv runs with `reserveBytes: 0`, not its default of 24 MiB, since the reserve file holds no data and would count in the disk bytes and its write would land in a timed phase. The bench builds its inputs before the first call and checks the results after the last, so the calls run back to back. A read of a missing key looks up a key that falls between two stored keys. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

<!-- bench:table storage-calls -->
| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 28.0k ops/s | 391k ops/s | 14× |
| Random point reads | 16.5k ops/s | 506k ops/s | 31× |
| Reads of missing keys | 15.5k ops/s | 1.00M ops/s | 65× |
| Full ordered scan | 379k ops/s | 3.09M ops/s | 8.1× |
| Seeks of 100 keys | 3.18k ops/s | 29.0k ops/s | 9.1× |
| Single put, awaited one at a time | 9.24k ops/s | 7.89k ops/s | 0.85× |
| Read-modify-write in one transaction | 0.181 ms | 0.139 ms | 1.3× |
| Every 8 KiB value in a fresh tab, 500 neighbouring keys a read | 53.4k ops/s | 93.7k ops/s | 1.8× |
| Every 8 KiB value in a fresh tab, 500 scattered keys a read | 59.9k ops/s | 34.3k ops/s | 0.57× |
| Opening the database in a fresh tab | 0.348 ms | 5.55 ms | 0.063× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 3.6 to 6.2, commit 9be92034. Full results: [2026-11-22T15-56-51-apple-m2-pro](results/2026-11-22T15-56-51-apple-m2-pro.md).
<!-- /bench:table -->

The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time. Over the whole mix, half of it reads, kv is ahead, at 13.9k against 7.78k ops/s. The two 8 KiB rows are `kv/large-values`: kv is faster when a read asks for neighbouring keys, and slower when its keys are scattered over the store. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`.

<!-- bench:table framework-adapters -->
| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Open and load 91,000 rows | 1.02 s † | 299 ms † | 3.4× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 9.80k rows/s † | 105k rows/s | 11× |
| TanStack DB | Serial insert, one row per transaction | 3.30k rows/s † | 5.04k rows/s | 1.5× ‡ |
| Yjs | Cold load of 500 notes, store open and check included | 276 ms † | 71.9 ms † | 3.8× |
| Yjs | Editing trace written in one burst, 25,700 updates with no yield between keystrokes | 2.13k edits/s † | 18.5k edits/s | 8.7× |
| Yjs | One keystroke typed at 60 Hz, main-thread time | 0.130 ms † | 0.156 ms † | 0.83× ‡ |
| Automerge | Cold load of 500 notes, store open and check included | 377 ms | 249 ms | 1.5× |
| Automerge | Write 500 notes | 627 notes/s | 668 notes/s | 1.1× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 2.8 to 17.3, commit 694d5abe. Full results: [2026-11-21T13-51-06-apple-m2-pro](results/2026-11-21T13-51-06-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb and automerge-repo's `IndexedDBStorageAdapter`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode. Opening a collection loads its 91,000 rows, so that row is a time and the others are rates. The Yjs editing trace is a burst: 25,700 updates written with no yield between keystrokes, so kv's group commit folds them into few writes while y-indexeddb commits one transaction per update. The paced row below it is one keystroke typed at 60 Hz, which is what an editor feels.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. A keystroke is timed from the edit to the end of the task after it: what persistence costs the main thread, not the time until the write is stored. Then they open the document cold in a fresh tab, once before kv settles and once after, at size `small`. A cold open is the whole phase: it opens the store, loads the document and checks its text. The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

<!-- bench:table typing-reopening -->
| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, main-thread time | 0.130 ms † | 0.156 ms † | 0.288 ms † | 0.521 ms † | 0.83× ‡ | 0.55× ‡ |
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

Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster. The two board rows time the 6 reads a project's board asks for as it opens: the issues per status, a page of each of the 4 open statuses and the open issues per person. The first row starts the 6 in one task and times to the last answer, and the second awaits each before it starts the next.

<!-- bench:table goals -->
| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 3.75 / 2.40 | 3.79 / 0.126 | 3.64 / 0.0960 † | 1.0× ‡ / 1.3× |
| First 50 todo issues, with assignee and label names | 2.04 / 0.755 | 4.84 / 0.422 | 3.91 † / 0.170 | 1.2× / 2.5× |
| The column a sprint close just emptied | 7.22 / 4.26 | 4.20 / 0.205 | 5.52 / 0.492 | 0.76× / 0.42× |
| Rows at 90% of a project's list | 9.52 / 6.25 | 4.35 / 0.286 | 7.90 / 0.267 | 0.55× / 1.1× ‡ |
| An issue with its comments and their authors | 1.89 / 0.311 | 4.29 / 0.210 | 5.90 / 0.0823 † | 0.73× / 2.6× |
| First 50 open issues by priority, with comment counts | 4.49 / 1.98 | 5.05 / 0.321 | 9.65 / 0.374 | 0.52× / 0.86× |
| First 50 open issues with a label | 20.4 / 16.3 | 9.55 / 2.75 | 8.28 / 0.295 | 1.2× / 9.3× |
| First 50 open issues assigned to a person | 2.76 / 1.16 | 5.38 / 0.424 | 4.57 / 0.202 | 1.2× / 2.1× |
| The 50 most recently updated issues | 1.93 / 0.890 | 4.84 / 0.568 | 3.85 / 0.353 | 1.3× / 1.6× |
| Open issues per person, top 10 | 5.43 / 2.74 | 4.86 / 0.281 | 5.05 / 0.346 | 0.96× ‡ / 0.81× |
| First 20 issues whose title contains a word | 6.59 / 3.57 | 4.39 / 0.207 | 6.49 / 0.169 | 0.68× / 1.2× |
| A project's board, 6 reads started together | 9.06 / 6.58 | 8.59 / 1.61 | 7.02 / 0.775 | 1.2× / 2.1× |
| The same 6 reads, one after the other | 10.9 / 7.38 | 8.65 / 1.72 | 7.49 † / 0.771 | 1.2× / 2.2× |
| Opening the store in a fresh tab, before the todo issues goal | 16.9 | 20.3 | 16.9 | 1.2× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 1.1 to 2.3, commit 5549f02f. Full results: [2026-11-23T20-57-14-apple-m5-max](results/2026-11-23T20-57-14-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

<!-- bench:table writes -->
| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, mean of 47 batches of up to 1,000 rows | 38.5 ms | 17.6 ms | 10.5 ms | 1.7× |
| Sync, mean of 851 batches of about 50 changes | 4.11 ms | 10.5 ms | 2.05 ms | 5.1× |
| One edit | 0.268 ms | 3.40 ms † | 0.222 ms † | 15× |
| Sprint close, 1,054 issues in one batch | 96.4 ms | 52.8 ms | 33.9 ms † | 1.6× |
| The 50 latest issues, read again after every 10th sync batch | 0.945 ms | 0.404 ms | 0.427 ms | 0.94× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 1.1 to 2.3, commit 5549f02f. Full results: [2026-11-23T20-57-14-apple-m5-max](results/2026-11-23T20-57-14-apple-m5-max.md).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The last row is a read: after every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be.

Warm, docstore answers 7 of the 11 goals fastest, because a tab reads on its own main thread from its page cache. SQLite is faster on 3: the column a sprint close emptied, the open issues by priority and the open issues per person. The runs do not separate the two on the deep window. Cold, docstore is faster than SQLite on 4 of the 11 goals and slower on 5, and the runs do not separate the two on the issues per status and the open issues per person. Three of the 4 are the todo issues, a person's issues and the recent issues: their index entries hold the fields of an issue card, so a fresh tab reads no issue document for them. On the other lists a fresh tab loads from OPFS each 32 KB page its rows sit on, and the rows of one list are scattered over many pages. docstore has the highest cold median of the three stores on 2 goals, the issue with its comments and the open issues by priority. The emptied column costs docstore the most: the deletes of the sprint close still sit above the settled runs, and the scan steps over each deleted entry until a compaction drops it. A deep window walks every index entry up to the window on docstore, whose index has no count to jump by: `offset` passes over them without copying a key or reading a document. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no statement once the schema exists, so its first query in a fresh tab also reads the schema. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

A board's 6 reads end sooner started together than one after the other on Dexie, cold and warm, by 1.2× and 1.1×. On docstore the warm times are equal, since a warm read is work on the tab's main thread with nothing to wait for, and cold the runs do not separate the two (7.02 ms against 7.49 ms). On SQLite the warm board takes 1.61 ms together against 1.72 ms in turn, and cold the runs do not separate the two.

### At 200,000 issues

A larger workspace from the same simulation, against Dexie: 200,000 issues, 600 people, 120 projects and 60 labels. Its sprint close holds about 7,500 issues, which docstore writes in batches of 1,000 events, and those writes sit above the stored data when the goals run. Each cell is cold / warm in ms, as above. The last column is Dexie's time over docstore's: above 1×, docstore is faster.

<!-- bench:table goals-large -->
| Goal | Dexie | docstore | docstore vs Dexie |
| --- | ---: | ---: | ---: |
| Issues per status in a project | 8.47 / 7.00 | 3.48 / 0.129 | 2.4× / 54× |
| First 50 todo issues, with assignee and label names | 2.83 / 1.04 | 4.54 / 0.207 | 0.62× / 5.0× |
| The column a sprint close just emptied | 60.8 / 61.6 | 8.27 † / 1.74 † | 7.3× / 35× |
| Rows at 90% of a project's list | 22.1 / 22.1 † | 12.8 / 0.354 | 1.7× / 63× |
| An issue with its comments and their authors | 2.18 / 0.391 | 6.68 / 0.0917 | 0.33× / 4.3× |
| First 50 open issues by priority, with comment counts | 9.08 / 6.23 | 16.2 / 0.373 | 0.56× / 17× |
| First 50 open issues with a label | 13.9 / 9.32 | 12.5 / 0.289 | 1.1× ‡ / 32× |
| First 50 open issues assigned to a person | 4.35 / 1.52 | 4.74 / 0.255 | 0.92× / 6.0× |
| The 50 most recently updated issues | 2.10 / 1.06 † | 4.23 / 0.492 | 0.50× / 2.2× |
| Open issues per person, top 10 | 9.78 / 5.61 | 5.90 / 0.557 | 1.7× / 10× |
| First 20 issues whose title contains a word | 8.83 / 3.70 | 8.50 / 0.146 | 1.0× ‡ / 25× |
| A project's board, 6 reads started together | 15.7 / 11.9 | 8.10 / 1.06 | 1.9× / 11× |
| The same 6 reads, one after the other | 17.6 / 12.4 | 9.32 / 1.04 | 1.9× / 12× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 0.8 to 1.8, commit 5549f02f. Full results: [2026-11-23T22-22-35-apple-m5-max](results/2026-11-23T22-22-35-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

Warm, docstore is faster than Dexie on all 11 goals, from 2.2× to 63×. Cold, it is faster on 4 and slower on 5, and the runs do not separate the two on the open issues with a label and the title search. IndexedDB cannot put an array field, the issue's labels, in one index with other fields. So Dexie walks the project's issues newest first, tests each one's labels and status, and stops after 50 matches, which reads more issues the rarer the label is. docstore's index holds the label, the project, the status and the update time, so it walks the entries of each open status newest first, together, and stops after 50 issues. Started together, the board's 6 reads end 1.1× sooner than in turn on both stores when cold. Warm, docstore's times are equal and the runs do not separate Dexie's.

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

Importing `@opfs-lsm/kv` adds **19.7 kB** of JavaScript to your main bundle (gzip, 57.3 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 19.7 kB | 57.3 kB | at import |
| SharedWorker chunk | 13.4 kB | 39.7 kB | on the first `openDb` |
| wasm engine | 6.5 kB | 16.3 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **39.6 kB** | **113.4 kB** | |

For comparison, Dexie is 31.3 kB gzip and `y-indexeddb` adds 1.1 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 20.0 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the main-thread JS passes 19.7 kB gzip or the after-open brotli total passes its budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
