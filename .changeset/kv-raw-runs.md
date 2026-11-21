---
"@opfs-lsm/kv": minor
---

Every run is stored raw, at every level. Runs from L2 down held LZ4 blocks, and each read of one unpacked a whole 4 KiB block, so reads slowed down once a database passed about 40 MB and its data reached L2. At 1,000,000 entries a random `get` ran at 219k ops/s on LZ4 runs and at 352k on the same data raw, and `getMany` and `count` were 1.85 and 1.88 times slower. Raw runs give up the 26% of disk space that LZ4 saved at that size. The wasm engine is 3.2 kB smaller gzip, and `openDb` loads about 3 kB less brotli in all.

The SST format is now version 2, with a 40-byte footer and no codec field. A database written by an earlier version still opens, then the first read or compaction that reaches one of its runs throws `CorruptDatabaseError`. Call `destroyDb` and open it again.
