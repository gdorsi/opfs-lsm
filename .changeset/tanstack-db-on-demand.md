---
"@opfs-lsm/tanstack-db": minor
---

`onDemand: { plan }` makes a collection load only what live queries ask for (`syncMode: "on-demand"`). `plan` turns a query's subset into keys or a string key prefix, the adapter reads them in one kv view, follows writes to the rows a loaded plan covers, and drops rows from memory when no loaded plan covers them.
