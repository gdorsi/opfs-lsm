---
"@opfs-lsm/kv": minor
---

Trim the `Db` surface. Breaking:

- `rangeFollow(range, follow)` is now `rangeJoin(range, keyOf)`, and each hit is `{ entry, joined }` where it was `{ entry, value }`.
- `db.ingest()` is gone. Tests and benchmarks call `ingest(db)` from `@opfs-lsm/kv/testing`. The host still flushes by itself, so an app does not need it. No `Db` method rejects with `StorageFullError` any more.
- `changes()` no longer emits an `ingest` event. A flush does not change what reads return.
- In `view`, `snap.walHead` is now `snap.seq`, the same seq write acks and `append` events carry. `snap.generation` is gone.
- `openDb({ memoryBudget })` is now `openDb({ cacheBytes })`.
