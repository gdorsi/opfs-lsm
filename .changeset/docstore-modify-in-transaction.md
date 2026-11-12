---
"@opfs-lsm/docstore": patch
---

`modify` and `modifyMany` on a collection without a unique index read each document once, inside the kv transaction that writes it, and run `fn` there. Before, they read every document before the transaction and kv read it again inside. A new document's index entries are written without diffing them against an empty list.
