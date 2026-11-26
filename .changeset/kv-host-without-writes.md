---
"@opfs-lsm/kv": minor
---

`openDb` now opens in Safari and iOS 16 to 25, which have no `createWritable()`, in Samsung Internet and Android WebView, which have no SharedWorker, and inside a dedicated WebWorker in every browser, where it used to reject. Where the page has no SharedWorker, each handle starts the host in a dedicated Worker. A host writes SST files only in a SharedWorker whose OPFS files have `createWritable()`. Any other host still repairs and empties the database, but nothing flushes or compacts: every write stays in the IndexedDB WAL and in each tab's memory, each open replays the whole WAL, a delete frees no space until `dangerousDestroy`, `destroyDb` or an open whose host writes, and `onStorageFull` is never called. `openDb` still rejects with `StorageUnavailableError` where OPFS or a worker is missing, as in Node.
