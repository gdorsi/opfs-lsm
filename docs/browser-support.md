# Browser support

`@opfs-lsm/kv` needs IndexedDB, OPFS and WebAssembly in the page. Its host, which flushes and compacts, needs SharedWorker and OPFS with `createWritable()`. Where either is missing, `openDb` opens [without a host](#without-a-host). Where IndexedDB or `navigator.storage.getDirectory` is missing, SharedWorker or OPFS fails to start, or the wasm engine or the IndexedDB store fails to load, `openDb` rejects with `StorageUnavailableError`. It never falls back to memory.

With a host, three APIs set the minimum version in every browser. Everything else kv uses shipped earlier, including Web Locks, BroadcastChannel and the WebAssembly features in the engine.

| API | Chrome, Edge | Firefox | Safari | Chrome Android | Firefox Android | Safari iOS |
| --- | --- | --- | --- | --- | --- | --- |
| `SharedWorker` with `type: "module"` | 80 | 114 | 16 | 148 | 114 | 16 |
| OPFS `FileSystemFileHandle.createWritable()` | 86 | 111 | 26 | 109 | 111 | 26 |
| `crypto.randomUUID()` | 92 | 95 | 15.4 | 92 | 95 | 15.4 |
| **Minimum for kv with a host** | **92** | **114** | **26** | **148** | **114** | **26** |

kv with a host is Baseline 2026. [Baseline](https://web.dev/baseline) names the year a feature works in every core browser: Chrome, Edge, Firefox, and Safari, on desktop and on mobile. The last minimum in the table, Chrome 148 on Android, shipped on May 5, 2026.

- Safari had OPFS from 15.2, but it could only write a file through `createSyncAccessHandle()`, which exists only in a dedicated WebWorker. kv writes SST files from its SharedWorker, so it needs `createWritable()`, added in Safari 26. On Safari 16 to 25, `openDb` opens without a host.
- Chrome on Android had no SharedWorker until 148. Samsung Internet has none, so it opens without a host.
- Android WebView: MDN lists SharedWorker there from 148, but WebView 154, the version tested, has none, so `openDb` opens without a host in apps and browsers built on it.
- A dedicated WebWorker has no SharedWorker, so it opens without a host. A host that a page of the origin runs flushes the worker's writes too.
- `@opfs-lsm/tanstack-db` also calls `Promise.withResolvers()`, which raises its minimum to Chrome and Edge 119, Firefox and Firefox Android 121.
- `@opfs-lsm/kv/tuple` also calls `String.prototype.isWellFormed()`, which raises its minimum to Chrome and Edge 111, and Firefox and Firefox Android 119.
- `@opfs-lsm/docstore` also calls `String.prototype.isWellFormed()`, itself and through `@opfs-lsm/kv/tuple`, so it has the same minimum. So do `@opfs-lsm/yjs` and `@opfs-lsm/tanstack-query`, which call it on a document name and on a storage key.

## Without a host

Without a host, every write still lands in the IndexedDB WAL, so the data persists and every tab of the origin sees it. Nothing flushes or compacts, which costs:

- Each tab holds the whole database in its memtable.
- The WAL grows with every write, overwrite and delete, and each `openDb` replays all of it.
- A delete frees no space. `dangerousDestroy` and `destroyDb` do, and so does the first open in a browser that runs the host, which flushes the whole WAL.
- No reserve is kept. A write the browser refuses rejects with `StorageFullError` after one more try, and `onStorageFull` is never called.
- A recovery that needs SST files a host wrote, after a power loss beside a host in another context, rejects with `StorageUnavailableError` until a context with a host opens the database.

Node tests on fake-indexeddb cover this path, and it ran in desktop Chrome with `createWritable()` or SharedWorker removed. It has not run in Safari, Samsung Internet or a WebView.

## Versions and tests

Versions are from [MDN browser-compat-data](https://github.com/mdn/browser-compat-data) 8.1.8. The engine is tested in desktop Chrome and on Android. In Chromium 160 on a Pixel 4a, the two-tab proofs and every benchmark workload pass, and no kill in the kill-and-recover loop lost an acked write. The Android run has limits:

- It covers one phone and a Chromium snapshot build, not Chrome stable.
- Android runs the SharedWorker in the process of the tab that created it. When another tab of the app is in front, that process is confined to two small cores, and ingest and compaction run there.
- On a locked phone the whole browser is confined to those cores. There, an `ingest()` call after a `StorageFullError` took more than 20 s in 5 of 7 runs. Unlocked, 6 of 6 answered. No acked write was lost.
- The kill loop cannot observe a crashed tab or kill one renderer on Android, so those two kinds are not covered.

The findings and the scripts that drive a phone over adb are in [the Android device run](research/android-device-run.md). Firefox, Safari and iOS are not tested yet.
