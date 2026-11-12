---
"@opfs-lsm/kv": minor
---

`readStats` from `@opfs-lsm/kv/testing` reports removed files as a count per path class: `IoCounters.removed` is now `Record<string, number>`, not `Record<string, IoCount>`. The byte total it reported before was wrong for any file written in an earlier session, and is gone.
