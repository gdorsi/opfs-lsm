# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it.

## Storage calls

Medians of 10 runs, from two sessions of 5, in headless Chrome 157 on an Apple M5 Max with a load average of 6 to 11 from other work, 100,000 entries with 16-byte keys and 100-byte values. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. The single-put row is the median of 21 runs: a run is 1,000 puts, too few for 5 runs to agree. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md). The run files behind this table were not kept; the full results of each newer table are in [results/](results/), linked under it.

| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 30.2k ops/s | 432k ops/s | 14× |
| Random point reads | 16.4k ops/s | 488k ops/s | 30× |
| Reads of missing keys | 17.8k ops/s | 1.64M ops/s | 92× |
| YCSB B: 95% read, 5% update | 17.5k ops/s | 130k ops/s | 7.4× |
| YCSB E: short range scans | 6.3k ops/s | 19.2k ops/s | 3.0× |
| Full ordered scan | 604k ops/s | 1.03M ops/s | 1.7× |
| Single put, awaited one at a time | 9.1k ops/s | 7.4k ops/s | 0.8× |
| Cold open | 1.2 ms | 7.8 ms | 0.2× |

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
| fate | Queue 300 mutations offline | 201 ops/s | 263 ops/s | 1.3× |

The IndexedDB options are TanStack DB's `indexedDBCollectionOptions`, y-indexeddb, automerge-repo's `IndexedDBStorageAdapter` and `@nkzw/fate-indexeddb`. Both TanStack DB collections run in eager mode, the default `syncMode`: a collection loads every row when it opens. `indexedDBCollectionOptions` has no on-demand mode.

### Typing, then reopening

The editing-trace workloads write the trace's first 25,700 keystrokes, then type the last 300 at one per 16 ms frame, one update each. Then they open the document cold in a fresh tab, once before kv settles and once after. Medians of 3 runs (6 for Yjs on kv) at size `small`, headless Chrome 157 on an Apple M2 Pro with a load average of 2 to 5. Full results: Automerge in [2026-11-16T19-59-22](results/2026-11-16T19-59-22-apple-m2-pro.md), whose Yjs rows predate the pause after `persist` and are not used; Yjs in [2026-11-16T21-33-15](results/2026-11-16T21-33-15-apple-m2-pro.md) and [2026-11-16T21-36-08](results/2026-11-16T21-36-08-apple-m2-pro.md), kv only.

| | y-indexeddb | Yjs on kv | automerge-repo IndexedDB | Automerge on kv |
| --- | ---: | ---: | ---: | ---: |
| One keystroke, with its persistence | 0.28 ms | 0.36 ms | 0.58 ms | 0.58 ms |
| Frames dropped over 300 keystrokes | 0 | 0 | 0 | 0 |
| Cold open before the settle | 7.2 ms | 16 ms | 58 ms | 64 ms |
| Cold open after the settle | 7.5 ms | 52 ms | 58 ms | 65 ms |

Automerge's own load of the document takes most of its cold open on both stores. kv's open in a fresh tab took 5 to 8 ms in most opens before the settle and about 44 ms in most opens after it. The cause is not known yet. In one Yjs run on kv out of six, each cold open took 17 s. In that run the merge of the stored updates left almost all of them in place, which is an open bug.

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Its adapter is patched to send `LIMIT` and equality on numbers to SQLite, as [bench/README.md](../bench/README.md) describes. Both collections hold 100,000 rows and load only what a query asks for. The reads, medians of 5 interleaved runs in headless Chrome 157 on an Apple M2 Pro with a load average of about 3. The run files behind this table were not kept:

| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 48.1 ms | 12.0 ms | 4.0× |
| First query after a cold open, 6,250 rows | 88.1 ms | 88.1 ms | 1.0× |
| Warm query of one owner, 6,250 rows | 90.7k rows/s | 131k rows/s | 1.4× |
| 10 rows by id | 1.6k queries/s | 3.6k queries/s | 2.3× |

The bench also runs `docstore` against Dexie. [bench/README.md](../bench/README.md) lists every family and workload.

## Goal benchmarks

