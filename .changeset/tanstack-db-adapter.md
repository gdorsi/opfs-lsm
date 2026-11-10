---
"@opfs-lsm/tanstack-db": minor
---

New package. `kvCollectionOptions({ db, name, getKey })` keeps a TanStack DB collection in an `@opfs-lsm/kv` db. It persists every insert, update and delete as one kv batch per transaction, loads the collection's rows on start, and applies other tabs' writes from kv's change feed as they arrive. `utils.acceptMutations` persists a manual transaction.
