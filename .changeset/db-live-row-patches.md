---
"@opfs-lsm/db": minor
---

A live list with no limit or offset follows each write by placing, replacing or removing the written document in the result, with no read. A `select` must include every field of the order for this. Rows that did not change keep their identity.
