# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it.

## Storage calls

Medians of 10 runs, from two sessions of 5, in headless Chrome 157 on an Apple M5 Max with a load average of 2.4 to 6.4, 100,000 entries with 16-byte keys and 100-byte values. The rows from `kv/fillrandom` are medians of 21 runs: a third session ran that workload 11 more times, because a run makes only 1,000 single puts, too few for 10 runs to agree. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md). Full results: [2026-11-17T19-07-52](results/2026-11-17T19-07-52-apple-m5-max.md).

| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 42.0k ops/s | 494k ops/s | 12× |
| Random point reads | 21.9k ops/s | 592k ops/s | 27× |
| Reads of missing keys | 24.4k ops/s | 1.89M ops/s | 78× |
| Full ordered scan | 678k ops/s | 1.38M ops/s | 2.0× |
| Seeks of 100 keys | 5.1k ops/s | 19.5k ops/s | 3.8× |
| Single put, awaited one at a time | 14.7k ops/s | 13.0k ops/s | 0.9× |
| Read-modify-write in one transaction | 0.12 ms | 0.16 ms | 0.7× |
| Cold open | 0.9 ms | 6.7 ms | 0.1× |

The read-modify-writes are the YCSB F half of `kv/ycsb-a`, zipfian, timed one at a time: kv's is slower than IndexedDB's. Over the whole mix, half of it reads, the two are level, at 12.5k and 12.4k ops/s. The bench also measures YCSB A's blind updates, seeks of 10 keys and batched deletes. This table has no row for them.

## Framework adapters

The framework adapters, each against the IndexedDB option its framework ships, at size `small`. Medians of 5 runs, from one session for Yjs and Automerge and one for TanStack DB and fate, in headless Chrome 157 on an Apple M5 Max with a load average of 1.9 to 4.5. Full results: [2026-11-17T19-45-25](results/2026-11-17T19-45-25-apple-m5-max.md).

| Framework | Workload | IndexedDB option | opfs-lsm | |
| --- | --- | ---: | ---: | ---: |
| TanStack DB | Cold load of 91,000 rows | 137k rows/s | 451k rows/s | 3.3× |
| TanStack DB | Bulk insert, 100,000 rows in transactions of 1,000 | 19.7k rows/s | 131k rows/s | 6.7× |
| TanStack DB | Serial insert, one row per transaction | 6.9k rows/s | 5.7k rows/s | 0.8× |
| Yjs | Cold load of 500 notes | 3.0k notes/s | 12.7k notes/s | 4.2× |
| Yjs | Editing trace, one update per keystroke | 2.1k edits/s | 36.0k edits/s | 17× |
| Automerge | Cold load of 500 notes | 2.0k notes/s | 2.8k notes/s | 1.4× |
| Automerge | Write 500 notes | 875 notes/s | 922 notes/s | 1.1× |
| fate | Cold load of 100 lists of 100 records | 2.1k records/s | 4.1k records/s | 2.0× |

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and `@nkzw/fate-indexeddb`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 60 Hz frame, one update each. Then they open the document cold in a fresh tab, once before kv settles and once after. Medians of 5 runs at size `small`, headless Chrome 157 on an Apple M5 Max with a load average of 1.9 to 3.8, from the Yjs and Automerge session of the table above. Full results: [2026-11-17T19-45-25](results/2026-11-17T19-45-25-apple-m5-max.md). The last two columns are the IndexedDB option's time over kv's: below 1×, kv is slower.

| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv | Yjs, kv vs y-indexeddb | Automerge, kv vs IndexedDB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One keystroke, with its persistence | 0.10 ms | 0.15 ms | 0.28 ms | 0.29 ms | 0.7× | 0.9× |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 | | |
| Cold open before the settle | 5.4 ms | 12 ms | 42 ms | 47 ms | 0.5× | 0.9× |
| Cold open after the settle | 5.3 ms | 12 ms | 43 ms | 48 ms | 0.5× | 0.9× |

