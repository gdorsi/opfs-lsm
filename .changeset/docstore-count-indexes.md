---
"@opfs-lsm/docstore": minor
---

`count(name, by)` declares a count index: how many documents hold each value tuple of the fields at `by`, kept in the same kv transaction as the documents. `issues.count({ index: "perStatus", eq: [projectId, ["todo", "started"]] })` then reads one or two small rows per value instead of walking one entry per document. A `[]` first field counts a document once per distinct element. A write that moves a document to another value reads and writes two numbers, and a write that moves none does neither.

`count` on a count index takes `eq`, one bound and `limit`. A slot of `eq` can list values, whose numbers are added, except the slot of an array field, where two values can share a document. `query`, `queryIds`, `queryEntries`, `after`, `offset`, `reverse` and `match` are a type error there and a `DocStoreError` `"query"`. A count index takes no `include`, and `collection.indexes` leaves it out. `count` is now typed `CountQuery`, which is `Query` and the count indexes.

A count index added to stored documents is built from one snapshot while other tabs keep writing. A database whose schema has one stores catalog format 4, which a version from before count indexes refuses to open with `DocStoreError` `"schema"`. Without one the catalog stays format 2.

An index build now names its index by collection id and index id. A build that outlived a `drop` of its collection could otherwise mark ready the index that took the same name and id in the collection declared again.
