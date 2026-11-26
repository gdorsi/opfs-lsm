---
"@opfs-lsm/kv": minor
---

A run's block index is stored once, in the manifest. Each run file also held a copy of it that only compaction read. A run file is now its data blocks, its Bloom filter and a 24-byte footer, and a compaction step takes the block layout of its inputs from the manifest. A run of 2,000 entries with 27-byte keys and 100-byte values is 0.18% smaller, the read that loads a run's Bloom filter no longer carries the index, and `openDb` loads 0.7 kB less in all before compression, 0.1 kB less with brotli.

The SST format is now version 3. A database written by an earlier version still opens and reads, without its Bloom filters, and its first compaction throws `CorruptDatabaseError`. Call `destroyDb` and open it again.
