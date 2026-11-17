---
"@opfs-lsm/kv": patch
---

Opening a database after a flush, and every `update` from a tab that is caught up, no longer reads past the rows the flush deleted. In Chrome, an IndexedDB range read past the last WAL record steps over every row deleted since IndexedDB last compacted, and kv found the WAL head with such a read: twice per open and once per `update`. kv now reads the one key after the seq the head has reached, and looks for the last key only when that key is there. In the `yjs/trace` benchmark, a fresh tab's open after a settle went from 10.1 ms to 4.7 ms, and in `kv/ycsb-a` a read-modify-write went from 1.11 ms to 0.17 ms on average (median of 5 runs each).
