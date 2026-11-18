---
"@opfs-lsm/docstore": patch
---

A collection's `closed` change event carries kv's `reason`: `"close"` when the kv handle was closed, `"destroyed"` when `destroyDb` removed its database.
