---
"@opfs-lsm/kv": minor
---

Bound the memory of a flush and of the memtable. `openDb({ memtableBytes })` (default 16 MiB) caps the rows a tab holds that are not yet flushed: at 7/8 of it the tab asks for a flush, and at the limit a write waits for that flush. The SharedWorker now flushes a WAL backlog in L0 runs of at most 1.75 MiB, and at 48 L0 runs a flush waits for compaction (`HostStats.l0Stops` counts the waits).
