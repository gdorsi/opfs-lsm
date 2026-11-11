---
"@opfs-lsm/kv": minor
---

Add `db.dangerousDestroy()`. It deletes the database's IndexedDB WAL and its OPFS files, closes the handle, and closes every other tab's handle on the database. Its cost does not grow with the data. `openDb` with the same name afterwards opens an empty database.

`AsyncFs` gains `removeAll()`, so a custom `fs` passed to `openHarnessDb` must implement it.
