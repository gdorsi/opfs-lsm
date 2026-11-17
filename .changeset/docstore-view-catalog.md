---
"@opfs-lsm/docstore": patch
---

A `query`, `queryIds`, `count` or `view` that started before a `clear` no longer makes later `get` and `getMany` calls return the documents the clear removed.
