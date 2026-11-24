# A TanStack DB drop-in on docstore: what can stay the same

Status: open. Nothing in sections 4 to 6 is built. `packages/tanstack-db` is a collection-options adapter with a planner, not a drop-in ([README](../../packages/tanstack-db/README.md)), and on 2026-11-24 docstore still lacked all four things in section 6.

Date: 2026-11-23, at commit `e3fc7b7b`. Sizes and counts come from the scripts in section 8. No query, sync or Solid code was run.

Question: can a library keep TanStack DB's API, remote collections included, while it stores rows only in `@opfs-lsm/docstore`, keeps no index of its own, and stays much smaller? Which parts of the API can stay, which cannot, and what does docstore lack for it?

## Answer in ten lines

1. Most of what an app types can stay: the collection options, the `sync` contract, the mutation handlers, transactions, the query builder with its operators, and `useLiveQuery` (5).
2. Four things cannot. Reads of a collection return Promises, indexes are declared, an `update` callback can run twice, and rows are JSON with a string key (5).
3. TanStack DB's core is 261.2 kB minified, 77.5 kB gzip. Its live query engine, query compiler and `db-ivm` are 105.9 kB of that, and its collection state, sync and in-memory indexes are another 72.8 kB (3.1).
4. Its query builder cannot be imported alone. The builder and the operators alone still bundle 141.1 kB, because the builder's module imports the collection class. A drop-in needs a builder of its own (3.2).
5. Its remote adapters cannot run on another core. Both read the collection's private `_state` and import values from `@tanstack/db`, the Query adapter reads rows synchronously, and the Electric adapter pins `@tanstack/db` to one version (3.3).
6. Its Solid adapter needs `solid-js ^1.9.0`, so I expect a Solid 2 hook to be new work on any design (3.4).
7. A live query needs no incremental engine here. It can read through an index again when a write lands in a key range it read. Warm docstore reads at 200,000 issues took 0.08 to 1.32 ms (2.1, 4.1).
8. The planner that turns a TanStack `where`, `orderBy` and `limit` into docstore index reads exists in `packages/tanstack-db`, at 4.3 kB minified (2.2).
9. docstore lacks four things for this: a snapshot across collections, index entry keys in the change feed, the key range a query read, and collections added after open (6).
10. The size of the result is a guess: 15 to 20 kB gzip, about a quarter of TanStack DB's core (4.5). Section 7 lists what a prototype has to settle.

## 1. Constraints from the owner

Given on 2026-11-23, in this order.

- The library has no index of its own. Every query goes through an index of the storage.
- The storage is docstore and is not pluggable. So one call opens the database: no `openDb`, then `openDocStore`, then a wrapper.
- Solid 2 is the only adapter for now.
- It is a drop-in replacement for TanStack DB. The API is as similar as possible and supports remote collections.

## 2. Repo facts the design used

Each still held on 2026-11-24.

### 2.1 docstore

