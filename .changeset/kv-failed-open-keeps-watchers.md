---
"@opfs-lsm/kv": patch
---

An `openDb` that fails no longer removes another tab from the SharedWorker's count of open handles. Before, with one other tab open, the SharedWorker stopped flushing that tab's database at `maxWalBytes` and stopped its storage-full offers.
