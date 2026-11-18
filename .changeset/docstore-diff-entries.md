---
"@opfs-lsm/docstore": patch
---

A write that replaces a document compares its old and new index entries byte by byte when each side has 16 entries or fewer. It built a string per index key and a `Map` for every document.