The tables above time storage calls. These time the questions an app's screens ask. A task tracker with 20,000 issues, 43,000 comments, 120 people, 24 projects and 30 labels is built from its history: an import, then sync batches that move issues between statuses and people, then a settle, then a sprint close and single edits on top. Each library replays the history through its own write API. It then answers each goal with its own query API and indexes, and every answer is checked against an oracle. [bench/README.md](../bench/README.md#goal-workloads) lists the goals, and [the research note](research/goal-driven-benchmarks.md) explains the method.

Medians of 3 runs in headless Chrome 157 on an Apple M2 Pro with a load average of 1.1 to 4.9. Full results: [2026-11-16T19-30-45](results/2026-11-16T19-30-45-apple-m2-pro.md). Each cell is cold / warm in ms: cold is the first call after opening the store in a fresh tab, warm repeats it.

| Goal | Dexie | SQLite on OPFS | docstore |
| --- | ---: | ---: | ---: |
| Issues per status in a project | 10.6 / 8.0 | 1.6 / 0.26 | 5.6 / 0.41 |
| First 50 todo issues, with assignee and label names | 2.5 / 1.0 | 2.9 / 0.50 | 7.1 / 0.42 |
| The column a sprint close just emptied | 10.2 / 6.2 | 2.0 / 0.29 | 6.2 / 1.3 |
| Rows at 90% of a project's list | 18.3 / 12.4 | 2.2 / 0.43 | 12.6 / 1.9 |
| An issue with its comments and their authors | 1.5 / 0.43 | 1.9 / 0.36 | 5.4 / 0.14 |
| First 50 open issues by priority, with comment counts | 4.7 / 2.9 | 6.8 / 2.3 | 13.4 / 1.3 |
| First 50 open issues with a label | 7.0 / 4.7 | 8.3 / 2.9 | 6.4 / 0.35 |
| First 50 open issues assigned to a person | 2.4 / 1.2 | 4.0 / 0.74 | 9.6 / 0.48 |
| The 50 most recently updated issues | 2.1 / 1.2 | 2.5 / 0.70 | 3.6 / 0.63 |
| Open issues per person, top 10 | 11.9 / 9.1 | 3.2 / 0.50 | 14.8 / 4.3 |
| First 20 issues whose title contains a word | 6.2 / 5.8 | 2.4 / 0.77 | 6.3 / 0.27 |
| Opening the store in a fresh tab | 2.1 | 29 | 17 |

| Writes | Dexie | SQLite on OPFS | docstore |
| --- | ---: | ---: | ---: |
| Import, 44 batches of 1,000 rows | 2.9 s | 1.0 s | 0.80 s |
| Sync, 875 batches of 50 changes | 5.8 s | 11.7 s | 3.2 s |
| One edit | 0.40 ms | 1.1 ms | 0.61 ms |
| Sprint close, 1,027 issues in one batch | 155 ms | 85 ms | 61 ms |

During the sync, the 50 most recently updated issues are read again after every 10th batch, as a list on screen would be. That read took 1.5 ms on Dexie, 0.58 ms on SQLite and 0.82 ms on docstore, medians of a later run with a load average of 4 to 5: [2026-11-16T19-59-22](results/2026-11-16T19-59-22-apple-m2-pro.md).

Warm, docstore answers 7 of the 11 goals fastest, because a tab reads on its own main thread from its page cache. Cold, it is the slowest on most goals: the 50 rows of a page each sit on their own 32 KB page, which a fresh tab loads from OPFS. A group-by and a deep window cost more on docstore, because its queries return neither index values nor an offset. IndexedDB keeps its cache in the browser process, which outlives the tab, so Dexie's cold column is a reload, not a browser restart.

## Bundle size

Importing `@opfs-lsm/kv` adds **18.8 kB** of JavaScript to your main bundle (gzip, 55.0 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 18.8 kB | 55.0 kB | at import |
| SharedWorker chunk | 12.2 kB | 36.0 kB | on the first `openDb` |
| wasm engine | 16.6 kB | 36.4 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **47.6 kB** | **127.5 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 28.8 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the after-open brotli total passes a budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
