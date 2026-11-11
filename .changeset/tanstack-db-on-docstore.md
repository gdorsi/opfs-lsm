---
"@opfs-lsm/tanstack-db": minor
---

`docstoreCollectionOptions({ collection, syncMode })` replaces `kvCollectionOptions`. A collection lives in an `@opfs-lsm/docstore` collection and is keyed by its documents' `id`. An on-demand collection reads each live query's rows through the docstore collection's indexes, with no `plan` to write: a `where` on `id` reads those documents, `eq` and `inArray` on an index's leading fields read one range per value, and an ordered, limited query reads only the first rows of each range. `utils.transact(ids, merge)` is docstore's `modifyMany`. `kvCollectionOptions`, with `getKey`, `codec`, `onDemand` and number keys, is removed.
