---
"@opfs-lsm/kv": minor
"@opfs-lsm/docstore": patch
---

Add `tx.deleteRange(bounds, { through? })` to `batch`, which removes every row in `[start, endExclusive)` in one op, however many rows that is. It removes the rows written before its batch, or with `through` only those last written at or below that seq, and never its own batch's puts. Every read skips the removed rows, in every tab, and a `view` opened before it keeps reading them. `changes()` reports it as a `deleteRange` op with its `through` resolved. `KeyBounds` and `DeleteRangeOptions` are exported.

Manifests move to version 4, which records the range deletes. This build refuses a database whose newest manifest is version 3 or older with `CorruptDatabaseError`, and an older build refuses a version 4 manifest the same way; `destroyDb(name)` empties either.

A docstore change feed sends a `gap` when a kv range delete reaches a collection's rows.
