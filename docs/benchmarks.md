# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it.

## Storage calls

Medians of 10 runs, from two sessions of 5, in headless Chrome 157 on an Apple M5 Max with a load average of 7 to 11 from other work, 100,000 entries with 16-byte keys and 100-byte values. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. The single-put row is the median of 21 runs: a run is 1,000 puts, too few for 5 runs to agree. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

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

The framework adapters, each against the IndexedDB option its framework ships, at size `small`:

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

### On demand, against SQLite

In on-demand mode the comparison is TanStack DB's SQLite persistence, `@tanstack/browser-db-sqlite-persistence`, which runs wa-sqlite on OPFS in a dedicated WebWorker. Both collections hold 100,000 rows and load only what a query asks for. The reads, medians of 5 interleaved runs:

| Workload | SQLite | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Cold open | 41.6 ms | 11.7 ms | 3.6× |
| First query after a cold open, 6,250 rows | 65.2 ms | 81.6 ms | 0.80× |
| Warm query of one owner, 6,250 rows | 116k rows/s | 169k rows/s | 1.5× |
| 10 rows by id | 1.9k queries/s | 4.1k queries/s | 2.1× |

The bench also runs `docstore` against Dexie. [bench/README.md](../bench/README.md) lists every family and workload.

## App benchmarks

The tables above time storage calls. These time what the user of an app waits for. Three example apps run one scripted session on opfs-lsm and on the storage the app would otherwise use. Each app's model runs headless, so only the storage differs, and every screen and every reopened document is compared with an oracle. Medians of 5 interleaved runs at size `small`, in headless Chrome 157 on the same M5 Max, with a load average of 4 to 11 from other work. A step that shows several views, such as a sort or a keystroke, gives the median view. [bench/README.md](../bench/README.md) describes each workload.

**LinearLite, 100,000 issues.** [`examples/linearlite-tanstackdb`](../examples/linearlite-tanstackdb) on docstore through `@opfs-lsm/tanstack-db`, against TanStack DB's SQLite persistence, both on demand. The SQLite side is TanStack's adapter as it ships: it sends no `LIMIT`, so a query reads every row its `where` matches, then sorts and pages them in JavaScript. A SQLite backend written by hand would be faster.

| Step | SQLite | docstore | |
| --- | ---: | ---: | ---: |
| First sync, until caught up with the server | 14.9 s | 2.8 s | 5.3× |
| First sync, then the list's total | 20.0 ms | 401 ms | 0.05× |
| Cold open, open the database | 35.8 ms | 12.0 ms | 3.0× |
| First rows, once the database is open | 639 ms | 33.8 ms | 19× |
| Cold open, the status counts once the total shows | 3.39 ms | 21.0 ms | 0.16× |
| Change the sort | 639 ms | 4.99 ms | 128× |
| Filter by status or priority, the list | 803 ms | 9.98 ms | 80× |
| Search, per keystroke, the list | 868 ms | 11.0 ms | 79× |
| Jump deep into the list | 770 ms | 60.4 ms | 13× |
| Open the board | 2.9 s | 22.0 ms | 134× |
| Open a thread, fetched from the server | 6.02 ms | 2.02 ms | 3.0× |
| Main thread blocked while typing a search | 3.2 s | 0 ms | |

After a cold open, docstore shows the list's total 46.1 ms after its first rows. SQLite reads every matching row before it shows any, so its total comes with them. The status counts follow the list: after a filter they take 2.62 ms on docstore against 60.4 ms on SQLite, and per keystroke 7.30 ms against 234 ms.

**Whiteboard, 1,000 shapes.** [`examples/whiteboard-yjs`](../examples/whiteboard-yjs) through `@opfs-lsm/yjs`, against y-indexeddb.

| Step | y-indexeddb | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Open the database and a new board, then draw 1,000 shapes | 40.0 ms | 42.2 ms | 0.95× |
| 1,000 edits, until saved | 109 ms | 41.0 ms | 2.7× |
| The save after the last edit | 60.4 ms | 1.95 ms | 31× |
| 100 undos and redos, until saved | 21.5 ms | 7.8 ms | 2.8× |
| Drag a shape, per move, p99.9 | 408 µs | 472 µs | 0.86× |
| Drag 200 shapes, per move, p99.9 | 2.37 ms | 2.37 ms | 1.0× |
| Reopen the board | 75.0 ms | 87.0 ms | 0.86× |

The session never pauses for a second, so neither store merges the board's updates while it is open, and the reopen replays every one of them.

**Pages, a 50 KB page and 1,000 keystrokes.** [`examples/pages-fate-automerge`](../examples/pages-fate-automerge) with fate's cache and the Automerge page bodies on one kv database, against `@nkzw/fate-indexeddb` and automerge-repo's `IndexedDBStorageAdapter`. Once the database is open, Automerge and the app's model take most of every step, so the two stores are level. Against a third contender that keeps everything in memory, kv adds at most 2.1 ms to opening a page, pasting or a keystroke, and IndexedDB at most 12 ms, to opening a page.

| Step | IndexedDB | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Open the database | 3.14 ms | 7.55 ms | 0.42× |
| Open a new page | 23.0 ms | 16.9 ms | 1.4× |
| Paste 50 KB | 184 ms | 184 ms | 1.0× |
| Keystroke, p50 | 376 µs | 376 µs | 1.0× |
| Keystroke, p99 | 2.24 ms | 2.24 ms | 1.0× |
| Reopen after a reload | 129 ms | 139 ms | 0.93× |

## Bundle size

Importing `@opfs-lsm/kv` adds **18.8 kB** of JavaScript to your main bundle (gzip, 55.0 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 18.8 kB | 55.0 kB | at import |
| SharedWorker chunk | 12.2 kB | 36.0 kB | on the first `openDb` |
| wasm engine | 16.6 kB | 36.4 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **47.6 kB** | **127.5 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 28.8 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the after-open brotli total passes a budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
