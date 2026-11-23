---
"@opfs-lsm/yjs": patch
---

`whenSynced` rejects with `ConstraintError` for a document name too long for its update keys. Before, a name of 8182 to 8189 bytes loaded, then every flush rejected.
