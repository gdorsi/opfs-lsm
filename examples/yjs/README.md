# Yjs + KV persistence

[`src/kv-persistence.ts`](./src/kv-persistence.ts) is `KvPersistence`, a Yjs provider on `@opfs-lsm/kv` with the shape of y-indexeddb's `IndexeddbPersistence`: `new KvPersistence(db, name, doc)`, `whenSynced`, `flush()`, `destroy()`. Many documents share one kv db; each local update is one `put`, a load is one range scan, and a load that finds 500 updates or more merges them into one.

## Benchmark

`pnpm bench yjs/` compares `KvPersistence` with y-indexeddb on an editing trace and on many small notes. See [bench/README.md](../../bench/README.md).
