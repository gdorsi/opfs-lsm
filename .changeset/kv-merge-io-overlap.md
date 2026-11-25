---
"@opfs-lsm/kv": patch
---

A compaction step that a flush waits for on a full L0, or soon will, overlaps its file waits with its work: one output write stays in flight, and the level it merges into is read one window ahead. A long bulk write that outruns compaction ends sooner, and its writes wait less. Any other step runs as before.
