---
"@opfs-lsm/kv": patch
---

`readStats` from `@opfs-lsm/kv/testing` reports removed files as a count per path class. The byte total it reported before was wrong for any file written in an earlier session, and is gone.
