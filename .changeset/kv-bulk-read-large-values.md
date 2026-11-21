---
"@opfs-lsm/kv": patch
---

`getMany` reads many large values faster. A retry after a page load looks up only the keys that missed, the block index search skips the bytes a key is known to share with its bounds, and pages that fill a file read share its buffer instead of each taking a copy.
