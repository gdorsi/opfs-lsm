# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it.

## Storage calls

Each workload holds 100,000 entries with 16-byte keys and 100-byte values. The rows from `kv/fillrandom` have more runs than the others, because a run makes only 1,000 single puts, too few for 10 runs to agree. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

<!-- bench:table storage-calls -->
| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 42.2k ops/s | 487k ops/s | 12× |
| Random point reads | 20.1k ops/s | 734k ops/s | 37× |
| Reads of missing keys | 22.9k ops/s | 1.91M ops/s | 83× |
| Full ordered scan | 674k ops/s | 1.79M ops/s | 2.7× |
| Seeks of 100 keys | 4.93k ops/s | 25.4k ops/s | 5.2× |
| Single put, awaited one at a time | 14.4k ops/s | 13.6k ops/s | 0.94× ‡ |
| Read-modify-write in one transaction | 0.113 ms | 0.155 ms | 0.73× |
| Opening the database in a fresh tab | 0.545 ms | 3.68 ms | 0.15× |

Medians of 21 runs per contender for kv/fillrandom, 10 for kv/fillseq and kv/ycsb-a, in headless Chrome 157 on Apple M5 Max, load average 2.9 to 10.2, commit 75b01c94. Full results: [2026-11-19T09-50-18-apple-m5-max](results/2026-11-19T09-50-18-apple-m5-max.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.
<!-- /bench:table -->

Random point reads have two states. In 5 of the 21 runs the phase still loads pages from OPFS, about 355 gets of the 100,000 take over 50 µs, and kv reads 532k ops/s. In the other 16 it reads 760k ops/s. The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time: kv's is slower than IndexedDB's. Over the whole mix, half of it reads, the two are level, at 12.9k and 12.5k ops/s. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`.

<!-- bench:table framework-adapters -->
| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Open and load 91,000 rows | 664 ms | 167 ms | 4.0× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 19.4k rows/s | 141k rows/s | 7.3× |
| TanStack DB | Serial insert, one row per transaction | 7.50k rows/s | 5.94k rows/s | 0.79× |
| Yjs | Cold load of 500 notes | 2.81k notes/s † | 13.2k notes/s | 4.7× |
| Yjs | Editing trace, one update per keystroke | 1.89k edits/s | 34.8k edits/s | 18× |
| Automerge | Cold load of 500 notes | 1.97k notes/s | 2.81k notes/s | 1.4× |
| Automerge | Write 500 notes | 873 notes/s | 910 notes/s | 1.0× ‡ |
| fate | Cold load of 100 lists of 100 records | 2.12k records/s | 4.24k records/s | 2.0× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 4.2 to 27.0, commit 75b01c94. Full results: [2026-11-19T10-04-12-apple-m5-max](results/2026-11-19T10-04-12-apple-m5-max.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and `@nkzw/fate-indexeddb`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode. Opening a collection loads its 91,000 rows, so that row is a time and the others are rates.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. Then they open the document cold in a fresh tab, once before kv settles and once after, at size `small`. A cold open is the whole phase: it opens the store, loads the document and checks its text. The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

<!-- bench:table typing-reopening -->
| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, with its persistence | 0.118 ms | 0.147 ms | 0.276 ms | 0.289 ms | 0.80× ‡ | 0.96× ‡ |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | | |
| Cold open before the settle | 6.78 ms | 10.8 ms | 42.8 ms | 46.6 ms | 0.63× ‡ | 0.92× ‡ |
| Cold open after the settle | 6.56 ms | 11.5 ms | 42.8 ms | 47.8 ms | 0.57× | 0.90× ‡ |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 4.0 to 27.0, commit 75b01c94. Full results: [2026-11-19T10-04-12-apple-m5-max](results/2026-11-19T10-04-12-apple-m5-max.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.
<!-- /bench:table -->

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 5.1 ms before the settle and 4.2 ms after for Yjs, 3.5 ms and 3.4 ms for Automerge.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite, as [bench/README.md](../bench/README.md) describes. Both collections hold 100,000 rows and load only what a query asks for.

<!-- bench:table on-demand-sqlite -->
| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 42.1 ms | 6.60 ms † | 6.4× |
| First query after a cold open, 6,250 rows | 66.0 ms | 63.8 ms | 1.0× ‡ |
| Warm query of one owner, 6,250 rows | 124k rows/s † | 221k rows/s | 1.8× |
| 10 rows by id | 2.00k queries/s | 4.99k queries/s | 2.5× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 3.6 to 6.2, commit 75b01c94. Full results: [2026-11-19T10-13-22-apple-m5-max](results/2026-11-19T10-13-22-apple-m5-max.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

[bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster.

<!-- bench:table goals -->
| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 3.41 / 2.41 | 4.10 / 0.144 | 2.55 / 0.138 | 1.6× / 1.0× ‡ |
| First 50 todo issues, with assignee and label names | 1.68 / 0.820 | 5.22 / 0.423 | 6.04 / 0.271 | 0.86× ‡ / 1.6× |
| The column a sprint close just emptied | 6.72 / 4.37 | 4.57 / 0.230 | 3.91 / 0.857 | 1.2× / 0.27× |
| Rows at 90% of a project's list | 10.2 / 8.85 | 4.63 / 0.302 | 7.12 / 0.649 | 0.65× / 0.46× |
| An issue with its comments and their authors | 1.32 / 0.361 | 4.86 / 0.230 | 4.51 / 0.0963 | 1.1× ‡ / 2.4× |
| First 50 open issues by priority, with comment counts | 3.68 / 2.77 | 7.12 / 1.20 | 8.45 / 0.535 | 0.84× / 2.2× |
| First 50 open issues with a label | 5.12 / 3.37 | 7.48 / 1.28 | 4.64 / 0.136 | 1.6× / 9.4× |
| First 50 open issues assigned to a person | 1.53 / 0.745 | 5.94 / 0.424 | 6.30 / 0.239 | 0.94× ‡ / 1.8× |
| The 50 most recently updated issues | 1.66 / 0.940 | 5.39 / 0.693 | 3.20 / 0.370 | 1.7× / 1.9× |
| Open issues per person, top 10 | 8.50 / 4.79 | 5.63 / 0.331 | 3.35 / 0.438 | 1.7× / 0.76× ‡ |
| First 20 issues whose title contains a word | 7.07 / 5.50 | 6.13 / 0.708 | 5.39 / 0.185 | 1.1× / 3.8× |
| Opening the store in a fresh tab, before the todo issues goal | 1.69 | 24.8 | 10.6 | 2.3× |

Medians of 3 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 5.0 to 12.2, commit 5a7d1b01. Full results: [2026-11-19T12-41-20-apple-m5-max](results/2026-11-19T12-41-20-apple-m5-max.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.
<!-- /bench:table -->

<!-- bench:table writes -->
| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, mean of 47 batches of up to 1,000 rows | 68.3 ms | 17.4 ms | 14.4 ms | 1.2× |
| Sync, mean of 851 batches of about 50 changes | 6.34 ms | 14.0 ms | 2.71 ms | 5.2× |
| One edit | 0.330 ms | 2.80 ms | 0.348 ms | 8.1× |
| Sprint close, 1,054 issues in one batch | 107 ms | 74.3 ms | 36.7 ms | 2.0× |

Medians of 3 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 5.0 to 12.2, commit 5a7d1b01. Full results: [2026-11-19T12-41-20-apple-m5-max](results/2026-11-19T12-41-20-apple-m5-max.md).
<!-- /bench:table -->

After every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be. That read took 1.3 ms on Dexie, 0.51 ms on SQLite and 0.55 ms on docstore, 0.92× as fast as SQLite, and the ranges of the two overlap.

Warm, docstore answers 7 of the 11 goals fastest and is level with SQLite on an eighth, because a tab reads on its own main thread from its page cache. Cold, it is faster than SQLite on 6 of the 11 goals and slower on 2, and it is the slowest of the three stores on 3: a fresh tab loads from OPFS each 32 KB page its rows sit on, and the rows of one list are scattered over many pages. Open issues per person reads index entries alone, with no document, so cold it is the fastest of the three; warm, the runs do not separate it from SQLite's group-by. A deep window costs more on docstore, because its index has no offset: it reads every entry up to the window. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no schema statement once the schema exists, so the warm-up those statements used to absorb now lands in its first query. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch. The last column is SQLite's time over docstore's, both on demand.

<!-- bench:table live-queries -->
| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 140 ms | 72.5 ms | 9.12 ms | 51.6 ms | 5.7× |
| First answer: a project's todo column | 19.4 ms | 19.4 ms | 17.5 ms | 32.1 ms | 1.8× |
| First answer: open issues with a label | 31.2 ms | 34.8 ms | 7.75 ms | 8.64 ms | 1.1× ‡ |
| First answer: a person's open issues | 34.4 ms | 34.2 ms | 4.67 ms | 6.82 ms | 1.5× |
| First answer: the 50 latest issues | 2.62 ms | 2.57 ms | 7.35 ms | 7.79 ms | 1.1× ‡ |
| A sync batch, no screen open | 3.61 ms | 1.58 ms | 1.23 ms | 26.2 ms | 21× |
| A sync batch, four screens open | 7.20 ms | 4.26 ms | 3.89 ms | 93.5 ms | 24× |
| Frames dropped over 426 batches, screens open | 12 | 7 | 0 | 107 | |

Medians of 3 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 4.8 to 9.0, commit 75b01c94. Full results: [2026-11-19T11-33-30-apple-m5-max](results/2026-11-19T11-33-30-apple-m5-max.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.
<!-- /bench:table -->

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds 2.7 to 3.6 ms to a batch on IndexedDB and on docstore, eager or on demand. On SQLite it adds 67 ms. A [CPU profile](results/2026-11-16T22-25-41-apple-m2-pro-cpu-profile.txt) of that phase, from an earlier run, shows the tab idle two thirds of the time, waiting for SQLite's worker, and decoding the rows the worker sends back is the largest share of the rest. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **19.7 kB** of JavaScript to your main bundle (gzip, 57.8 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 19.7 kB | 57.8 kB | at import |
| SharedWorker chunk | 13.4 kB | 40.7 kB | on the first `openDb` |
| wasm engine | 16.6 kB | 36.3 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **49.6 kB** | **134.8 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 30.0 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the after-open brotli total passes a budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
