---
"@opfs-lsm/kv": minor
"@opfs-lsm/yjs": minor
"@opfs-lsm/automerge": minor
"@opfs-lsm/tanstack-query": minor
---

An app on the Yjs, Automerge or TanStack Query adapter keeps working in a browser where kv cannot store. `openDb(options).catch(noStorage)` gives `undefined` there, and each adapter takes it: `KvPersistence` keeps a doc's updates in the page's memory, `kvStorage` keeps the chunks in its own memory, and `createQueryPersister` stores nothing. Every other open error still rejects.
