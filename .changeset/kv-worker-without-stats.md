---
"@opfs-lsm/kv": patch
---

The SharedWorker an app loads no longer counts IO, flushes, compactions or wasm memory, and the tab no longer counts its WAL appends. Only `@opfs-lsm/kv/testing` keeps those counters for `readStats`: a database it opens in a browser uses a second SharedWorker entry with a meter. An app downloads about 0.5 kB less brotli after `openDb` and 0.1 kB less gzip at import.
