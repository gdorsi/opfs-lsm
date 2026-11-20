# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it. Under each table is the machine and the commit of its run: the goal tables ran on an Apple M2 Pro and the others on an Apple M5 Max, so compare numbers inside one table, not across two.

## Storage calls

Each workload holds 100,000 entries with 16-byte keys and 100-byte values. The rows from `kv/fillrandom` have more runs than the others, because a run makes only 1,000 single puts, too few for 10 runs to agree. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

<!-- bench:table storage-calls -->
| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 40.8k ops/s | 480k ops/s | 12× |
| Random point reads | 21.2k ops/s | 738k ops/s | 35× |
| Reads of missing keys | 24.9k ops/s | 1.87M ops/s | 75× |
| Full ordered scan | 676k ops/s | 1.75M ops/s | 2.6× |
| Seeks of 100 keys | 5.15k ops/s | 25.8k ops/s | 5.0× |
| Single put, awaited one at a time | 14.7k ops/s | 13.3k ops/s | 0.91× |
| Read-modify-write in one transaction | 0.110 ms | 0.153 ms | 0.72× |
| Opening the database in a fresh tab | 0.275 ms | 3.91 ms | 0.07× |

Medians of 21 runs per contender for kv/fillrandom, 10 for kv/fillseq and kv/ycsb-a, in headless Chrome 157 on Apple M5 Max, load average 2.6 to 5.2, commit bbbd4662. Full results: [2026-11-19T20-05-36-apple-m5-max](results/2026-11-19T20-05-36-apple-m5-max.md).
<!-- /bench:table -->

