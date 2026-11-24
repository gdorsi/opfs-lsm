---
"@opfs-lsm/tanstack-db": patch
---

A `like` or `ilike` read through a text index finds a letter whose lowercase composes with the mark after it. Before, `like(t, "%J̌%")` missed `"xJ̌y"`.
