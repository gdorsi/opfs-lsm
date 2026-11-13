---
"@opfs-lsm/kv": minor
---

Rows that `deleteRange` removed now leave the disk. Compaction drops them from the SST files it rewrites, and once the levels are in shape it rewrites every file that still holds such rows, so the range delete leaves the manifest and its space comes back.
