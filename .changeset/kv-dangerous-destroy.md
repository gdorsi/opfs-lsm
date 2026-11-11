---
"@opfs-lsm/kv": minor
---

Add `db.dangerousDestroy()`. One IndexedDB transaction empties the database, then the host removes its OPFS files, one recursive remove per directory, so the cost does not grow with the data. It closes the handle, and every other tab's handle on the database, whether or not it succeeds. A crash at any point leaves either the old database or an empty one. `openDb` with the same name afterwards opens an empty database.

`AsyncFs` gains `removeTree(path)`, so a custom `fs` passed to `openHarnessDb` must implement it.
