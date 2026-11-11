---
"@opfs-lsm/kv": minor
---

`openDb` never falls back to memory. Breaking: where SharedWorker or OPFS is missing, as in Node or a dedicated WebWorker, `openDb` rejects with `StorageUnavailableError`. Before, a context with no `document` got an in-memory database with no error, while its WAL still went to IndexedDB. Tests ask for memory with `openHarnessDb({ forceMemory: true })` from `@opfs-lsm/kv/testing`. The `allowEphemeral` harness option is gone.
