---
"@opfs-lsm/tanstack-query": minor
---

New package. `kvStorage(db)` stores the TanStack Query cache in kv. Pass it as the `storage` of `createAsyncStoragePersister` to persist the whole client, or of `experimental_createQueryPersister` to persist each query in its own entry.
