---
"@opfs-lsm/tanstack-query": patch
---

A query whose storage key is over 8 KiB is not found in storage, so `persisterFn` calls `queryFn`. Before, kv rejected the read with `ConstraintError` and the query failed without calling `queryFn`.