Yjs stores each update as it happens. automerge-repo saves a document at most every 100 ms (`saveDebounceRate`), so most Automerge keystrokes write nothing, and Automerge's own load of the document takes most of its cold open on both stores. On kv a cold open includes opening the database in the new tab: 6.4 ms before the settle and 5.0 ms after for Yjs, 5.2 ms and 4.8 ms for Automerge.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite, as [bench/README.md](../bench/README.md) describes. Both collections hold 100,000 rows and load only what a query asks for. The reads, medians of 5 interleaved runs in headless Chrome 157 on an Apple M5 Max with a load average of 4.0 to 4.8. Full results: [2026-11-17T20-16-52](results/2026-11-17T20-16-52-apple-m5-max.md).

| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 37.7 ms | 7.2 ms | 5.2× |
| First query after a cold open, 6,250 rows | 65.6 ms | 63.1 ms | 1.0× |
| Warm query of one owner, 6,250 rows | 132k rows/s | 205k rows/s | 1.6× |
| 10 rows by id | 2.2k queries/s | 5.3k queries/s | 2.4× |

[bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues (about 19,500 left after deletes), 42,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Medians of 3 runs in headless Chrome 157 on an Apple M2 Pro with a load average of 1.9 to 4.4. Full results: [2026-11-18T17-24-38](results/2026-11-18T17-24-38-apple-m2-pro.md). Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it. The last column is SQLite's time over docstore's, cold / warm: above 1×, docstore is faster.

| Goal | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Issues per status in a project | 5.9 / 3.3 | 5.1 / 0.17 | 3.6 / 0.11 | 1.4× / 1.6× |
| First 50 todo issues, with assignee and label names | 2.3 / 1.2 | 6.8 / 0.55 | 9.4 / 0.47 | 0.7× / 1.2× |
| The column a sprint close just emptied | 7.7 / 5.8 | 5.9 / 0.28 | 6.4 / 1.7 | 0.9× / 0.2× |
| Rows at 90% of a project's list | 14.7 / 9.6 | 6.1 / 0.38 | 10.7 / 0.40 | 0.6× / 0.9× |
| An issue with its comments and their authors | 1.5 / 0.42 | 5.9 / 0.30 | 6.3 / 0.16 | 0.9× / 1.9× |
| First 50 open issues by priority, with comment counts | 5.2 / 2.8 | 8.8 / 1.4 | 14.3 / 0.98 | 0.6× / 1.4× |
| First 50 open issues with a label | 8.3 / 4.5 | 9.0 / 1.6 | 6.7 / 0.27 | 1.3× / 5.8× |
| First 50 open issues assigned to a person | 2.2 / 1.1 | 7.7 / 0.50 | 9.6 / 0.43 | 0.8× / 1.2× |
| The 50 most recently updated issues | 2.2 / 1.3 | 6.7 / 0.78 | 4.6 / 0.69 | 1.5× / 1.1× |
| Open issues per person, top 10 | 10.7 / 7.5 | 6.8 / 0.37 | 5.7 / 0.85 | 1.2× / 0.4× |
| First 20 issues whose title contains a word | 11.9 / 7.2 | 7.6 / 0.88 | 9.3 / 0.31 | 0.8× / 2.8× |
| Opening the store in a fresh tab | 2.1 | 24 | 14 | 1.7× |

| Writes | Dexie | SQLite on OPFS | docstore | docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: |
| Import, 47 batches of up to 1,000 rows | 2.9 s | 1.0 s | 0.84 s | 1.2× |
| Sync, 851 batches of about 50 changes | 5.6 s | 11.5 s | 3.0 s | 3.9× |
| One edit | 0.40 ms | 2.4 ms | 0.46 ms | 5.3× |
| Sprint close, 1,054 issues in one batch | 159 ms | 87 ms | 77 ms | 1.1× |

After every 10th sync batch, the 50 most recently updated issues are read again, as a list on screen would be. That read took 1.4 ms on Dexie, 0.54 ms on SQLite and 0.65 ms on docstore, 0.8× as fast as SQLite.

Warm, docstore answers 8 of the 11 goals fastest, because a tab reads on its own main thread from its page cache. Cold, it is the slowest on 4 of them: a fresh tab loads from OPFS each 32 KB page its rows sit on, and the rows of one list are scattered over many pages. Issues per status does not walk the entries it counts: a [count](counted-ranges.md#counting) adds up the tallies that writes leave on each block and run, and reads at most two blocks of each level. It is the fastest of the three, cold and warm. Open issues per person reads index entries and no issue, so cold it is the fastest of the three; warm, SQLite's group-by takes less than half its time. A window 90% deep into a list [skips to its offset](counted-ranges.md#offset) by the same tallies and reads only the entries around the window, so it costs what a first page costs: 10.7 ms cold and 0.40 ms warm, against 9.4 ms and 0.47 ms for the first 50 todo issues. Warm, that is about level with SQLite; cold, SQLite is faster, as it is on a first page. The column a sprint close emptied is where docstore is furthest behind SQLite warm, 1.7 ms against 0.28 ms: the deletes of the close sit above the settled levels, and the read merges them with the entries they delete. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart. SQLite's open runs no schema statement once the schema exists, so its first query carries the warm-up those statements would absorb. On writes, SQLite commits wait for the disk (`synchronous=FULL`, its default) where Dexie and docstore commit with Chrome's relaxed durability, and docstore commits a batch as one transaction per collection where Dexie and SQLite commit it whole.

### TanStack DB live queries

The same workspace, written through TanStack DB collections of users, projects, labels and issues, with four screens as live queries: a project's todo column, a project's open issues with a label, a person's open issues, and the 50 most recently updated issues. Each card has its assignee and label names. In a fresh tab the screens open one after another, as an app's would, each timed to its first answer; only the first starts cold. Then 851 sync batches of about 34 changes land, the first half with no screen open and the second half with all four open. Each batch is timed until it is stored and every open screen shows it. [bench/README.md](../bench/README.md#live-queries) describes the workload. Each cell is the mean per call or batch, median of 3 runs, in headless Chrome 157 on an Apple M5 Max with a load average of 5.5 to 8.5. The last column is SQLite's time over docstore's, both on demand. Full results: [2026-11-17T20-29-34](results/2026-11-17T20-29-34-apple-m5-max.md).

| | IndexedDB, eager | docstore, eager | docstore, on demand | SQLite, on demand | on demand, docstore vs SQLite |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening the collections in a fresh tab | 139 ms | 70 ms | 8.9 ms | 48 ms | 5.3× |
| First answer: a project's todo column | 18.9 ms | 18.1 ms | 18.7 ms | 31.8 ms | 1.7× |
| First answer: open issues with a label | 29.0 ms | 28.4 ms | 11.9 ms | 8.4 ms | 0.7× |
| First answer: a person's open issues | 29.3 ms | 28.2 ms | 5.2 ms | 6.8 ms | 1.3× |
| First answer: the 50 latest issues | 2.5 ms | 2.4 ms | 6.7 ms | 7.7 ms | 1.2× |
| A sync batch, no screen open | 3.1 ms | 1.2 ms | 1.3 ms | 23 ms | 19× |
| A sync batch, four screens open | 6.5 ms | 3.8 ms | 3.5 ms | 85 ms | 24× |
| Frames dropped over 426 batches, screens open | 9 | 7 | 0 | 81 | |

The todo column opens first, so it also starts the label list every screen shares, and the later screens find rows earlier joins loaded. Keeping four screens current adds 2 to 3.5 ms to a batch on IndexedDB and on docstore, eager or on demand. On SQLite it adds 61 ms. A [CPU profile](results/2026-11-16T22-25-41-apple-m2-pro-cpu-profile.txt) of that phase, from an earlier run, shows the tab idle two thirds of the time, waiting for SQLite's worker, and decoding the rows the worker sends back is the largest share of the rest. With no screen open, no contender dropped a frame.

## Bundle size

Importing `@opfs-lsm/kv` adds **21.1 kB** of JavaScript to your main bundle (gzip, 62.4 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 21.1 kB | 62.4 kB | at import |
| SharedWorker chunk | 13.0 kB | 38.3 kB | on the first `openDb` |
| wasm engine | 17.1 kB | 37.4 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **51.2 kB** | **138.0 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 30.1 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the after-open brotli total passes a budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
