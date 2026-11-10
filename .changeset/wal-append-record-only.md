---
"@opfs-lsm/kv": minor
---

Make a single `put`, `delete` or `batch` cheaper: the append transaction now writes only its WAL record. The head is the last key in the WAL, and the host measures a waiting WAL from its records when a tab opens. The stored format is unchanged, but a tab still running an older build does not see writes from a newer one until it reloads.
