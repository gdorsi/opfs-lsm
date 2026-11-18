---
"@opfs-lsm/kv": minor
---

`destroyDb(name)` now removes the database: its OPFS folder and its IndexedDB database go, and every open handle on it, in every tab, closes first with a `closed` event whose new `reason` field is `"destroyed"`. On a name with nothing stored it creates nothing. `dangerousDestroy()` still empties the database and keeps it open.