The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time: kv's is slower than IndexedDB's. Over the whole mix, half of it reads, the two are level, at 13.0k and 12.7k ops/s. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`.

<!-- bench:table framework-adapters -->
| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Open and load 91,000 rows | 661 ms | 172 ms | 3.8× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 19.2k rows/s | 149k rows/s | 7.8× |
| TanStack DB | Serial insert, one row per transaction | 7.07k rows/s | 6.10k rows/s | 0.86× |
| Yjs | Cold load of 500 notes | 2.93k notes/s | 13.0k notes/s | 4.5× |
| Yjs | Editing trace, one update per keystroke | 1.98k edits/s | 34.7k edits/s | 17× |
| Automerge | Cold load of 500 notes | 1.95k notes/s | 2.73k notes/s | 1.4× |
| Automerge | Write 500 notes | 851 notes/s | 902 notes/s | 1.1× |
| fate | Cold load of 100 lists of 100 records | 2.26k records/s | 4.01k records/s | 1.8× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 2.4 to 4.2, commit bbbd4662. Full results: [2026-11-19T20-20-58-apple-m5-max](results/2026-11-19T20-20-58-apple-m5-max.md).
<!-- /bench:table -->

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and `@nkzw/fate-indexeddb`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode. Opening a collection loads its 91,000 rows, so that row is a time and the others are rates.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. Then they open the document cold in a fresh tab, once before kv settles and once after, at size `small`. A cold open is the whole phase: it opens the store, loads the document and checks its text. The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

<!-- bench:table typing-reopening -->
| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, with its persistence | 0.148 ms | 0.164 ms | 0.364 ms | 0.364 ms † | 0.90× ‡ | 1.0× ‡ |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | | |
| Cold open before the settle | 6.46 ms | 10.6 ms | 43.8 ms | 46.8 ms | 0.61× | 0.94× |
| Cold open after the settle | 6.36 ms | 10.9 ms | 43.8 ms | 48.4 ms | 0.58× | 0.91× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 2.5 to 4.2, commit bbbd4662. Full results: [2026-11-19T20-20-58-apple-m5-max](results/2026-11-19T20-20-58-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 4.8 ms before the settle and 3.5 ms after for Yjs, 3.2 ms and 3.3 ms for Automerge.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite, as [bench/README.md](../bench/README.md) describes. Both collections hold 100,000 rows and load only what a query asks for.

<!-- bench:table on-demand-sqlite -->
| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 41.6 ms | 6.89 ms † | 6.0× |
| First query after a cold open, 6,250 rows | 63.0 ms | 60.6 ms | 1.0× |
| Warm query of one owner, 6,250 rows | 128k rows/s | 228k rows/s | 1.8× |
| 10 rows by id | 2.11k queries/s | 5.28k queries/s | 2.5× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 3.0 to 3.9, commit bbbd4662. Full results: [2026-11-19T20-29-20-apple-m5-max](results/2026-11-19T20-29-20-apple-m5-max.md).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

[bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster.

<!-- bench:table goals -->
| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 4.32 / 3.33 | 5.43 / 0.174 | 3.03 / 0.150 | 1.8× / 1.2× |
| First 50 todo issues, with assignee and label names | 2.30 / 1.20 | 6.93 / 0.530 | 7.78 / 0.317 | 0.89× / 1.7× |
| The column a sprint close just emptied | 7.97 / 6.11 | 5.89 / 0.235 | 4.68 / 0.697 | 1.3× / 0.34× |
| Rows at 90% of a project's list | 11.3 / 10.2 | 6.08 / 0.388 | 8.84 / 0.407 | 0.69× / 0.95× |
| An issue with its comments and their authors | 1.57 / 0.422 | 6.09 / 0.270 | 5.65 / 0.126 | 1.1× / 2.1× |
| First 50 open issues by priority, with comment counts | 4.21 / 2.73 | 9.13 / 1.46 | 12.0 / 0.639 | 0.76× / 2.3× |
| First 50 open issues with a label | 6.88 / 4.73 | 9.36 / 1.66 | 5.85 / 0.206 | 1.6× / 8.1× |
| First 50 open issues assigned to a person | 2.07 / 1.07 | 7.76 / 0.503 | 8.13 / 0.333 | 0.95× / 1.5× |
| The 50 most recently updated issues | 2.21 / 1.29 | 6.83 / 0.772 | 3.65 / 0.528 | 1.9× / 1.5× |
| Open issues per person, top 10 | 10.7 / 7.64 | 6.89 / 0.376 | 4.07 / 0.428 | 1.7× / 0.88× |
| First 20 issues whose title contains a word | 10.2 / 7.41 | 7.58 / 0.901 † | 7.01 / 0.255 | 1.1× ‡ / 3.5× |
| Opening the store in a fresh tab, before the todo issues goal | 2.08 | 24.4 | 13.6 | 1.8× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 5.3 to 8.4, commit 8589ad8. Full results: [2026-11-20T03-56-54-apple-m2-pro](results/2026-11-20T03-56-54-apple-m2-pro.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

<!-- bench:table writes -->
| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, mean of 47 batches of up to 1,000 rows | 62.1 ms | 21.7 ms | 14.3 ms | 1.5× |
| Sync, mean of 851 batches of about 50 changes | 6.69 ms | 13.6 ms | 2.96 ms | 4.6× |
| One edit | 0.409 ms | 1.03 ms | 0.460 ms | 2.2× |
| Sprint close, 1,054 issues in one batch | 157 ms | 92.7 ms | 47.8 ms | 1.9× |
| The 50 latest issues, read again after every 10th sync batch | 1.49 ms | 0.561 ms | 0.551 ms | 1.0× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 5.3 to 8.4, commit 8589ad8. Full results: [2026-11-20T03-56-54-apple-m2-pro](results/2026-11-20T03-56-54-apple-m2-pro.md).
<!-- /bench:table -->

The last row is a read: after every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be.

Warm, docstore answers 8 of the 11 goals fastest, because a tab reads on its own main thread from its page cache. SQLite is faster on the other 3: the column a sprint close emptied, the open issues per person, by 12%, and the deep window, by 5%. Cold, docstore is faster than SQLite on 6 of the 11 goals and slower on 4, and it is the slowest of the three stores on 3: a fresh tab loads from OPFS each 32 KB page its rows sit on, and the rows of one list are scattered over many pages. Open issues per person reads index entries alone, with no document, so cold it is the fastest of the three. The emptied column costs docstore the most: the deletes of the sprint close still sit above the settled runs, and the scan steps over each deleted entry until a compaction drops it. A deep window walks every index entry up to the window on docstore, whose index has no count to jump by: `offset` passes over them without copying a key or reading a document. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no schema statement once the schema exists, so the warm-up those statements used to absorb now lands in its first query. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch. The last column is SQLite's time over docstore's, both on demand.

<!-- bench:table live-queries -->
| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 133 ms | 66.7 ms | 8.69 ms | 49.6 ms | 5.7× |
| First answer: a project's todo column | 18.3 ms | 17.5 ms | 17.6 ms | 30.4 ms | 1.7× |
| First answer: open issues with a label | 27.7 ms | 26.2 ms | 7.04 ms † | 7.84 ms | 1.1× ‡ |
| First answer: a person's open issues | 28.7 ms | 25.9 ms | 4.34 ms | 6.52 ms | 1.5× |
| First answer: the 50 latest issues | 2.52 ms | 2.51 ms | 6.55 ms | 7.76 ms | 1.2× |
| A sync batch, no screen open | 2.67 ms | 1.08 ms | 1.04 ms | 22.3 ms | 22× |
| A sync batch, four screens open | 5.30 ms | 3.74 ms | 3.33 ms | 82.4 ms | 25× |
| Frames dropped over 426 batches, screens open | 7 | 9 | 0 | 77 | |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 2.9 to 6.3, commit bbbd4662. Full results: [2026-11-19T20-00-35-apple-m5-max](results/2026-11-19T20-00-35-apple-m5-max.md).

‡ These runs do not separate the two contenders (rank-sum test, 5% level).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds 2.3 to 2.7 ms to a batch on IndexedDB and on docstore, eager or on demand. On SQLite it adds 60 ms. A [CPU profile](results/2026-11-16T22-25-41-apple-m2-pro-cpu-profile.txt) of that phase, from an earlier run, shows the tab idle two thirds of the time, waiting for SQLite's worker, and decoding the rows the worker sends back is the largest share of the rest. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **19.2 kB** of JavaScript to your main bundle (gzip, 56.9 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 19.2 kB | 56.9 kB | at import |
| SharedWorker chunk | 13.5 kB | 41.2 kB | on the first `openDb` |
| wasm engine | 16.5 kB | 36.3 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **49.3 kB** | **134.4 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 30.1 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the main-thread JS passes 19.5 kB gzip or the after-open brotli total passes its budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
