---
"@opfs-lsm/kv": minor
---

Add `db.dangerousDestroy()`. One IndexedDB transaction empties the database, then the host removes its OPFS files, one recursive remove per directory, so the cost does not grow with the data. It closes the handle, and every other tab's handle on the database, whether or not it succeeds. After a process crash the database is either the old one or empty. A power loss can also leave an older state of it. `openDb` with the same name afterwards opens an empty database.

`AsyncFs` gains `removeTree(path)`, so a custom `fs` passed to `openHarnessDb` must implement it.
