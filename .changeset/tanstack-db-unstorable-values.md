---
"@opfs-lsm/tanstack-db": patch
---

An on-demand query no longer fails when its `where` compares against an empty id or a string longer than 256 UTF-16 units. The filter checks such a value instead of an index range.
