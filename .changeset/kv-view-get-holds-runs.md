---
"@opfs-lsm/kv": patch
---

A `get` or `getMany` of a view keeps its run files until it settles, as the view's scans do. A write that commits while its handle closes reaches the other tabs.
