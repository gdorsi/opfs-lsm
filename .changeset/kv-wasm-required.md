---
"@opfs-lsm/kv": minor
---

Require the wasm engine. `openDb` now waits for the module and rejects with `StorageUnavailableError` when it does not load. Before, the SharedWorker fell back to a TypeScript encoder and merge that wrote raw blocks only.
