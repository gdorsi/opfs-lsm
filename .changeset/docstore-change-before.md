---
"@opfs-lsm/docstore": minor
---

Each change of `changes()` has `before(index)`: the entries the document had in that index before the write, as `queryEntries` gives them, or none when it did not exist or was not in the index. It comes from the index entries the write removed and added, which the kv record already holds, and from the document for an index the write left alone, so nothing is read and nothing more is stored. It works across tabs. It takes a sorted or multi index that is not unique and includes no field. `DocChange` and `CollectionChange` take the collection's indexes as a second type parameter.
