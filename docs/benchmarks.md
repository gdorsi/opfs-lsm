# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it.

## Storage calls

Each workload holds 100,000 entries with 16-byte keys and 100-byte values. The rows from `kv/fillrandom` have more runs than the others, because a run makes only 1,000 single puts, too few for 10 runs to agree. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

<!-- bench:table storage-calls -->
| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 42.0k ops/s | 494k ops/s | 12× |
| Random point reads | 21.9k ops/s | 592k ops/s † | 27× |
| Reads of missing keys | 24.4k ops/s | 1.89M ops/s | 78× |
| Full ordered scan | 678k ops/s | 1.38M ops/s | 2.0× |
| Seeks of 100 keys | 5.07k ops/s | 19.5k ops/s | 3.8× |
| Single put, awaited one at a time | 14.7k ops/s | 13.0k ops/s | 0.88× ‡ |
| Read-modify-write in one transaction | 0.116 ms | 0.157 ms | 0.74× |
| Opening the database in a fresh tab | 0.590 ms | 5.03 ms | 0.12× |

Medians of 21 runs per contender for kv/fillrandom, 10 for kv/fillseq and kv/ycsb-a, in headless Chrome 157 on Apple M5 Max, load average 2.4 to 6.4, commit 89fe28d6. Full results: [2026-11-17T19-07-52-apple-m5-max](results/2026-11-17T19-07-52-apple-m5-max.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time: kv's is slower than IndexedDB's. Over the whole mix, half of it reads, the two are level, at 12.5k and 12.4k ops/s. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`.

<!-- bench:table framework-adapters -->
| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Open and load 91,000 rows | 663 ms | 202 ms | 3.3× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 19.7k rows/s | 131k rows/s | 6.7× |
| TanStack DB | Serial insert, one row per transaction | 6.92k rows/s | 5.75k rows/s † | 0.83× |
| Yjs | Cold load of 500 notes | 3.00k notes/s | 12.7k notes/s | 4.2× |
| Yjs | Editing trace, one update per keystroke | 2.13k edits/s | 36.0k edits/s | 17× |
| Automerge | Cold load of 500 notes | 2.02k notes/s | 2.80k notes/s | 1.4× |
| Automerge | Write 500 notes | 875 notes/s | 922 notes/s | 1.1× |
| fate | Cold load of 100 lists of 100 records | 2.08k records/s | 4.11k records/s | 2.0× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 2.0 to 4.5, commit 89fe28d6. Full results: [2026-11-17T19-45-25-apple-m5-max](results/2026-11-17T19-45-25-apple-m5-max.md).

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and `@nkzw/fate-indexeddb`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode. Opening a collection loads its 91,000 rows, so that row is a time and the others are rates.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. Then they open the document cold in a fresh tab, once before kv settles and once after, at size `small`. A cold open is the whole phase: it opens the store, loads the document and checks its text. The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

<!-- bench:table typing-reopening -->
| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, with its persistence | 0.101 ms | 0.154 ms † | 0.276 ms | 0.293 ms | 0.66× | 0.94× ‡ |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | | |
| Cold open before the settle | 6.28 ms | 12.1 ms | 42.8 ms | 47.5 ms | 0.52× | 0.90× |
| Cold open after the settle | 6.13 ms | 12.3 ms | 43.3 ms | 48.7 ms | 0.50× | 0.89× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 1.9 to 3.4, commit 89fe28d6. Full results: [2026-11-17T19-45-25-apple-m5-max](results/2026-11-17T19-45-25-apple-m5-max.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 6.4 ms before the settle and 5.0 ms after for Yjs, 5.2 ms and 4.8 ms for Automerge.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite, as [bench/README.md](../bench/README.md) describes. Both collections hold 100,000 rows and load only what a query asks for.

<!-- bench:table on-demand-sqlite -->
| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 37.7 ms † | 7.22 ms | 5.2× |
| First query after a cold open, 6,250 rows | 65.6 ms | 63.1 ms | 1.0× ‡ |
| Warm query of one owner, 6,250 rows | 132k rows/s | 205k rows/s † | 1.6× |
| 10 rows by id | 2.17k queries/s | 5.28k queries/s † | 2.4× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 4.0 to 4.8, commit 89fe28d6-dirty. Full results: [2026-11-17T20-16-52-apple-m5-max](results/2026-11-17T20-16-52-apple-m5-max.md).

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
| Issues per status in a project | 5.39 / 2.41 | 3.97 / 0.144 | 2.69 / 0.175 | 1.5× / 0.83× |
| First 50 todo issues, with assignee and label names | 2.31 / 0.948 | 5.16 / 0.406 | 7.24 / 0.322 | 0.71× ‡ / 1.3× |
| The column a sprint close just emptied | 8.37 / 5.15 | 4.30 / 0.238 | 4.28 / 0.907 | 1.0× ‡ / 0.26× |
| Rows at 90% of a project's list | 12.9 / 7.64 | 4.47 / 0.311 | 9.39 / 0.958 | 0.48× / 0.32× |
| An issue with its comments and their authors | 1.43 / 0.344 | 4.51 / 0.249 | 4.71 / 0.0920 | 0.96× ‡ / 2.7× |
| First 50 open issues by priority, with comment counts | 5.40 / 2.10 | 6.99 / 1.11 | 9.91 / 0.704 | 0.71× ‡ / 1.6× |
| First 50 open issues with a label | 6.93 / 3.53 | 6.97 / 1.26 | 4.94 / 0.163 | 1.4× / 7.7× |
| First 50 open issues assigned to a person | 2.42 / 0.800 | 5.61 / 0.444 | 8.36 / 0.284 | 0.67× / 1.6× |
| The 50 most recently updated issues | 2.03 / 1.34 | 5.06 / 0.682 | 3.38 / 0.390 | 1.5× / 1.7× |
| Open issues per person, top 10 | 11.4 / 6.06 | 5.14 / 0.286 | 3.63 / 0.545 | 1.4× / 0.53× |
| First 20 issues whose title contains a word | 8.82 / 5.18 | 6.20 / 0.741 | 6.49 / 0.180 | 0.96× ‡ / 4.1× |
| Opening the store in a fresh tab, before the todo issues goal | 1.70 | 21.9 | 13.3 | 1.6× |

Medians of 3 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 6.2 to 7.4, commit 89fe28d6-dirty. Full results: [2026-11-17T20-27-42-apple-m5-max](results/2026-11-17T20-27-42-apple-m5-max.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.
<!-- /bench:table -->

<!-- bench:table writes -->
| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, mean of 47 batches of up to 1,000 rows | 51.5 ms | 19.7 ms | 13.3 ms | 1.5× |
| Sync, mean of 851 batches of about 50 changes | 5.66 ms | 12.8 ms | 2.88 ms | 4.4× |
| One edit | 0.327 ms | 3.20 ms | 0.356 ms | 9.0× |
| Sprint close, 1,054 issues in one batch | 114 ms | 71.8 ms | 49.9 ms | 1.4× |

Medians of 3 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 6.2 to 7.4, commit 89fe28d6-dirty. Full results: [2026-11-17T20-27-42-apple-m5-max](results/2026-11-17T20-27-42-apple-m5-max.md).
<!-- /bench:table -->

After every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be. That read took 1.3 ms on Dexie, 0.47 ms on SQLite and 0.56 ms on docstore, 0.8× as fast as SQLite.

Warm, docstore answers 7 of the 11 goals fastest, because a tab reads on its own main thread from its page cache. Cold, it is the slowest on 4 of them: a fresh tab loads from OPFS each 32 KB page its rows sit on, and the rows of one list are scattered over many pages. Open issues per person reads index entries alone, with no document, so cold it is the fastest of the three; warm, SQLite's group-by still takes half its time. A deep window costs more on docstore, because its index has no offset: it reads every entry up to the window. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no schema statement once the schema exists, so the warm-up those statements used to absorb now lands in its first query. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch. The last column is SQLite's time over docstore's, both on demand.

<!-- bench:table live-queries -->
| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 139 ms | 69.8 ms | 8.93 ms | 47.5 ms | 5.3× |
| First answer: a project's todo column | 18.9 ms | 18.1 ms | 18.7 ms | 31.8 ms | 1.7× |
| First answer: open issues with a label | 29.0 ms | 28.4 ms | 11.8 ms | 8.38 ms | 0.71× |
| First answer: a person's open issues | 29.3 ms | 28.2 ms | 5.18 ms | 6.83 ms | 1.3× |
| First answer: the 50 latest issues | 2.46 ms | 2.37 ms | 6.70 ms | 7.72 ms | 1.2× |
| A sync batch, no screen open | 3.11 ms | 1.15 ms | 1.25 ms | 23.2 ms | 19× |
| A sync batch, four screens open | 6.50 ms | 3.82 ms | 3.51 ms | 84.7 ms | 24× |
| Frames dropped over 426 batches, screens open | 9 | 7 | 0 | 81 | |

Medians of 3 runs per contender, in headless Chrome 157 on Apple M5 Max, load average 5.5 to 8.5, commit 89fe28d6-dirty. Full results: [2026-11-17T20-29-34-apple-m5-max](results/2026-11-17T20-29-34-apple-m5-max.md).
<!-- /bench:table -->

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds 2 to 3.5 ms to a batch on IndexedDB and on docstore, eager or on demand. On SQLite it adds 61 ms. A [CPU profile](results/2026-11-16T22-25-41-apple-m2-pro-cpu-profile.txt) of that phase, from an earlier run, shows the tab idle two thirds of the time, waiting for SQLite's worker, and decoding the rows the worker sends back is the largest share of the rest. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **18.8 kB** of JavaScript to your main bundle (gzip, 55.0 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 18.8 kB | 55.0 kB | at import |
| SharedWorker chunk | 12.2 kB | 36.0 kB | on the first `openDb` |
| wasm engine | 16.5 kB | 36.3 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **47.6 kB** | **127.3 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 28.8 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the after-open brotli total passes a budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
