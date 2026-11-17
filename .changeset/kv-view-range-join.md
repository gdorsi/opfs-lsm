---
"@opfs-lsm/kv": minor
---

`rangeJoin` moved from `Db` to the `view` snapshot: `db.rangeJoin(range, keyOf)` is now `db.view((snap) => snap.rangeJoin(range, keyOf))`, with the same `{ entry, joined }` hits. A view can now join, so the scan and the joined reads share the view's pin with its other reads.
