---
"@opfs-lsm/kv": patch
---

An `openDb` that fails no longer removes another tab from the SharedWorker's count of open handles. Before, with one other tab open, the SharedWorker stopped flushing that tab's database at `maxWalBytes` and stopped its storage-full offers. The same holds for a handle the browser closes while it opens, which used to leave its `maxWalBytes` with the SharedWorker for good.
