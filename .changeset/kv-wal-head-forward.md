---
"@opfs-lsm/kv": patch
---

Opening a database, and every WAL tail read, no longer slows down right after a flush. The WAL head was found with a reverse IndexedDB cursor, and in Chrome a reverse cursor steps over every row deleted since IndexedDB last compacted: right after a flush deleted 24,700 folded records, finding the head took about 35 ms per lookup, and an open does two. kv now looks forward from `ingestedThrough` first and walks back only when a record is past it. In the `yjs/trace` benchmark, a fresh tab's open after a settle went from 64–68 ms to 16–18 ms.
