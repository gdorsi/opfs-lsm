---
"@opfs-lsm/kv": patch
---

Stop storing the WAL head. `meta` in `opfs-lsm-wal/<name>` no longer has a `head` key: the head is the last key in `wal`, or `ingestedThrough` when no record is past it. Recovery and destroy, the only writers that move the head past the records, already set `ingestedThrough` to the new head and move the key generator with it. A tab still running an earlier version reads the old key as the head. After this version recovers or destroys the database, an `update` from that tab can take a seq this version counts as already flushed, and that write is lost. Reload such tabs after an upgrade.
