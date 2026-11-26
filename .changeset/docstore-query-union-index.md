---
"@opfs-lsm/docstore": minor
---

A query whose `index` is a union, such as a sort the user picks, type-checks when it suits every index in the union, with no cast. `queryEntries` on such a union returns a union of pages, so `fields` is typed only when every index in it declares `include`. Types only: nothing changes at runtime.
