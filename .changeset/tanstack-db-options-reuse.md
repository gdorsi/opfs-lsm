---
"@opfs-lsm/tanstack-db": patch
---

Two collections created from one `docstoreCollectionOptions` object now each store their writes. The options followed only the collection that started last, and an insert on the other one resolved without a write.
