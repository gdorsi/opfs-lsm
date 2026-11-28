---
"@opfs-lsm/docstore": minor
---

Docstore no longer validates documents. `collection(validator)` is gone: declare a collection with `collection<T>()`, and `put`, `putMany`, `modify` and `modifyMany` take and return `T`. The `"invalid"` error code, the `issues` field of `DocStoreError` and the `In` type parameter of `Collection` are removed. A validator guarded only the writes of one handle, so another tab or `kv.ingest` could already store a document it would reject. Validate in your app, or write through `@opfs-lsm/db`, which validates every write with a Standard Schema validator.
