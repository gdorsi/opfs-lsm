# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it.

## Storage calls

Each workload holds 100,000 entries with 16-byte keys and 100-byte values. The rows from `kv/fillrandom` have more runs than the others, because a run makes only 1,000 single puts, too few for 10 runs to agree. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

<!-- bench:table storage-calls -->
| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 26.1k ops/s † | 344k ops/s | 13× |
| Random point reads | 16.6k ops/s † | 557k ops/s | 33× |
| Reads of missing keys | 17.2k ops/s † | 1.34M ops/s | 78× |
| Full ordered scan | 429k ops/s | 1.27M ops/s | 3.0× |
| Seeks of 100 keys | 3.64k ops/s | 19.5k ops/s | 5.3× |
| Single put, awaited one at a time | 9.19k ops/s † | 8.39k ops/s | 0.91× ‡ |
| Read-modify-write in one transaction | 0.174 ms | 0.237 ms | 0.74× |
| Opening the database in a fresh tab | 0.321 ms | 5.01 ms † | 0.064× |

Medians of 21 runs per contender for kv/fillrandom, 10 for kv/fillseq and kv/ycsb-a, in headless Chrome 157 on Apple M2 Pro, load average 2.2 to 10.1, commit 13759ab. Full results: [2026-11-19T18-27-57-apple-m2-pro](results/2026-11-19T18-27-57-apple-m2-pro.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time: kv's is slower than IndexedDB's. Over the whole mix, half of it reads, the two are level, at 8.27k and 8.13k ops/s. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`.

<!-- bench:table framework-adapters -->
| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Open and load 91,000 rows | 905 ms | 254 ms | 3.6× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 12.5k rows/s | 107k rows/s | 8.5× |
| TanStack DB | Serial insert, one row per transaction | 4.87k rows/s | 4.15k rows/s | 0.85× |
| Yjs | Cold load of 500 notes | 1.88k notes/s | 9.69k notes/s | 5.2× |
| Yjs | Editing trace, one update per keystroke | 2.24k edits/s | 23.5k edits/s | 10× |
| Automerge | Cold load of 500 notes | 1.41k notes/s | 2.06k notes/s | 1.5× |
| Automerge | Write 500 notes | 612 notes/s | 649 notes/s | 1.1× |
| fate | Cold load of 100 lists of 100 records | 1.56k records/s | 3.38k records/s | 2.2× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 2.2 to 5.0, commit 13759ab. Full results: [2026-11-19T18-52-42-apple-m2-pro](results/2026-11-19T18-52-42-apple-m2-pro.md).
<!-- /bench:table -->

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and `@nkzw/fate-indexeddb`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode. Opening a collection loads its 91,000 rows, so that row is a time and the others are rates.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. Then they open the document cold in a fresh tab, once before kv settles and once after, at size `small`. A cold open is the whole phase: it opens the store, loads the document and checks its text. The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

<!-- bench:table typing-reopening -->
| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, with its persistence | 0.204 ms † | 0.256 ms | 0.539 ms | 0.561 ms | 0.80× | 0.96× ‡ |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | | |
| Cold open before the settle | 8.44 ms | 14.1 ms | 58.1 ms | 63.3 ms | 0.60× | 0.92× |
| Cold open after the settle | 8.51 ms | 14.1 ms | 58.5 ms | 64.4 ms | 0.60× | 0.91× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 2.2 to 5.0, commit 13759ab. Full results: [2026-11-19T18-52-42-apple-m2-pro](results/2026-11-19T18-52-42-apple-m2-pro.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.

† The runs of a marked cell form two clusters, so its median hides two states.
<!-- /bench:table -->

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 6.5 ms before the settle and 4.8 ms after for Yjs, 4.1 ms both times for Automerge.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite, as [bench/README.md](../bench/README.md) describes. Both collections hold 100,000 rows and load only what a query asks for.

<!-- bench:table on-demand-sqlite -->
| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 48.7 ms | 7.97 ms | 6.1× |
| First query after a cold open, 6,250 rows | 86.8 ms | 85.7 ms | 1.0× ‡ |
| Warm query of one owner, 6,250 rows | 94.2k rows/s | 162k rows/s | 1.7× |
| 10 rows by id | 1.62k queries/s | 3.82k queries/s | 2.4× |

Medians of 5 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 2.0 to 3.0, commit 13759ab. Full results: [2026-11-19T19-02-38-apple-m2-pro](results/2026-11-19T19-02-38-apple-m2-pro.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.
<!-- /bench:table -->

[bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster.

<!-- bench:table goals -->
| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 4.21 / 3.46 | 5.39 / 0.165 | 2.99 / 0.178 | 1.8× / 0.93× |
| First 50 todo issues, with assignee and label names | 2.28 / 1.24 | 6.84 / 0.528 | 8.05 / 0.349 | 0.85× / 1.5× |
| The column a sprint close just emptied | 8.15 / 6.08 | 5.82 / 0.292 | 5.00 / 0.938 | 1.2× / 0.31× |
| Rows at 90% of a project's list | 11.4 / 10.3 | 6.01 / 0.386 | 9.48 / 0.749 | 0.63× / 0.52× |
| An issue with its comments and their authors | 1.55 / 0.429 | 6.11 / 0.267 | 5.48 / 0.123 | 1.1× / 2.2× |
| First 50 open issues by priority, with comment counts | 4.33 / 2.72 | 9.13 / 1.48 | 11.2 / 0.677 | 0.81× / 2.2× |
| First 50 open issues with a label | 6.81 / 4.73 | 9.33 / 1.58 | 5.76 / 0.201 | 1.6× / 7.8× |
| First 50 open issues assigned to a person | 2.10 / 1.05 | 7.66 / 0.512 | 7.81 / 0.343 | 0.98× / 1.5× |
| The 50 most recently updated issues | 2.18 / 1.32 | 6.84 / 0.762 | 3.66 / 0.480 | 1.9× / 1.6× |
| Open issues per person, top 10 | 10.8 / 7.62 | 6.82 / 0.379 | 4.11 / 0.450 | 1.7× / 0.84× |
| First 20 issues whose title contains a word | 10.2 / 7.39 | 7.44 / 0.896 | 7.02 / 0.263 | 1.1× / 3.4× |
| Opening the store in a fresh tab, before the todo issues goal | 2.08 | 24.8 | 14.1 | 1.8× |

Medians of 3 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 3.8 to 8.7, commit 13759ab. Full results: [2026-11-19T19-14-44-apple-m2-pro](results/2026-11-19T19-14-44-apple-m2-pro.md).
<!-- /bench:table -->

<!-- bench:table writes -->
| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, mean of 47 batches of up to 1,000 rows | 62.7 ms | 21.9 ms | 14.9 ms | 1.5× |
| Sync, mean of 851 batches of about 50 changes | 6.80 ms | 13.7 ms | 3.00 ms | 4.6× |
| One edit | 0.423 ms | 1.05 ms | 0.463 ms | 2.3× |
| Sprint close, 1,054 issues in one batch | 154 ms | 92.1 ms | 55.9 ms | 1.6× |

Medians of 3 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 3.8 to 8.7, commit 13759ab. Full results: [2026-11-19T19-14-44-apple-m2-pro](results/2026-11-19T19-14-44-apple-m2-pro.md).
<!-- /bench:table -->

After every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be. That read took 1.4 ms on Dexie, 0.56 ms on SQLite and 0.60 ms on docstore, 0.93× as fast as SQLite.

Warm, docstore answers 7 of the 11 goals fastest, because a tab reads on its own main thread from its page cache. Cold, it is faster than SQLite on 7 of the 11 goals and slower on 3, and it is the slowest of the three stores on 3: a fresh tab loads from OPFS each 32 KB page its rows sit on, and the rows of one list are scattered over many pages. Open issues per person reads index entries alone, with no document, so cold it is the fastest of the three; warm, SQLite's group-by is faster. A deep window costs more on docstore, because its index has no offset: it reads every entry up to the window. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no schema statement once the schema exists, so the warm-up those statements used to absorb now lands in its first query. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch. The last column is SQLite's time over docstore's, both on demand.

<!-- bench:table live-queries -->
| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 182 ms | 87.5 ms | 7.85 ms | 56.1 ms | 7.1× |
| First answer: a project's todo column | 23.0 ms | 24.4 ms | 22.8 ms | 39.9 ms | 1.8× |
| First answer: open issues with a label | 33.8 ms | 33.4 ms | 9.91 ms | 10.5 ms | 1.1× ‡ |
| First answer: a person's open issues | 35.2 ms | 34.9 ms | 6.62 ms | 8.00 ms | 1.2× |
| First answer: the 50 latest issues | 3.40 ms | 3.38 ms | 8.87 ms | 9.85 ms | 1.1× |
| A sync batch, no screen open | 3.92 ms | 1.38 ms | 1.31 ms | 25.9 ms | 20× |
| A sync batch, four screens open | 7.35 ms | 4.92 ms | 4.28 ms | 109 ms | 25× |
| Frames dropped over 426 batches, screens open | 13 | 11 | 0 | 210 | |

Medians of 3 runs per contender, in headless Chrome 157 on Apple M2 Pro, load average 2.2 to 3.0, commit 13759ab. Full results: [2026-11-19T19-10-46-apple-m2-pro](results/2026-11-19T19-10-46-apple-m2-pro.md).

‡ The min–max ranges of the two contenders overlap, so these runs do not separate them.
<!-- /bench:table -->

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds 3.0 to 3.5 ms to a batch on IndexedDB and on docstore, eager or on demand. On SQLite it adds 83 ms. A [CPU profile](results/2026-11-16T22-25-41-apple-m2-pro-cpu-profile.txt) of that phase, from an earlier run, shows the tab idle two thirds of the time, waiting for SQLite's worker, and decoding the rows the worker sends back is the largest share of the rest. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **19.7 kB** of JavaScript to your main bundle (gzip, 57.8 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 19.7 kB | 57.8 kB | at import |
| SharedWorker chunk | 13.4 kB | 40.7 kB | on the first `openDb` |
| wasm engine | 16.6 kB | 36.3 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **49.6 kB** | **134.8 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 30.0 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the after-open brotli total passes a budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
