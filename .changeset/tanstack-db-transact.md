---
"@opfs-lsm/tanstack-db": minor
---

`utils.transact(keys, merge)` reads rows and writes the result in one kv `update`, so no other write lands between the read and the write. `merge` returns a row to put, `null` to delete or `undefined` to leave each key, and the promise resolves once the collection shows the write (an eager collection always does, an on-demand one for the keys a loaded plan covers; other keys persist but stay out of memory).
