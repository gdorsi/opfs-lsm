---
"@opfs-lsm/kv": patch
---

Shrink the open trace of the `@opfs-lsm/kv/testing` entry. `OpenSpan` loses `bytes`. The `host-scan`, `worker-ctor` and `wasm-error` spans are gone, and the `sst` span appears only when a sync loads a generation. `EngineHost.watch` and `createPortIngestClient` no longer take an `onScan` callback, and the `WatchScan` type is gone. The app API is unchanged.
