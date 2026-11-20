---
"@opfs-lsm/kv": patch
---

A flush sorts its WAL chunk and keeps each key's last write inside the wasm engine. The worker no longer builds a map and sorts in JavaScript first. Folding and encoding a default chunk of distinct keys takes about half the time, and the engine's peak memory during a flush is about 20% lower. A chunk that rewrites the same keys many times folds slower than before.
