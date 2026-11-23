---
"@opfs-lsm/tanstack-query": minor
---

New package. `createQueryPersister(db)` returns TanStack Query's per-query persister with kv as its storage, one kv entry per query. The whole-client persister is not supported, because kv rejects a value over 8 MiB and `createAsyncStoragePersister` drops that error.
