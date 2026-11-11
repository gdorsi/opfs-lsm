---
"@opfs-lsm/kv": patch
---

`@opfs-lsm/kv` is smaller: 40.2 kB brotli after the first `openDb`, down from 47.3 kB, and 15.4 kB at import, down from 20.7 kB. `openDb` no longer bundles the in-process host and the memory filesystem that only `@opfs-lsm/kv/testing` uses, the main chunk and the SharedWorker chunk no longer carry each other's WAL and engine code, and the wasm engine drops a decoder that no production path called.
