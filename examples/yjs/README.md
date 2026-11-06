# Yjs + KV persistence

[`src/kv-persistence.ts`](./src/kv-persistence.ts) is `KvPersistence`, a Yjs provider on `@opfs-lsm/kv` with the shape of y-indexeddb's `IndexeddbPersistence`: `new KvPersistence(db, name, doc)`, `whenSynced`, `flush()`, `destroy()`. Many documents share one kv db; each local update is one `put`, a load is one range scan, and a load that finds 500 updates or more merges them into one.

## Load bench

Loads `DOCS` random documents out of a set of `DOCS * 10`, cold and warm, on kv with its default ingest policy (`kv`), kv with everything still in the WAL (`kv-wal`) or everything in SSTs (`kv-sst`), and y-indexeddb:

```sh
pnpm bench:yjs                     # DOCS=5000 RUNS=3: 5,000 of 50,000 docs
DOCS=500 RUNS=5 pnpm bench:yjs   # smaller set, more runs
```

See `.agents/skills/verify-opfs-lsm/features/yjs-bench.md` for the knobs and how to read the output.
