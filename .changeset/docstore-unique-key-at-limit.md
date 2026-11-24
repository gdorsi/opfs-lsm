---
"@opfs-lsm/docstore": patch
---

A unique value whose index key is exactly kv's 8 KiB limit is found by `eq`, `lte` and `gt`, and counted, as any other stored value. Before, those reads threw `ConstraintError` for a value the store had accepted.
