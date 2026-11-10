---
"@opfs-lsm/kv": minor
---

Add `openDb({ compactionMemoryBytes })` (default 32 MiB, at least 8 MiB), the memory the SharedWorker may spend on flushing and compacting a database. One figure sets the flush run, the sources a compaction step reads, the L0 stop, the read window and when the wasm instance is replaced to give its memory back. When tabs pass different values, the host uses the smallest. Merges now take turns in a SharedWorker, across databases, where a second one used to fall back to the TypeScript merge. `HostStats.memory` reports the wasm memory, its peak, the merge reserve and the recycles, and `HostStats.l0Stops` moved into it.
