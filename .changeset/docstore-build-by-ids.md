---
"@opfs-lsm/docstore": patch
---

An index build names its index by collection id and index id. A collection that is dropped and declared again keeps its name and reuses its index ids under a new collection id. A build that outlived the `drop` could take the new index for its own, add documents of other collections to it and mark it ready. It now stops once its collection is gone.
