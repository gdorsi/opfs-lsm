# Benchmarks

These tables compare opfs-lsm with the storage a web app would otherwise use: IndexedDB, the IndexedDB option of each framework, and SQLite on OPFS. [bench/README.md](../bench/README.md) describes each workload and how to run it.

## Storage calls

Medians of 5 runs in headless Chrome 157 on an Apple M5 Max, 100,000 entries with 16-byte keys and 100-byte values. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. The single-put row is the median of 21 runs: a run is 1,000 puts, too few for 5 runs to agree. Numbers depend on the machine. To run them yourself, see [bench/README.md](../bench/README.md).

| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 36.0k ops/s | 293k ops/s | 8.1× |
| Random point reads | 9.9k ops/s | 484k ops/s | 49× |
| Reads of missing keys | 8.9k ops/s | 1.69M ops/s | 189× |
| YCSB B: 95% read, 5% update | 9.1k ops/s | 93.8k ops/s | 10× |
| YCSB E: short range scans | 5.1k ops/s | 15.9k ops/s | 3.1× |
| Full ordered scan | 424k ops/s | 439k ops/s | 1.0× |
| Single put, awaited one at a time | 5.6k ops/s | 5.4k ops/s | 1.0× |
| Cold open | 1.8 ms | 13.3 ms | 0.1× |

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

The tables above time storage calls. These time what the user of an app waits for. Three example apps run one scripted session on opfs-lsm and on the storage the app would otherwise use. Each app's model runs headless, so only the storage differs, and every screen and every reopened document is compared with an oracle. Medians of 5 interleaved runs at size `small`, in headless Chrome 157 on the same M5 Max, with a load average of 3 to 7 from other work. A step that shows several views, such as a sort or a keystroke, gives the median view. [bench/README.md](../bench/README.md) describes each workload.

**LinearLite, 100,000 issues.** [`examples/linearlite-tanstackdb`](../examples/linearlite-tanstackdb) on docstore through `@opfs-lsm/tanstack-db`, against TanStack DB's SQLite persistence, both on demand. The SQLite side is TanStack's adapter as it ships: it sends no `LIMIT`, so a query reads every row its `where` matches, then sorts and pages them in JavaScript. A SQLite backend written by hand would be faster.

| Step | SQLite | docstore | |
| --- | ---: | ---: | ---: |
| First sync, until caught up with the server | 15.5 s | 2.7 s | 5.8× |
| First sync, then the list's total | 21.0 ms | 418 ms | 0.05× |
| Cold open, open the database | 39.9 ms | 11.5 ms | 3.5× |
| First rows, once the database is open | 803 ms | 35.8 ms | 22× |
| Cold open, the status counts once the total shows | 3.4 ms | 22.0 ms | 0.15× |
| Change the sort | 705 ms | 4.5 ms | 157× |
| Filter by status or priority, the list | 999 ms | 12.5 ms | 80× |
| Search, per keystroke, the list | 999 ms | 11.0 ms | 91× |
| Jump deep into the list | 1.0 s | 100 ms | 10× |
| Open the board | 4.0 s | 17.9 ms | 223× |
| Open a thread, fetched from the server | 5.8 ms | 2.0 ms | 3.0× |
| Main thread blocked while typing a search | 3.4 s | 0 ms | |

After a cold open, docstore shows the list's total 72 ms after its first rows. SQLite reads every matching row before it shows any, so its total comes with them. The status counts follow the list: after a filter they take 2.62 ms on docstore against 84.0 ms on SQLite, and per keystroke 7.81 ms against 250 ms.

**Whiteboard, 1,000 shapes.** [`examples/whiteboard-yjs`](../examples/whiteboard-yjs) through `@opfs-lsm/yjs`, against y-indexeddb.

| Step | y-indexeddb | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Open the database and a new board, then draw 1,000 shapes | 43.6 ms | 46.2 ms | 0.94× |
| 1,000 edits, until saved | 97.7 ms | 38.7 ms | 2.5× |
| The save after the last edit | 58.4 ms | 0.34 ms | 170× |
| 100 undos and redos, until saved | 17.6 ms | 6.5 ms | 2.7× |
| Drag a shape, per move, p99.9 | 3.1 ms | 7.0 ms | 0.45× |
| Drag 200 shapes, per move, p99.9 | 3.4 ms | 9.5 ms | 0.36× |
| Reopen the board | 79.3 ms | 106 ms | 0.75× |

The session never pauses for a second, so neither store merges the board's updates while it is open, and the reopen replays every one of them.

**Pages, a 50 KB page and 1,000 keystrokes.** [`examples/pages-fate-automerge`](../examples/pages-fate-automerge) with fate's cache and the Automerge page bodies on one kv database, against `@nkzw/fate-indexeddb` and automerge-repo's `IndexedDBStorageAdapter`. Once the database is open, Automerge and the app's model take most of every step, so the two stores are level. Against a third contender that keeps everything in memory, either store adds at most 8 ms to opening a page, pasting or a keystroke.

| Step | IndexedDB | opfs-lsm | |
| --- | ---: | ---: | ---: |
| Open the database | 2.88 ms | 7.04 ms | 0.41× |
| Open a new page | 21.0 ms | 18.9 ms | 1.1× |
| Paste 50 KB | 184 ms | 193 ms | 0.96× |
| Keystroke, p50 | 360 µs | 360 µs | 1.0× |
| Keystroke, p99 | 2.50 ms | 2.75 ms | 0.91× |
| Reopen after a reload | 129 ms | 137 ms | 0.94× |

## Bundle size

Importing `@opfs-lsm/kv` adds **18.5 kB** of JavaScript to your main bundle (gzip, 54.2 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 18.5 kB | 54.2 kB | at import |
| SharedWorker chunk | 12.2 kB | 36.0 kB | on the first `openDb` |
| wasm engine | 16.6 kB | 36.4 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **47.4 kB** | **126.7 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 28.8 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the after-open brotli total passes a budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](../bench/README.md#bundle-size).
