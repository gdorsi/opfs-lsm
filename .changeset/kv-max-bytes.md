---
"@opfs-lsm/kv": minor
---

`openDb({ maxBytes })` and `db.onPressure(handler)`. Past `maxBytes` of live rows, the SharedWorker offers the handlers of one tab, chosen by the Web Lock `opfs-lsm-pressure/<name>`, a `Pressure` with how many bytes to remove and a seq through which removing every row frees about that much. kv never removes a row for the cap and never holds a write for it. With no handler in any tab, each tab with a `maxBytes` handle warns once per offer.
