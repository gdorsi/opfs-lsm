---
"@opfs-lsm/yjs": patch
---

A doc whose only content is a pending update (one that arrived before the update it builds on) is stored when the persistence attaches. Before, that update was lost on reload.
