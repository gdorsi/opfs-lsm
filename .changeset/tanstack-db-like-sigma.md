---
"@opfs-lsm/tanstack-db": patch
---

A case-sensitive `like` read through a text index finds text whose Σ lowercases to σ. Before, `like(t, "%ΑΣ%")` missed `"ΑΣΑ"`.
