---
"@opfs-lsm/docstore": patch
---

Every write of rows runs one plan inside kv's `update`. `modify` and `modifyMany` on a collection with a unique index read each row once, in the transaction that writes it, as they already did without one. They read a unique key only for a value that `fn`'s document did not hold before, with `tx.read`. While a unique index builds, a write to a document whose old value another document holds no longer throws `"unique"` unless it takes that value anew.
