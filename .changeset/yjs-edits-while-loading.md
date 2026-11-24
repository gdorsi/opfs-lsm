---
"@opfs-lsm/yjs": patch
---

Updates made while a doc loads count toward `trimSize`, so a doc they bring to the threshold merges once quiet. Before, the load dropped them from the count and the doc could stay unmerged. `destroy()` also stores an update that went pending while the persistence was attached, which Yjs announces with no update event. Before, it was lost on reload.
