---
"@opfs-lsm/docstore": minor
---

A query takes `offset`, and `count` no longer walks the entries it counts. A window deep into a list reads the entries around it and not the ones before it, and a count reads none, because every write now tells kv what it did to each row and index entry. `count` still walks when the query has `match`, in a collection with no index, and in an index that a newer schema built over stored rows, until kv has compacted those entries.
