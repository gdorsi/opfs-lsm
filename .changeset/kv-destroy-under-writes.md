---
"@opfs-lsm/kv": patch
---

`dangerousDestroy` no longer rejects with `CorruptDatabaseError` while another handle keeps writing. Each write that landed between its read of the log and its commit made the commit stale, and a steady writer used up every try. The commit now reads the head itself.
