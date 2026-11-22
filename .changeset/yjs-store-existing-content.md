---
"@opfs-lsm/yjs": patch
---

`KvPersistence` stores the content a doc already holds when the persistence is constructed, as one entry, the way y-indexeddb does. That content fired no update event, so it was never stored and a reload lost it.
