---
"@opfs-lsm/kv": patch
---

`openDb` rejects with `StorageUnavailableError` where the platform has OPFS but no Web Locks. It used to open, and fail with a `TypeError` on the first file read.
