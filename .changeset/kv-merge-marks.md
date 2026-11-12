---
"@opfs-lsm/kv": minor
---

Rows that `deleteRange` removed now leave the disk. Compaction drops them from the SST files it rewrites, and the host rewrites every file that still holds such rows, even in a level under its size budget. The range delete then leaves the manifest. A `valueContains` scan skips the removed rows inside the wasm block filter.
