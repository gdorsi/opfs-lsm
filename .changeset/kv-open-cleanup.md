---
"@opfs-lsm/kv": patch
---

An `openDb` that fails now closes the IndexedDB connection, the SharedWorker port and the BroadcastChannel it opened, so `destroyDb` can run next.
