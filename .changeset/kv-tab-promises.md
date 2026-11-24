---
"@opfs-lsm/kv": patch
---

`openDb` rejects with `StorageUnavailableError`, with the browser's error as `cause`, when a browser API it needs is there and refuses with a `DOMException`: OPFS, `new SharedWorker()` or `indexedDB.open()`, as in a Firefox private window or on a page of an opaque origin. A handle whose IndexedDB connection the browser closes by force, as clearing site data does, reports `closed` with reason `"destroyed"`, and its calls reject with `ClosedError`. An IndexedDB transaction the browser aborts no longer leaves an unhandled rejection behind the call's own. A database name that is not a string throws `ConstraintError`. `openHarnessDb` flushes to the `fs` it was given, also after an earlier open of the same name was given another.
