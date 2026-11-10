---
"@opfs-lsm/kv": minor
---

Add `openDb({ compactionMemoryBytes })` (default 32 MiB, at least 8 MiB), the memory the SharedWorker may spend on flushing and compacting a database. One figure sets the flush run, the sources a compaction step reads, the L0 stop, the read window and when the wasm instance is replaced to give its memory back. When tabs pass different values, the host uses the smallest until the last of them closes the database. Each database has its own SharedWorker, so the budget is per database. Where one host serves several databases, as in Node, their merges now take turns, and a second one no longer falls back to the TypeScript merge. `HostStats.memory` reports the wasm memory, its peak, the merge reserve and the recycles, and `HostStats.l0Stops` moved into it.
