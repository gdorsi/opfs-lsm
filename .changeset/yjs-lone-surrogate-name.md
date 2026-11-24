---
"@opfs-lsm/yjs": patch
---

`KvPersistence` throws for a document name with a lone surrogate. UTF-8 turned the surrogate into U+FFFD, so such a name read and wrote the updates of another document.
