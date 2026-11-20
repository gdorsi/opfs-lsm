# How opfs-lsm works

Neither storage API in the browser gives a fast database that every tab can share. This page explains why, and how kv works around the limits of each. The formats on disk and the exact protocols are in [Engine design](design.md).

## IndexedDB is slow and has no change feed

Every browser ships IndexedDB, and most libraries that keep data in the browser store it there. In the [benchmarks](benchmarks.md#storage-calls), it answers random point reads 29× slower than kv. It has no change feed, so an app that keeps several tabs in sync builds its own messaging between them. Its transactions also [commit on their own](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction) as soon as no request is pending, so a transaction cannot wait for other work, such as a `fetch`.

## Neither OPFS API fits a shared database

The Origin Private File System (OPFS) gives each site private files in the browser. It has two ways to write them.

The synchronous API, `createSyncAccessHandle()`, exists only in a dedicated WebWorker, a script that a page starts with `new Worker()`. [Only one tab can open a file with it at a time](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle). The modes that lift this limit, `read-only` and `readwrite-unsafe`, run only in Chrome and Edge. A database on this API makes one tab own the file and serve every other tab. Browsers freeze and throttle background tabs, so that owner can stop answering at any time. Handing a file to another tab also works differently in each browser. In [our probes](research/opfs-worker-probes.md), a stopped dedicated WebWorker released its lock after about 2 s in Chrome, and in under 40 ms in Safari and Firefox.

The asynchronous API, `createWritable()`, also works in a SharedWorker, but it publishes whole files. A write shows up only when the file closes, and it replaces the whole file. A database that changes a file in place cannot run on it.

## An LSM tree writes whole files

kv is a log-structured merge tree (LSM), the design of LevelDB and RocksDB. An LSM keeps its data in sorted files, called SST files, that it writes once and never changes. That fits an API that publishes whole files. kv splits the work this way:

- **A write is one row in IndexedDB.** Each write appends a row to the write-ahead log (WAL), a list of writes that kv keeps in IndexedDB. The committed row is the ack. IndexedDB already puts the transactions of every tab in one order, so tabs need no other coordination to write.
- **One SharedWorker writes the files.** A SharedWorker is a worker that every tab of a site shares, and each database has one. It moves the WAL into new SST files in OPFS, then merges SST files in the background. No other code writes to OPFS.
- **Each tab reads by itself.** A tab keeps in memory the writes that are not in an SST file yet, and it reads the SST files directly. A read sends no message to a worker.
- **Tabs announce their writes.** After a write commits, its tab posts it on a BroadcastChannel, and the other tabs apply it.

<!-- figure: stack -->

## What the design costs

The split makes reads and batched writes fast. It also costs something:

- **Opening is slower.** The first `openDb` loads the SharedWorker and a wasm engine. A cold open takes 4.9 ms, against 0.4 ms for IndexedDB.
- **A single write costs what it costs in IndexedDB.** Every ack waits for an IndexedDB commit, so one awaited write at a time runs at the speed of IndexedDB. kv gains when writes come in groups.
- **Other tabs see a write a moment later.** The BroadcastChannel message arrives after the ack. `db.sync()` reads the WAL to catch up.
- **It needs SharedWorker.** Samsung Internet and Android WebView have none, so kv does not run there.

For an app that reads its data on every screen, the faster reads outweigh these costs. For an app that stores little and opens often, IndexedDB is the better trade.

## Consistent, not durable

When a write's promise resolves, the write is in IndexedDB, and it survives a crash of its tab. It may not be on the disk yet. kv commits in IndexedDB's default mode, which since Chrome 121 [completes once the data reaches the operating system](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed/). The operating system usually writes it to disk within a few seconds. The `strict` mode does not promise an immediate disk write either, and neither does `createWritable()`, which kv writes its OPFS files with. A power loss can therefore lose the last writes.

What kv does promise is consistency. After a power loss, it opens with every write up to some point and none after it. No write goes missing from the middle, and a batch is there whole or not at all.

The formats on disk, the consistency rules, and the recovery after a crash are in [Engine design](design.md). How each promise is checked, with formal models and kill tests in real Chrome, is in [Verification](verification.md).
