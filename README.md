# opfs-lsm

A key-value store for the browser, built to be the storage layer under local-first apps and sync engines. It writes up to 7× faster than IndexedDB, reads up to 30× faster, and every tab of an origin shares one database with a live change feed.

> [!WARNING]
> opfs-lsm is not stable yet. Expect breaking changes, including to the on-disk format, so data written by one version may not open in the next. Two things are missing before a stable release:
>
> - Tests on mobile browsers.
> - Final storage formats. The WAL and SST layouts still change while we tune performance.

## Why kv instead of IndexedDB

A sync engine needs three things from browser storage: fast writes, fast reads, and one consistent view across tabs. IndexedDB gives the third only with glue code, and is slow at the first two. `@opfs-lsm/kv` gives all three.

- **Every tab shares one database.** Each tab opens the same name. `changes` delivers every write from every tab to every open handle, once each and in order. A handle that falls behind gets a `gap` event and reads again. Your engine needs no `BroadcastChannel` code and no leader election.
- **Every write has a sequence number.** `put`, `delete` and `batch` resolve with the seq of their record, and `changes` and `view` report the same numbers. Use them as a cursor for an outbox or a sync checkpoint.
- **Reads are consistent.** `view` reads a snapshot that later writes do not change. `update` reads keys and writes in one transaction, with no window for another tab to write in between.
- **Point reads never touch IndexedDB.** They come from memory and from sorted files in the Origin Private File System (OPFS), with Bloom filters that answer a missing key without a disk read.

### Benchmarks

Medians of 5 runs in headless Chrome 157 on an Apple M5 Max, 100,000 entries with 16-byte keys and 100-byte values. The IndexedDB baseline is one object store with one transaction per batch of 1,000. Numbers depend on the machine. To run them yourself, see [bench/README.md](bench/README.md).

| Workload | IndexedDB | kv | |
| --- | ---: | ---: | ---: |
| Random writes, batches of 1,000 | 43.4k ops/s | 302k ops/s | 7.0× |
| Random point reads | 14.5k ops/s | 429k ops/s | 30× |
| Reads of missing keys | 13.8k ops/s | 1.75M ops/s | 127× |
| YCSB B: 95% read, 5% update | 14.5k ops/s | 102k ops/s | 7.0× |
| YCSB E: short range scans | 6.6k ops/s | 18.3k ops/s | 2.8× |
| Full ordered scan | 585k ops/s | 604k ops/s | 1.0× |
| Single put, awaited one at a time | 6.6k ops/s | 5.5k ops/s | 0.8× |
| Cold open | 1.0 ms | 8.5 ms | 0.1× |

The framework adapters show the same shape. TanStack DB bulk inserts run at 136k rows/s against 21k on its IndexedDB adapter. Loading 500 Yjs notes cold runs at 11.2k notes/s against 3.6k on y-indexeddb.

### When IndexedDB is still the better fit

- Your app opens a database and closes it after a handful of reads. Opening kv starts a SharedWorker and loads a wasm engine, which costs about 8 ms.
- Your app writes one key at a time and awaits each write. Each kv write is also one IndexedDB transaction, so kv cannot beat IndexedDB there.
- Your app must run where SharedWorker, OPFS or WebAssembly is missing. See [Browser support](#browser-support).

## Packages

| Package | What it is | Status |
| --- | --- | --- |
| [`@opfs-lsm/kv`](packages/kv) | The key-value store. Start here. | Beta |
| [`@opfs-lsm/tanstack-db`](packages/tanstack-db) | Persistence for TanStack DB collections, with other tabs' writes arriving live. | Beta |
| [`@opfs-lsm/yjs`](packages/yjs) | A Yjs provider shaped like y-indexeddb. | Beta |
| [`@opfs-lsm/automerge`](packages/automerge) | A storage adapter for automerge-repo. | Beta |
| [`@opfs-lsm/docstore`](packages/docstore) | A document store with declared indexes. | Experiment, not published |

Each adapter keeps many documents or collections in one kv database. `@opfs-lsm/docstore` exists to test the kv API from the point of view of a query layer. It can change heavily or go away.

The packages are not on npm yet. Until the first release, build them from source as [CONTRIBUTING.md](CONTRIBUTING.md) describes.

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

`@opfs-lsm/kv` needs SharedWorker, OPFS, IndexedDB and WebAssembly in the page. Where one is missing, `openDb` rejects with `StorageUnavailableError`. It never falls back to memory.

Three APIs set the minimum version in every browser. Everything else kv uses shipped earlier, including Web Locks, BroadcastChannel and the WebAssembly features in the engine.

| API | Chrome, Edge | Firefox | Safari | Chrome Android, Android WebView | Firefox Android | Safari iOS |
| --- | --- | --- | --- | --- | --- | --- |
| `SharedWorker` with `type: "module"` | 80 | 114 | 16 | 148 | 114 | 16 |
| OPFS `FileSystemFileHandle.createWritable()` | 86 | 111 | 26 | 109 | 111 | 26 |
| `structuredClone()` | 98 | 94 | 15.4 | 98 | 94 | 15.4 |
| **Minimum for kv** | **98** | **114** | **26** | **148** | **114** | **26** |

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
