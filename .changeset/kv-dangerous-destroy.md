---
"@opfs-lsm/kv": minor
---

Add `db.dangerousDestroy()` and `destroyDb(name)`, which delete every record of a database. Writes acked before the destroy are gone, and writes after it land in the empty database. Every handle stays open and reads empty once it catches up, with a `gap` change event. `destroyDb` does not open the database, so it also empties one that `openDb` refuses as corrupt. One IndexedDB transaction, on disk before any file is removed, empties the database: once it resolves, the deleted records never come back, even after a power loss, and a crash before that leaves the database as if the destroy had not run. The host then removes every file no tab is reading, and the rest once their tabs move on.
