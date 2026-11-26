# Browser support

`@opfs-lsm/kv` needs a worker, OPFS, IndexedDB and WebAssembly in the page. Its host runs in a SharedWorker, or in a dedicated Worker where the page has no SharedWorker. The host flushes and compacts only in a SharedWorker that can write OPFS files: through `createWritable()`, or [without it](#without-createwritable) where a sync access handle works there. Elsewhere `openDb` still opens, and the host [writes no file](#where-the-host-cannot-write). Where OPFS or a worker of either kind is missing, the browser refuses to start the worker, or the wasm engine or the IndexedDB store fails to load, `openDb` rejects with `StorageUnavailableError`. It never falls back to memory.

Three APIs set the minimum version at which the host writes through `createWritable()` in every browser. Everything else kv uses shipped earlier, including Web Locks, BroadcastChannel and the WebAssembly features in the engine.

| API | Chrome, Edge | Firefox | Safari | Chrome Android | Firefox Android | Safari iOS |
| --- | --- | --- | --- | --- | --- | --- |
| `SharedWorker` with `type: "module"` | 80 | 114 | 16 | 148 | 114 | 16 |
| OPFS `FileSystemFileHandle.createWritable()` | 86 | 111 | 26 | 109 | 111 | 26 |
| `crypto.randomUUID()` | 92 | 95 | 15.4 | 92 | 95 | 15.4 |
| **Minimum for kv with a host that writes this way** | **92** | **114** | **26** | **148** | **114** | **26** |

kv with a host that writes this way is Baseline 2026. [Baseline](https://web.dev/baseline) names the year a feature works in every core browser: Chrome, Edge, Firefox, and Safari, on desktop and on mobile. The last minimum in the table, Chrome 148 on Android, shipped on May 5, 2026.

- Safari had OPFS from 15.2, but until `createWritable()` came in Safari 26 it could only write a file through `createSyncAccessHandle()`. On Safari and iOS 16 to 25 the host runs in the SharedWorker and writes its files [that way](#without-createwritable) if it can, and no file if it cannot.
- Chrome on Android had no SharedWorker until 148. Samsung Internet has none, so there the host runs in a dedicated Worker and writes no file.
- Android WebView: MDN lists SharedWorker there from 148, but WebView 154, the version tested, has none, so the host runs in a dedicated Worker in apps and browsers built on it.
- Code inside a dedicated WebWorker has no SharedWorker in any browser, so an `openDb` called there starts its host in another dedicated Worker, which writes no file. A page of the origin that opens the same database runs a host that flushes the worker's writes too. While no such page is open, nothing flushes.
- `@opfs-lsm/tanstack-db` also calls `Promise.withResolvers()`, which raises its minimum to Chrome and Edge 119, Firefox and Firefox Android 121.
- `@opfs-lsm/kv/tuple` also calls `String.prototype.isWellFormed()`, which raises its minimum to Chrome and Edge 111, and Firefox and Firefox Android 119.
- `@opfs-lsm/docstore` also calls `String.prototype.isWellFormed()`, itself and through `@opfs-lsm/kv/tuple`, so it has the same minimum. So do `@opfs-lsm/yjs` and `@opfs-lsm/tanstack-query`, which call it on a document name and on a storage key.

## Without createWritable

The OPFS spec gives `createSyncAccessHandle()` to dedicated Workers only. Safari 18.6 on macOS also gives it to a SharedWorker. So a SharedWorker host in a browser with no `createWritable()` finds out when it starts: it writes one byte to a scratch file in `opfs-lsm/` through a sync access handle, renames the file, reads the byte back, and removes the file.

- If every step works, the host flushes and compacts as in any other browser. It writes each file as `<name>.crswap`, flushes it, and renames it into place.
- If a step fails, the host [writes no file](#where-the-host-cannot-write).

Requests that arrive while the host finds out wait for the answer. A browser with `createWritable()` writes no scratch file.

This path has run in two places ([Versions and tests](#versions-and-tests)). Safari 16 and 17 and every version of iOS are untested, so there the scratch file decides, and no minimum version is claimed.

## Where the host cannot write

A host writes no file in a dedicated Worker, and in a SharedWorker with neither `createWritable()` nor a sync access handle that works. Each handle with no SharedWorker starts a dedicated Worker of its own. Several hosts that write keep one database consistent, but they do not share one reserve ([Reserve](reserve.md#several-hosts)), so these hosts write none.

A host that writes no file still serves every tab. Each write lands in the IndexedDB WAL, so the data persists and every tab of the origin sees it, and `dangerousDestroy` and recovery work as with a writing host. Nothing flushes or compacts, which costs:

- Each tab holds the whole database in its memtable.
- The WAL grows with every write, overwrite and delete, and each `openDb` replays all of it.
- A delete frees no space. `dangerousDestroy` and `destroyDb` do, with the run files a writing host left, and so does the first open in a browser whose host writes, which flushes the whole WAL.
- It keeps no reserve, and releases none that a writing host in another context keeps. A write the browser refuses rejects with `StorageFullError` after one more try, and `onStorageFull` is never called.
- In a dedicated Worker, each open handle starts its own host.

Node tests on fake-indexeddb cover this path. It also ran in desktop Chrome with SharedWorker removed, and inside a dedicated WebWorker in Chrome and in Safari 18.6 on macOS. It has not run in iOS Safari, Samsung Internet or a WebView.

## Versions and tests

Versions are from [MDN browser-compat-data](https://github.com/mdn/browser-compat-data) 8.1.8. The engine is tested in desktop Chrome and on Android. In Chromium 160 on a Pixel 4a, the two-tab proofs and every benchmark workload pass, and no kill in the kill-and-recover loop lost an acked write. The Android run has limits:

- It covers one phone and a Chromium snapshot build, not Chrome stable.
- Android runs the SharedWorker in the process of the tab that created it. When another tab of the app is in front, that process is confined to two small cores, and ingest and compaction run there.
- On a locked phone the whole browser is confined to those cores. There, an `ingest()` call after a `StorageFullError` took more than 20 s in 5 of 7 runs. Unlocked, 6 of 6 answered. No acked write was lost.
- The kill loop cannot observe a crashed tab or kill one renderer on Android, so those two kinds are not covered.

The findings and the scripts that drive a phone over adb are in [the Android device run](research/android-device-run.md).

The host that writes without `createWritable()` ran in two places:

- **Desktop Chrome 158**, with `createWritable()` hidden in the testing worker. Chrome gives a sync access handle to a dedicated Worker only, so each tab ran its host in one. The two-tab proof passed, and no kill in the kill-and-recover loop lost an acked write ([Verification](verification.md#kill-real-chrome)).
- **Safari 18.6 on macOS**, from the SharedWorker. The scratch file passed and left nothing behind. In a two-tab run the host flushed, compacted and wrote its reserve, and rows read back from run files after a reload.

Firefox and iOS are not tested yet.
