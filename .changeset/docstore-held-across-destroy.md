---
"@opfs-lsm/docstore": patch
---

A store stays usable after `dangerousDestroy`. Until any store wrote a catalog again, its reads and writes threw `CorruptDatabaseError: the docstore catalog is gone`, whether the destroy came from its own kv handle or from another tab. It now reads the emptied database as empty, and its next write stores the catalog that a fresh open would write. A `clear` whose sweep had not run when the destroy landed no longer deletes the documents written after the destroy.
