# TanStack DB backends under one app model

linearlite-tanstackdb is moving to a headless model, and the bench will run that model on three persistence backends:

- opfs-lsm's `docstoreCollectionOptions`;
- TanStack DB's IndexedDB persistence;
- TanStack DB's SQLite persistence (`@tanstack/browser-db-sqlite-persistence`).

This note records what a throwaway spike measured before the seam between the model and storage was designed. It covers what each backend can do, and what the model's operations cost on each.

## Setup

- **Data.** 100,000 seeded issue rows shaped like linearlite's stored issue. About 1% carry `pending: true`.
- **Run.** One bench workload that built all three backends itself, 3 reps, TanStack DB 1.0.0-rc.1.5, headless Chrome 157 on an M5 Max.
- **Durability.** SQLite ran with `synchronous=FULL` and again with `OFF`. IndexedDB and opfs-lsm use IndexedDB's default, which is relaxed on Chrome.

## Results

### An unloaded row cannot be updated on SQLite

On a cold on-demand SQLite collection, `update(id)` of a row no query has loaded throws `UpdateKeyNotFoundError`, and `delete` throws `DeleteKeyNotFoundError`. Nothing is written. `insert` of an existing unloaded id overwrites the stored row without an error. A write on SQLite must load its rows first.

### Read, merge and write 500 rows

This is what a sync merge does. The table gives the p50 per batch over 20 batches, as the median of the 3 reps (range).

| Path | p50 |
|---|---|
| opfs-lsm `utils.transact` | 14.2 ms (12.4–14.5) |
| opfs-lsm, live query by id, then `update` | 20.3 ms (19.5–20.4) |
| IndexedDB (eager), `get` per id, then `update` | 46.2 ms (44.9–49.7) |
| SQLite, load, then write, `synchronous=FULL` | 126 ms (120–130) |
| SQLite, the same, `synchronous=OFF` | 90 ms (88–105) |

SQLite spends about 10 ms loading and about 110 ms writing. Every touched row read back correctly after a reload.

### A pending-rows live query fires on every backend

A live query `where eq(pending, true)` updates within 0.06 ms of the `update` on all three backends. It fires from TanStack's in-memory state before anything is persisted. A row reaches the query only once it is loaded.

### Per-status counts over 100,000 issues

| Path | Time |
|---|---|
| opfs-lsm, docstore index entries, no documents read | 28–57 ms |
| opfs-lsm, TanStack `groupBy` | 610–1,180 ms |
| SQLite, TanStack `groupBy` | 614–994 ms |
| IndexedDB, TanStack `groupBy` | 140–303 ms, over rows already in memory |

On the same engine, the TanStack `groupBy` path took about 20 times as long as the index count. So counting stays a backend member, and the bench reports which path each backend used. IndexedDB's count is fast because its eager open had already loaded every row, which took 0.85 to 1.0 s and 56 MB.

### Cold open to the first 50 rows

The time runs from the start of the phase on a fresh page, sorted by `modified` descending, with `deleted` false.

| Backend | Total |
|---|---|
| opfs-lsm through TanStack | 35–71 ms |
| SQLite | 1.24–1.47 s |
| IndexedDB, eager, no index | 1.88–2.05 s |
| IndexedDB, eager, `createIndex` on `modified` and `deleted` | 1.04–1.10 s |

SQLite applies `ORDER BY` in SQL but `limit` in JavaScript, after it decodes every matching row. So a first page costs as much as the whole table. IndexedDB persistence is eager only, so it reads every row before the first query.

## What the seam keeps

- **`transact(stream, items, merge)` stays a backend member.** opfs-lsm runs it as one kv transaction. IndexedDB reads from memory, then writes. SQLite loads, then writes.
- **Counting stays per backend.**
- **`locate` and the pressure callback exist only on opfs-lsm.** The model must work without them.

## Limits

- **Main-thread work.** The `groupBy` and first-page times are mostly TanStack's live query engine and row decoding on the main thread, not storage.
- **Durability is not like for like.** SQLite `FULL` syncs, and the others do not.
- **Page load is excluded** from the cold-open times.
- **Memory is approximate.** Tab memory came from `measureUserAgentSpecificMemory`, and it excludes the SharedWorker that hosts kv.
