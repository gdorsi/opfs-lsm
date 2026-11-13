# opfs-lsm

A key-value store for the browser, built to be the storage layer under local-first apps and sync engines. It writes up to 7× faster than IndexedDB, reads up to 145× faster, and every tab of an origin shares one database with a live change feed.

> [!WARNING]
> opfs-lsm is not stable yet. Expect breaking changes, including to the on-disk format, so data written by one version may not open in the next. Two things are missing before a stable release:
>
> - Tests in browsers other than desktop Chrome.
> - Final storage formats. The WAL and SST layouts still change while we tune performance.

## Why not just use IndexedDB?

Everyone who has worked with IndexedDB ends up realizing that it has many shortcomings. Nolan Lawson [put it this way](https://nolanlawson.com/2021/08/22/speeding-up-indexeddb-reads-and-writes/): "IndexedDB has a lot of detractors, and I think most of the criticism is justified."

- **IndexedDB [is slow](https://rxdb.info/slow-indexeddb.html). Not slow like a database on a cheap server, even slower!**
- **No live subscription.** So you have to build your own if you want multiple tabs to be in sync.
- **A few other quirks.** Like auto-committed transactions and others, described [here](https://gist.github.com/pesterhazy/4de96193af89a6dd5ce682ce2adff49a).

Now we have raw file access through the Origin Private File System (OPFS), but building something good on top of it is REALLY HARD!

The synchronous API is in practice unusable for a production-ready DB:

- It exists only in a dedicated WebWorker.
- Only one tab can open a file at a time. The modes that lift this limit, `read-only` and `readwrite-unsafe`, are supported only by Chrome and Edge. Notion [built on this API](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite) and found that "any attempt to open the SQLite database in a subsequent tab will simply throw an error". It ended up with a SharedWorker that picks one "active tab" to run every query.
- With the current state of browsers, it is impossible to build something that survives all the freezing and throttling that browsers apply to background tabs.

That leaves us with the OPFS async API, which is also quite challenging to use when building a DB, because writes are applied as full file snapshots: a write shows up only when the file is closed, and it replaces the whole file.

With `@opfs-lsm/kv` I'm using the following design to work around the limits of the async API:

- The architecture is a [log-structured merge tree](https://en.wikipedia.org/wiki/Log-structured_merge-tree) (LSM), as in LevelDB and RocksDB. Its data files, called SST files, are written once and never changed, which fits an API that publishes whole files.
- Only a SharedWorker writes to OPFS, and only when it flushes the write-ahead log (WAL) into a new SST file or compacts existing ones.
- Every tab reads the SST files directly, so a read sends no message to a worker.
- The WAL is persisted in IndexedDB, whose transactions already put the writes of every tab in one order, so inserts don't require any kind of coordination on our side.

More detail is in [How it works](#how-it-works).

## What kv offers

`@opfs-lsm/kv` is designed to be as fast and as small as possible, and to work as a building block that handles persistence for higher-level solutions (CRDTs, sync engines, etc.).

It is a key-value store that supports all the features required to:

- build an indexed database (see [`@opfs-lsm/docstore`](packages/docstore) for a reference implementation)
- build a cache storage with TTL (TODO)

It offers:

- **Live subscriptions.** It is easy to subscribe to changes in the DB, including the ones coming from other tabs.
- **A sequence number for every write.** `put`, `delete` and `batch` resolve with the seq of their record, and `changes` and `view` report the same numbers. Use them as a cursor for an outbox or a sync checkpoint.
- **Consistent reads.** `view` reads a snapshot that later writes do not change. `update` reads keys and writes in one transaction, with no window for another tab to write in between.
- **Ordered scans.** `range` scans a key range or a prefix, forward or in reverse, with a limit. `rangeJoin` scans index entries and reads the row of each one, all from one state.
- **Bytes in, bytes out.** Keys and values are `Uint8Array`, so the encoding is yours.

### Benchmarks

Medians of 5 runs in headless Chrome 157 on an Apple M5 Max, 100,000 entries with 16-byte keys and 100-byte values. The IndexedDB baseline is one object store with one transaction per batch of 1,000, and it calls `commit()` on each one. The single-put row is the median of 21 runs: a run is 1,000 puts, too few for 5 runs to agree. Numbers depend on the machine. To run them yourself, see [bench/README.md](bench/README.md).

| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 42.2k ops/s | 319k ops/s | 7.6× |
| Random point reads | 12.6k ops/s | 559k ops/s | 44× |
| Reads of missing keys | 12.1k ops/s | 1.75M ops/s | 145× |
| YCSB B: 95% read, 5% update | 12.6k ops/s | 109k ops/s | 8.7× |
| YCSB E: short range scans | 6.0k ops/s | 16.8k ops/s | 2.8× |
| Full ordered scan | 589k ops/s | 520k ops/s | 0.9× |
| Single put, awaited one at a time | 6.4k ops/s | 6.2k ops/s | 1.0× |
| Cold open | 1.3 ms | 9.9 ms | 0.1× |

The framework adapters show the same shape. TanStack DB bulk inserts run at 125k rows/s against 19k on its IndexedDB adapter, and a cold load of about 91,000 rows takes 390 ms against 750 ms. Loading 500 Yjs notes cold runs at 10.1k notes/s against 3.3k on y-indexeddb.

### Bundle size

Importing `@opfs-lsm/kv` adds **17.2 kB** of JavaScript to your main bundle (gzip, 49.8 kB raw). The SharedWorker and the wasm engine are not in it. Both load lazily, on the first `openDb`, and only when a page opens a database:

| | gzip | raw | loaded |
| --- | ---: | ---: | --- |
| Main-thread JS | 17.2 kB | 49.8 kB | at import |
| SharedWorker chunk | 11.5 kB | 33.5 kB | on the first `openDb` |
| wasm engine | 16.3 kB | 35.8 kB | on the first `openDb`, one file for the tab and the SharedWorker |
| **Total after open** | **45.1 kB** | **119.1 kB** | |

For comparison, Dexie is 31.4 kB gzip and `y-indexeddb` adds 1.2 kB on top of Yjs. A page that imports kv but never opens a database never downloads the other 27.9 kB. Each file is compressed on its own (gzip -9), as a server sends it, and CI fails if the after-open brotli total passes a budget. To measure it yourself, run `pnpm bench:size`; see [bench/README.md](bench/README.md#bundle-size).

### When IndexedDB is still the better fit

If read and write performance of the DB is not a concern in your app.

## Packages

| Package | What it is | Status |
| --- | --- | --- |
| [`@opfs-lsm/kv`](packages/kv) | The key-value store. Start here. | Beta |
| [`@opfs-lsm/tanstack-db`](packages/tanstack-db) | TanStack DB collections kept in docstore, with other tabs' writes arriving live and on-demand queries read through docstore's indexes. | Beta |
| [`@opfs-lsm/yjs`](packages/yjs) | A Yjs provider shaped like y-indexeddb. | Beta |
| [`@opfs-lsm/automerge`](packages/automerge) | A storage adapter for automerge-repo. | Beta |
| [`@opfs-lsm/fate`](packages/fate) | Persistence storage for the fate data client, shaped like fate's IndexedDB storage. | Beta |
| [`@opfs-lsm/docstore`](packages/docstore) | A document store with declared indexes, paged queries, snapshot reads and a change feed. | Beta |

Each adapter keeps many documents or collections in one kv database. `@opfs-lsm/docstore` is the query layer on top of kv: JSON documents in collections, with indexes declared in a versioned schema.

The packages are published on npm. To build them from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quickstart

```ts
import { openDb, prefixBound } from "@opfs-lsm/kv";

const db = await openDb({ name: "app" });
const text = new TextEncoder();
const read = new TextDecoder();

await db.put(text.encode("todo:1"), text.encode("Buy milk"));

await db.batch((tx) => {
  tx.put(text.encode("todo:2"), text.encode("Walk the dog"));
  tx.delete(text.encode("todo:1"));
});

const value = await db.get(text.encode("todo:2"));

for await (const { key, value } of db.range({ ...prefixBound(text.encode("todo:")), limit: 50 })) {
  console.log(read.decode(key), read.decode(value));
}

const unsubscribe = db.changes((event) => {
  if (event.kind === "append") console.log("a tab wrote record", event.seq, event.ops);
  if (event.kind === "gap") console.log("records were folded, read again");
});
```

The promise from `put`, `delete` or `batch` is the ack. When it resolves, the write is committed to the WAL in IndexedDB, and this tab reads it. Other tabs see it when their handle applies the record, and `sync()` waits for that. The full API, the options and the errors are in [packages/kv/README.md](packages/kv/README.md).

## Browser support

`@opfs-lsm/kv` needs SharedWorker, OPFS, IndexedDB and WebAssembly in the page. Where SharedWorker or OPFS is missing, or the wasm engine or the IndexedDB store fails to load, `openDb` rejects with `StorageUnavailableError`. It never falls back to memory.

Three APIs set the minimum version in every browser. Everything else kv uses shipped earlier, including Web Locks, BroadcastChannel and the WebAssembly features in the engine.

| API | Chrome, Edge | Firefox | Safari | Chrome Android, Android WebView | Firefox Android | Safari iOS |
| --- | --- | --- | --- | --- | --- | --- |
| `SharedWorker` with `type: "module"` | 80 | 114 | 16 | 148 | 114 | 16 |
| OPFS `FileSystemFileHandle.createWritable()` | 86 | 111 | 26 | 109 | 111 | 26 |
| `crypto.randomUUID()` | 92 | 95 | 15.4 | 92 | 95 | 15.4 |
| **Minimum for kv** | **92** | **114** | **26** | **148** | **114** | **26** |

- Safari had OPFS from 15.2, but it could only write a file through `createSyncAccessHandle()`, which exists only in a dedicated WebWorker. kv writes SST files from its SharedWorker, so it needs `createWritable()`, added in Safari 26.
- Chrome on Android had no SharedWorker until 148. Samsung Internet has none, so kv does not run there.
- `@opfs-lsm/tanstack-db` also calls `Promise.withResolvers()`, which raises its minimum to Chrome and Edge 119 and Firefox 121.

Versions are from [MDN browser-compat-data](https://github.com/mdn/browser-compat-data) 8.1.8. The engine is tested in desktop Chrome. Firefox, Safari and mobile browsers are not tested yet.

## How it works

kv is a log-structured merge tree (LSM). An ack means the write is one row in a write-ahead log (WAL) in IndexedDB, which all tabs share. Each database has one SharedWorker that moves the WAL into sorted, immutable SST files in OPFS and merges those files in the background. Each tab keeps the writes not yet in an SST file in memory, so reads do not go back to the WAL.

The storage layout, the consistency rules and the recovery after a crash are in [docs/design.md](docs/design.md). How each promise is checked, with formal models and kill tests in real Chrome, is in [docs/verification.md](docs/verification.md).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, `pnpm test`, `pnpm bench`, and how releases work.

## License

MIT
