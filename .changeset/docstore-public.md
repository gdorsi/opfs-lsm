---
"@opfs-lsm/docstore": minor
---

docstore is now published. A collection gains `indexes`, the indexes its schema declares; `view`, which reads queries and documents from one kv snapshot and reports the snapshot's `seq`; `modifyMany`, a read-modify-write of several documents in one transaction that loses no update to another tab; and `changes`, every change to the collection's documents from every tab, with a `gap` event when the collection is cleared or dropped. Queries now read through a snapshot, so a query that a newer schema's redefinition overtakes returns the state it started in instead of failing with `"schema"`.
