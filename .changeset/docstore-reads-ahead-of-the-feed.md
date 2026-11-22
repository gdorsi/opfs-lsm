---
"@opfs-lsm/docstore": patch
---

`get` and `getMany` read the documents of the state they read from, as queries do. A write on a handle can make another tab's records readable a moment before kv announces them. In that moment a query already showed a collection after the other tab's `clear`, and a `get` right after it still read the cleared documents, or nothing. Every read now takes one kv snapshot and the catalog of that snapshot. The store follows the catalog from kv's change feed by seq, so a read on a handle that is caught up reads no catalog, and a query saves the catalog read it used to make.
