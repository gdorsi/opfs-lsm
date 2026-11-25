---
"@opfs-lsm/tanstack-db": minor
---

`docstoreCollectionOptions` takes `collection: undefined`, for a browser where kv cannot store, and then requires an `id`. The rows live in the page's memory, shared by every collection created from those options, and inserts, updates, deletes, `utils.transact` and `utils.acceptMutations` work as with a store.
