---
"@opfs-lsm/kv": minor
---

The manifest format is now version 5, without the unused `tombstoneSeq`. A database written by an earlier version refuses to open with `CorruptDatabaseError`; call `destroyDb` and open it again.
