---
"@opfs-lsm/kv": minor
---

Make a single `put`, `delete` or `batch` cheaper: the append transaction now writes only its WAL record. The head is the last key in the WAL, and the host measures a waiting WAL from its records when a tab opens. The stored format is unchanged. A tab still running an older build reads the stored head floor, so it does not see these appends; reloading that older build does not either. The records stay in the WAL.
