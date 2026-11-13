---
"@opfs-lsm/fate": minor
---

New package. `kvStorage(db)` is persistence storage for the fate data client (`@nkzw/fate`) on an `@opfs-lsm/kv` db. It takes the place of the storage in `@nkzw/fate-indexeddb`. One fate entry is one kv entry, a `writeBatch` is one atomic kv batch, and each `exclusive` section holds a Web Lock and first catches the handle up with other tabs' writes.
