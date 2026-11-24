---
"@opfs-lsm/kv": minor
---

The body of `update` reads more keys with `tx.read(keys)`, for a key it learns of only from the values it was given: `db.update([a], ([ptr], tx) => tx.put(ptr, next(tx.read([ptr])[0])))`. The values are read as `update` read its own keys, before the body's writes, so no other write lands between them and the commit. When their bytes are not loaded, kv drops that run of the body, loads them and runs the body again. The body's `tx` is now typed `UpdateTx`, which extends `BatchTx`.
