---
"@opfs-lsm/docstore": patch
---

`putMany` into a collection with no index reads no row: the transaction reads only the catalog and writes every document. Such a put no longer skips a document whose stored bytes would not change.
