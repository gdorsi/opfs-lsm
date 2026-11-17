# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it.

## Storage calls

Medians of 10 runs, from two sessions of 5, in headless Chrome 157 on an Apple M5 Max with a load average of 6 to 11 from other work, 100,000 entries with 16-byte keys and 100-byte values. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. The single-put row is the median of 21 runs: a run is 1,000 puts, too few for 5 runs to agree. It came from the `kv/fillsync` workload, whose 1,000 puts on an empty store are now the first phase of `kv/fillrandom`, unchanged. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md). The run files behind this table were not kept; the full results of each newer table are in [results/](results/), linked under it.

| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 30.2k ops/s | 432k ops/s | 14× |
| Random point reads | 16.4k ops/s | 488k ops/s | 30× |
| Reads of missing keys | 17.8k ops/s | 1.64M ops/s | 92× |
| Full ordered scan | 604k ops/s | 1.03M ops/s | 1.7× |
| Single put, awaited one at a time | 9.1k ops/s | 7.4k ops/s | 0.8× |
| Cold open | 1.2 ms | 7.8 ms | 0.2× |

The bench also measures zipfian reads mixed with updates and with read-modify-writes (`kv/ycsb-a`, YCSB A then F), seeks of 10 and 100 keys (`kv/fillseq`), and batched deletes (`kv/fillrandom`). This table has no row for them yet.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`. The run files behind this table were not kept:

| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Cold load of 91,000 rows | 112k rows/s | 176k rows/s | 1.6× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 17.2k rows/s | 115k rows/s | 6.7× |
| TanStack DB | Serial insert, one row per transaction | 4.7k rows/s | 2.5k rows/s | 0.5× |
| Yjs | Cold load of 500 notes | 2.0k notes/s | 9.5k notes/s | 4.8× |
| Yjs | Editing trace, one update per keystroke | 1.4k edits/s | 33.2k edits/s | 23× |
| Automerge | Cold load of 500 notes | 1.1k notes/s | 2.2k notes/s | 2.0× |
| Automerge | Write 500 notes | 743 notes/s | 821 notes/s | 1.1× |
| fate | Cold load of 100 lists of 100 records | 1.0k records/s | 3.4k records/s | 3.3× |

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and `@nkzw/fate-indexeddb`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. Then they open the document cold in a fresh tab, once before kv settles and once after. Medians of 3 runs at size `small`, headless Chrome 157 on an Apple M2 Pro with a load average of 1.9 to 2.8. Full results: [2026-11-17T00-58-58](results/2026-11-17T00-58-58-apple-m2-pro.md).

| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv |
| --- | ---: | ---: | ---: | ---: |
| One keystroke, with its persistence | 0.23 ms | 0.28 ms | 0.56 ms | 0.61 ms |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 |
| Cold open before the settle | 7.2 ms | 16 ms | 57 ms | 62 ms |
| Cold open after the settle | 7.3 ms | 22 ms | 56 ms | 64 ms |

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 9 ms before the settle and 13 ms after.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite, as [bench/README.md](../bench/README.md) describes. Both collections hold 100,000 rows and load only what a query asks for. The reads, medians of 5 interleaved runs in headless Chrome 157 on an Apple M2 Pro with a load average of about 3. The run files behind this table were not kept:

| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 48.1 ms | 12.0 ms | 4.0× |
| First query after a cold open, 6,250 rows | 88.1 ms | 88.1 ms | 1.0× |
| Warm query of one owner, 6,250 rows | 90.7k rows/s | 131k rows/s | 1.4× |
| 10 rows by id | 1.6k queries/s | 3.6k queries/s | 2.3× |

[bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Medians of 3 runs in headless Chrome 157 on an Apple M2 Pro with a load average of 2.3 to 4.4. Full results: [2026-11-17T00-52-40](results/2026-11-17T00-52-40-apple-m2-pro.md). Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster.

| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 5.7 / 3.3 | 5.3 / 0.18 | 5.3 / 0.30 | 1.0× / 0.6× |
| First 50 todo issues, with assignee and label names | 2.2 / 1.2 | 6.8 / 0.53 | 8.3 / 0.47 | 0.8× / 1.1× |
| The column a sprint close just emptied | 8.1 / 5.8 | 5.9 / 0.29 | 5.5 / 1.4 | 1.1× / 0.2× |
| Rows at 90% of a project's list | 14.8 / 9.5 | 5.9 / 0.38 | 12.0 / 1.3 | 0.5× / 0.3× |
| An issue with its comments and their authors | 1.6 / 0.40 | 5.8 / 0.32 | 6.3 / 0.16 | 0.9× / 2.0× |
| First 50 open issues by priority, with comment counts | 5.4 / 2.7 | 8.7 / 1.4 | 16.3 / 1.4 | 0.5× / 1.0× |
| First 50 open issues with a label | 8.2 / 4.6 | 8.7 / 1.6 | 6.2 / 0.27 | 1.4× / 5.9× |
| First 50 open issues assigned to a person | 2.2 / 1.1 | 7.3 / 0.50 | 9.0 / 0.42 | 0.8× / 1.2× |
| The 50 most recently updated issues | 2.2 / 1.3 | 6.5 / 0.81 | 3.8 / 0.63 | 1.7× / 1.3× |
| Open issues per person, top 10 | 10.7 / 7.3 | 6.8 / 0.36 | 16.4 / 4.5 | 0.4× / 0.1× |
| First 20 issues whose title contains a word | 11.8 / 7.2 | 7.7 / 0.87 | 7.5 / 0.30 | 1.0× / 2.9× |
| Opening the store in a fresh tab | 2.2 | 24 | 18 | 1.3× |

| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, 47 batches of up to 1,000 rows | 2.8 s | 1.0 s | 0.85 s | 1.2× |
| Sync, 851 batches of about 50 changes | 5.6 s | 11.3 s | 3.3 s | 3.4× |
| One edit | 0.41 ms | 1.1 ms | 0.73 ms | 1.5× |
| Sprint close, 1,054 issues in one batch | 156 ms | 88 ms | 81 ms | 1.1× |

After every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be. That read took 1.4 ms on Dexie, 0.54 ms on SQLite and 0.69 ms on docstore, 0.8× as fast as SQLite.

Warm, docstore answers 7 of the 11 goals fastest, because a tab reads on its own main thread from its page cache; on the priority page it ties with SQLite. Cold, it is the slowest on 5 of them: a fresh tab loads from OPFS each 32 KB page its rows sit on, and the rows of one list are scattered over many pages. A group-by and a deep window cost more on docstore, because its queries return neither index values nor an offset. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no schema statement once the schema exists, so the warm-up those statements used to absorb now lands in its first query. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch, median of 3 runs, in headless Chrome 157 on an Apple M2 Pro with a load average of 1.8 to 4.8. The last column is SQLite's time over docstore's, both on demand. Full results: [2026-11-17T00-54-52](results/2026-11-17T00-54-52-apple-m2-pro.md).

| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 180 ms | 93 ms | 9.6 ms | 57 ms | 5.9× |
| First answer: a project's todo column | 22.9 ms | 23.4 ms | 23.4 ms | 39.8 ms | 1.7× |
| First answer: open issues with a label | 33.8 ms | 35.2 ms | 13.0 ms | 10.3 ms | 0.8× |
| First answer: a person's open issues | 35.2 ms | 37.9 ms | 6.3 ms | 8.1 ms | 1.3× |
| First answer: the 50 latest issues | 3.5 ms | 3.4 ms | 8.8 ms | 9.4 ms | 1.1× |
| A sync batch, no screen open | 3.8 ms | 1.9 ms | 1.6 ms | 26 ms | 16× |
| A sync batch, four screens open | 7.2 ms | 5.6 ms | 4.7 ms | 108 ms | 23× |
| Frames dropped over 426 batches, screens open | 11 | 9 | 0 | 184 | |

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds 3 to 4 ms to a batch on IndexedDB and on docstore, eager or on demand. On SQLite it adds 82 ms. A [CPU profile](results/2026-11-16T22-25-41-apple-m2-pro-cpu-profile.txt) of that phase, from an earlier run, shows the tab idle two thirds of the time, waiting for SQLite's worker, and decoding the rows the worker sends back is the largest share of the rest. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **18.8 kB** of JavaScript to your main bundle (gzip, 55.0 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 18.8 kB | 55.0 kB | at import |
| SharedWorker chunk | 12.2 kB | 36.0 kB | on the first `openDb` |
| wasm engine | 16.6 kB | 36.4 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **47.6 kB** | **127.5 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 28.8 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the after-open brotli total passes a budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
