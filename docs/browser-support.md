# Browser support

`@opfs-lsm/kv` needs SharedWorker, OPFS with `createWritable()`, IndexedDB and WebAssembly in the page. Where SharedWorker or `createWritable()` is missing, SharedWorker or OPFS fails to start, or the wasm engine or the IndexedDB store fails to load, `openDb` rejects with `StorageUnavailableError`. It never falls back to memory.

Three APIs set the minimum version in every browser. Everything else kv uses shipped earlier, including Web Locks, BroadcastChannel and the WebAssembly features in the engine.

| API | Chrome, Edge | Firefox | Safari | Chrome Android | Firefox Android | Safari iOS |
| --- | --- | --- | --- | --- | --- | --- |
| `SharedWorker` with `type: "module"` | 80 | 114 | 16 | 148 | 114 | 16 |
| OPFS `FileSystemFileHandle.createWritable()` | 86 | 111 | 26 | 109 | 111 | 26 |
| `crypto.randomUUID()` | 92 | 95 | 15.4 | 92 | 95 | 15.4 |
| **Minimum for kv** | **92** | **114** | **26** | **148** | **114** | **26** |

kv is Baseline 2026. [Baseline](https://web.dev/baseline) names the year a feature works in every core browser: Chrome, Edge, Firefox, and Safari, on desktop and on mobile. The last minimum in the table, Chrome 148 on Android, shipped on May 5, 2026.

- Safari had OPFS from 15.2, but it could only write a file through `createSyncAccessHandle()`, which exists only in a dedicated WebWorker. kv writes SST files from its SharedWorker, so it needs `createWritable()`, added in Safari 26. On Safari 16 to 25, `openDb` rejects with `StorageUnavailableError`.
- Chrome on Android had no SharedWorker until 148. Samsung Internet has none, so kv does not run there.
- Android WebView is not supported. MDN lists SharedWorker there from 148, but WebView 154, the version tested, has none, so `openDb` rejects with `StorageUnavailableError` in apps and browsers built on it.
- `@opfs-lsm/tanstack-db` also calls `Promise.withResolvers()`, which raises its minimum to Chrome and Edge 119, Firefox and Firefox Android 121.
- `@opfs-lsm/kv/tuple` also calls `String.prototype.isWellFormed()`, which raises its minimum to Chrome and Edge 111, and Firefox and Firefox Android 119.
- `@opfs-lsm/docstore` also calls `String.prototype.isWellFormed()`, itself and through `@opfs-lsm/kv/tuple`, so it has the same minimum. So do `@opfs-lsm/yjs` and `@opfs-lsm/tanstack-query`, which call it on a document name and on a storage key.

Versions are from [MDN browser-compat-data](https://github.com/mdn/browser-compat-data) 8.1.8. The engine is tested in desktop Chrome and on Android. In Chromium 160 on a Pixel 4a, the two-tab proofs and every benchmark workload pass, and no kill in the kill-and-recover loop lost an acked write. The Android run has limits:

- It covers one phone and a Chromium snapshot build, not Chrome stable.
- Android runs the SharedWorker in the process of the tab that created it. When another tab of the app is in front, that process is confined to two small cores, and ingest and compaction run there.
- On a locked phone the whole browser is confined to those cores. There, an `ingest()` call after a `StorageFullError` took more than 20 s in 5 of 7 runs. Unlocked, 6 of 6 answered. No acked write was lost.
- The kill loop cannot observe a crashed tab or kill one renderer on Android, so those two kinds are not covered.

The findings and the scripts that drive a phone over adb are in [the Android device run](research/android-device-run.md). Firefox, Safari and iOS are not tested yet.