- `view` reads one snapshot of one collection. No public call gives one snapshot of two collections.
- `changes` reports document rows only, so index entry writes send no event ([Changes](../../packages/docstore/README.md#changes)). A row and its index entries are written in one kv transaction, so the entry keys are among the ops of the kv event the feed filters.
- A document is a JSON object with a string `id`. The app raises the schema `version` by hand on every change to its collections.
- At 200,000 issues the 11 tracker goals took 0.08 to 1.32 ms warm and 3.55 to 19.2 ms cold on docstore, medians of 5 runs in [docs/benchmarks.md](../benchmarks.md) on 2026-11-23.

### 2.2 The planner in `packages/tanstack-db`

It turns a `where`, the first `orderBy` clause and a `limit` into reads by id, index ranges, or a scan, and TanStack's `compileSingleRowExpression` filters each row after the read. The index orders strings by code point and TanStack by UTF-16 unit, so a string is a bound only when both orders agree on it.

### 2.3 The example that wires live lists by hand

`examples/linearlite-docstore`, on `solid-js ^2.0.3`, states each list's filter and order a second time in JavaScript (`keeps`, `orderOf`), moves rows in memory when an issue changes, and follows the change feed itself, in 673 lines of `store.ts`, `list.ts` and `app.ts`. Its view reads a list with `createMemo(() => from(props.app.list.subscribe))`.

## 3. TanStack DB facts

### 3.1 The core by part

[E parts] An entry that imports `createCollection`, `createLiveQueryCollection` and `eq` from `@tanstack/db` 1.0.0-rc.1.5 bundles to 261.2 kB minified, 77.5 kB gzip. Parts of 4 kB or more, minified:

| Part | kB | Part | kB |
|---|---:|---|---:|
| `query/live` | 40.4 | `collection/lifecycle` | 7.7 |
| `query/compiler` | 39.2 | `proxy` | 7.3 |
| `db-ivm` | 26.3 | `query/optimizer` | 6.9 |
| `query/builder` | 17.5 | `collection/index` | 5.7 |
| `collection/subscription` | 16.9 | `errors` | 5.7 |
| `collection/state` | 16.3 | `transactions` | 5.5 |
| `utils` | 13.6 | `collection/mutations` | 4.8 |
| `collection/sync` | 11.5 | `collection/changes` | 4.4 |
| `query/ir-stable-identity` | 8.6 | `query/ir` | 4.2 |

The nine `collection/` parts of 1 kB or more, two of them under 4 kB, add up to 72.8 kB.

### 3.2 The builder alone

[E parts] An entry that builds one query with `Query`, `and`, `eq`, `gt`, `inArray` and takes `compileSingleRowExpression` bundles to 141.1 kB minified, 40.7 kB gzip. `query/live`, `db-ivm` and most of `query/compiler` are gone, but every `collection/` part is still there, with `proxy` and `transactions`. The builder itself is 17.3 kB of it. [E tsdb] The cause is that `dist/esm/query/builder/index.js` imports `CollectionImpl`.

### 3.3 The remote adapters

[E adapters] What each adapter uses of the collection it syncs:

| Adapter | `@tanstack/db` | Private state it reads | Synchronous reads |
|---|---|---|---|
| `@tanstack/query-db-collection` 1.5.2 | peer `^1.0.0-rc.0` | `_state.getAcceptedSyncedRow` 13 times, 6 other `_state` uses, `_sync.unloadSubset` 2 | `get` 2, `has` 1 |
| `@tanstack/electric-db-collection` 1.0.0-rc.1.5 | dependency, exactly `1.0.0-rc.1.5` | `_state.acceptedSyncedEntries` 2, `_state.syncedData.has` 1, `_state.pendingSyncedTransactions` 1 | None |

The counts leave out `metadata.collection`, the sync metadata store. Both import values from `@tanstack/db`, such as `whenSyncAccepted` and `withCollectionConfigFactory`, so an app that used one of them on another core would bundle TanStack DB's core too.

### 3.4 Solid

- [E adapters] `@tanstack/solid-db` 1.0.0-rc.1.5 has `solid-js ^1.9.0` as a peer dependency and `@tanstack/db` 1.0.0-rc.1.5 as a dependency.
- [E solid] In Solid 2.0.3 a memo's compute function, and the function `createProjection` takes, can return a Promise or an `AsyncIterable`. `from` turns a subscribe function into an `AsyncIterable`. `createProjection` takes a `key` option that names the property rows are matched by.

## 4. Proposed design

All of this section is inference. Section 5 shows what app code keeps.

### 4.1 Live queries by read set

A live query is a function that reads one docstore snapshot and records the kv key ranges it read: an index range up to the last entry returned, or one row key. A query with `limit: 50` read up to its 50th entry, so a write past that entry does not touch it. A change event whose batch has a key in one of those ranges marks the query dirty, and a `gap` event marks every query dirty. Dirty queries run again together in one snapshot, at most once per frame, so every query on screen shows one state of the database.

The library keeps no copy of a filter or an order in JavaScript, which 2.3 does by hand and where the string orders of 2.2 can disagree. A join is two reads in one snapshot: an index lookup per row when the joined field has an index, a scan otherwise. `groupBy` and aggregates are computed again on each run. A `count` over one index range uses docstore's `count`, which reads no document.

### 4.2 Mutations

A mutation writes the visible row in one docstore transaction with a pending record that holds the row as it was, then runs the handler. On success the record is deleted, and on failure the row goes back. A sync write to a row with a pending record updates the record and leaves the visible row, as TanStack DB shows the synced state with the optimistic changes over it. Unlike TanStack DB, other tabs see an optimistic row, and `update` reads the row inside a docstore `modify`, so no other tab writes in between.

### 4.3 Remote collections

[E tsdb] An adapter's `sync` receives `{ collection, begin, write, commit, markReady, truncate, ... }` and can return `loadSubset`, which an on-demand collection calls. Here `commit` lands what `begin` and `write` buffered as one docstore transaction, so a reload shows server rows before the network answers. On demand, a live query runs its plan on docstore and also passes the query to `loadSubset`. Because of 3.3, the library ships its own option creators with TanStack DB's option names, the Query one first.

### 4.4 Solid 2

`useLiveQuery` is a memo over the query for a single value, and a projection with `key` for a list, so a run that returns the same rows reports only the fields that changed. This rests on 3.4 and is the shape the example's view already uses (2.3).

### 4.5 Size

Of the parts in 3.1, a design without an in-memory collection and an incremental engine has to match only the builder (17.5 kB), the expression tree (4.2 kB), the row evaluators (5.5 kB, what 3.2 keeps of `query/compiler`), the draft proxy (7.3 kB), and transactions with mutations (10.3 kB): 44.8 kB minified as TanStack DB writes them. With the planner (4.3 kB), the executor, the query registry and the sync buffer, the guess is 15 to 20 kB gzip. `@opfs-lsm/kv` and `@opfs-lsm/docstore` come on top, as a persistence package does for TanStack DB.

## 5. Compatibility

| TanStack DB | Here |
|---|---|
| `createCollection` options, the `sync` contract, handlers, `createTransaction` | The same shape |
| Builder and operators (`from`, `where`, `orderBy`, `eq`, and the rest) | The same syntax on another runtime |
| `useLiveQuery` | The same call, written for Solid 2 |
| `get`, `has`, `state`, `toArray`, `size`, `keys`, `values`, `entries` | They return Promises: no row is held in memory |
| `autoIndex`, `createIndex` | An `indexes` field on the options. A `where` that no index serves is a scan |
| `update(key, draft => ...)` | Applied after one docstore read. The callback can run twice, so it must be pure |
| Rows and keys | A row is JSON, and its key is stored as a string `id`. A `Date` or a number key needs a mapping |
| `join`, `groupBy`, aggregates | Computed on each run, not maintained |
| `queryCollectionOptions`, `electricCollectionOptions` from TanStack's packages | Not usable. The library ships its own |

## 6. What docstore needs

1. **A snapshot across collections.** 4.1 runs every dirty query in one snapshot, and a join reads two collections. `view` is per collection (2.1).
2. **Index entry keys in the change feed.** 4.1 matches written keys against index ranges. `changes` drops them (2.1).
3. **The key range a query read.** docstore can derive it from the query's bounds and its `next` cursor.
4. **Collections and indexes added after open.** TanStack DB creates a collection at any time and has no schema version. The library would derive the docstore schema from the collection options and raise the stored version itself (2.1).

The first three can sit behind an entry point of docstore that only this library imports, so docstore's main bundle does not grow.

## 7. Unconfirmed

- Whether `from` subscribes inside the memo's own run, which decides whether signals read by the query function are tracked.
- The cost of a second run on cold pages and during a bulk write. 2.1 gives first reads, not reads that follow a write.
- A deep `offset` walks every entry it passes. The example's cursor cache (`rangeView` in `store.ts`) has no place in the design yet.
- TanStack DB is a release candidate, and its adapters use private state, so its API can still move.
- Three defaults nobody has confirmed: the first builder has no `groupBy`, `having` or `distinct`, pending mutations roll back at the next open, and every collection shares one default database. The Electric option creator is not designed.

## 8. Sources

- **[E parts]** `node docs/research/tanstack-db-drop-in/bundle-parts.mjs`, on the `@tanstack/db` that `bench/package.json` pins (1.0.0-rc.1.5) with the esbuild that `packages/kv/package.json` pins (0.28.2).
- **[E adapters]** `node docs/research/tanstack-db-drop-in/adapter-internals.mjs`, which downloads the three adapters at the versions in 3.3 and 3.4 and counts each `collection.` member their sources use.
- **[E tsdb]** `@tanstack/db` 1.0.0-rc.1.5, `dist/esm/types.d.ts` (`SyncConfig`, `BaseCollectionConfig`) and `dist/esm/collection/index.d.ts`.
- **[E solid]** `@solidjs/signals` 2.0.3, `dist/types/`, the package `solid-js` 2.0.3 takes its reactive core from.
