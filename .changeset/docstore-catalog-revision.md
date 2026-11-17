---
"@opfs-lsm/docstore": minor
---

Queries no longer compare the whole stored catalog. Every `query`, `queryIds` and `count` checks that the collection's schema has not changed since the handle bound it, and that check compared the stored catalog JSON byte for byte. The stored catalog now starts with an 8-byte random revision, written fresh on every catalog change, and the check compares only that revision. Opening a store whose stored schema already matches the declared one now reads the catalog and writes nothing. In the `tracker/goals` benchmark, `assigneeLoad` went from 3.18 ms to 2.28 ms (median of 8 runs each).

This changes the stored format. A database written by an earlier version fails to open with `CorruptDatabaseError`. `destroyDb(name)` from `@opfs-lsm/kv` empties it.
