---
"@opfs-lsm/kv": patch
---

Range scans and seeks over flushed data no longer copy every entry they step over. A scan copied each key and value as it read it out of an SST block, then copied the entries it returned a second time. It now reads entries in place in the block and copies only the ones it returns. In the `kv/fillseq` benchmark, 100 seeks went from 749 ms to 517 ms, 10 seeks from 102 ms to 79 ms, and a full ordered scan from 90 ms to 72 ms (median of 6 runs each).
