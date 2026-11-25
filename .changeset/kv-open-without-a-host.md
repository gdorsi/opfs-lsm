---
"@opfs-lsm/kv": minor
---

`openDb` now opens where no SharedWorker host can run: Safari and iOS 16 to 25, which have no `createWritable()`, and Samsung Internet, Android WebView and dedicated WebWorkers, which have no SharedWorker. Writes land in the IndexedDB WAL and reads see every tab's writes, as with a host, but nothing flushes or compacts. Each tab holds the whole database in memory, the WAL grows with every write and is replayed at each open, a delete frees no space until `dangerousDestroy`, `destroyDb` or a later open with a host, and `onStorageFull` is never called. `openDb` still rejects with `StorageUnavailableError` where IndexedDB or OPFS is missing, as in Node.

The SharedWorker host now runs only where OPFS files have `createWritable()`, which it writes SST files with.
