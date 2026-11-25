---
"@opfs-lsm/kv": patch
---

`openDb` now rejects with `StorageUnavailableError` where OPFS files have no `createWritable()`, as on Safari 16 to 25. kv cannot write its SST files there.
