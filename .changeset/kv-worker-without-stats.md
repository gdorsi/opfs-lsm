---
"@opfs-lsm/kv": patch
---

The SharedWorker an app loads no longer counts IO, flushes, compactions or wasm memory, and the tab no longer counts its WAL appends. Only `@opfs-lsm/kv/testing` keeps those counters for `readStats`: a database it opens in a browser uses a second SharedWorker entry with a meter. `readStats` now rejects with `StorageUnavailableError` for a database opened with plain `openDb`: open it with `openDbWith` or `openHarnessDb` of `@opfs-lsm/kv/testing`. An app downloads about 0.5 kB less brotli after `openDb` and 0.1 kB less gzip at import.
