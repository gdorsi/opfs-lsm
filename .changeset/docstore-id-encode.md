---
"@opfs-lsm/docstore": patch
---

A document id and a text index value encode into one reused buffer and are copied out, which skips the allocation `TextEncoder.encode` makes on every call. The stored bytes are the same.
