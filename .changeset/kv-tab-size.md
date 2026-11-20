---
"@opfs-lsm/kv": patch
---

The JavaScript a page downloads to import kv is 19.9 kB gzip, down from 20.4 kB. The tab no longer ships its own LZ4 decoder: the wasm engine, which an open already waits for, decodes every block. After a wasm trap the read runs once more on a fresh instance instead of falling back to JavaScript, and a block that fails there too throws `CorruptDatabaseError`. The names of the engine's statuses are in the SharedWorker bundle alone, so an error from a tab's block read gives the status number without its name.
