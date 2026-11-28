---
"@opfs-lsm/db": minor
---

A live count with no offset or limit, exact on an index, follows each write by the index entries the write added and removed in its ranges, with no read.
