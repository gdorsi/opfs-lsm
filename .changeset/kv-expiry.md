---
"@opfs-lsm/kv": minor
---

Rows can expire. `db.put(key, value, { expiresAt })` and `tx.put(key, value, { expiresAt })` take an absolute time in epoch milliseconds, from which the row and every older version of its key read as absent in `get`, `range`, `rangeJoin`, `update`, `view` and `valueContains` scans. One operation reads at one time, and a `view` keeps the time it opened at. Flushes and compactions turn expired rows into tombstones and drop them at the bottom level. `changes()` put ops carry `expiresAt`.

SST files move to version 2 and manifests to version 5, which records the time the files were judged at. This build refuses a database whose newest manifest is version 4 or older with `CorruptDatabaseError`, and an older build refuses the new files the same way; `destroyDb(name)` empties either.
