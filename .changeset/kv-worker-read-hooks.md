---
"@opfs-lsm/kv": patch
---

kv's SharedWorker bundle no longer includes the block decoding hooks and the JavaScript LZ4 decoder, which only the tab uses. The worker chunk is 372 bytes brotli smaller.
