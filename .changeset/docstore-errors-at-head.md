---
"@opfs-lsm/docstore": patch
---

A write, and `openDocStore`, decide their errors on a state that holds every write acked before the call, from any tab. A tab that had not yet read another tab's write could throw from what it held: `"unique"` for a value the other tab had freed or for a unique index its newer schema had removed, `modify`'s `fn` could get a document the other tab had replaced, and `openDocStore` could throw `"schema"` for a lower version than the one the other tab had stored. Such a call now reads the other tabs' writes and decides again.
