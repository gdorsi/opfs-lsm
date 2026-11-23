# A TanStack DB drop-in on docstore: what can stay the same

Status: a proposal. Nothing in sections 4 to 6 is built or prototyped.

Question: can a library keep TanStack DB's API, remote collections included, while it stores rows only in `@opfs-lsm/docstore`, keeps no index of its own, and stays much smaller? Which parts of the API can stay, which cannot, and what does docstore lack for it?

## Answer in ten lines

1. Most of what an app types can stay: the collection options, the `sync` contract, the mutation handlers, transactions, the query builder with its operators, and `useLiveQuery` (5).
2. Four things cannot. Reads of a collection return Promises, indexes are declared, an `update` callback can run twice, and rows are JSON with a string key (5).
3. TanStack DB's core is 261.2 kB minified, 77.5 kB gzip. Its live query engine, query compiler and `db-ivm` are 105.9 kB of that, and its collection state, sync and in-memory indexes are another 72.8 kB (3.1).
4. Its query builder cannot be imported alone. An entry that uses only the builder and the operators still bundles 141.1 kB, 40.7 kB gzip, because the builder's module imports the collection class. A drop-in needs a builder of its own (3.2).
5. Its remote adapters cannot run on another core. The Query adapter reads `collection._state` 19 times and reads rows with a synchronous `collection.get` and `collection.has`. The Electric adapter reads `collection._state` 4 times and pins `@tanstack/db` to one version. Both import values from it (3.3).
6. Its Solid adapter needs `solid-js ^1.9.0`, so I expect a Solid 2 hook to be new work on any design (3.4).
7. A live query needs no incremental engine here. It can read through an index again when a write lands in a key range it read. Warm docstore reads at 200,000 issues take 0.08 to 1.32 ms (2.1, 4.2).
8. The planner that turns a TanStack `where`, `orderBy` and `limit` into docstore index reads exists in `packages/tanstack-db`, at 4.3 kB minified (2.2).
9. docstore lacks four things for this: a snapshot across collections, index entry keys in the change feed, the key range a query read, and collections added after open (6).
10. The size of the result is a guess: 15 to 20 kB gzip, about a quarter of TanStack DB's core (4.6). Section 7 lists what a prototype has to settle.

---

Conventions as in `document-store-prior-art.md`. **[R]** repo fact, cited `file:line` at `e3fc7b7b`. **[E key]** external fact; keys resolve in section 8. **[I]** my inference.

Method. The bundle sizes and the adapter counts come from the two scripts in [`docs/research/tanstack-db-drop-in/`](tanstack-db-drop-in/), run on 2026-11-23. The Solid 2 facts come from the type declarations of the published packages, read by search. No query, sync or Solid code was run.

---

## 1. Constraints from the owner

Given on 2026-11-23, in this order.

- The library has no index of its own. Every query goes through an index of the storage.
- The storage is docstore and is not pluggable. So one call opens the database: no `openDb`, then `openDocStore`, then a wrapper.
- Solid 2 is the only adapter for now.
- It is a drop-in replacement for TanStack DB. The API is as similar as possible and supports remote collections.

## 2. Repo facts

### 2.1 docstore

- [R] A collection reads through declared indexes, and `view` runs several reads against one snapshot of one collection (`packages/docstore/src/collection.ts:98`). No public call gives one snapshot of two collections: a store has `collection` and `whenIdle` only (`packages/docstore/src/store.ts:38`). Inside the store, a collection can be resolved at a given kv snapshot (`packages/docstore/src/store.ts:84`).
- [R] `changes` reports document rows only. The follower keeps the ops whose key starts with the collection's row prefix (`packages/docstore/src/changes.ts:106`), so index entry writes send no event (`packages/docstore/README.md:646`). The follower gets every op of each kv event and filters them (`changes.ts:102`). [I] A write puts a row and its index entries in one kv transaction, so the entry keys are among those ops.
- [R] A `changes` listener sees a write before `put` resolves (`packages/docstore/README.md:632`).
- [R] A document is a JSON object with a string `id` (`packages/docstore/README.md:83`).
- [R] A schema has a `version` that the app raises by hand on every change to its collections (`packages/docstore/README.md:48`, and "Schema versions" at line 690).
- [R] At 200,000 issues, the 11 tracker goals take 0.08 to 1.32 ms warm on docstore, and 3.55 to 19.2 ms cold, as medians of 5 runs (`docs/benchmarks.md:145`).

### 2.2 The planner in `packages/tanstack-db`

- [R] `planRead` turns a TanStack `where`, the first `orderBy` clause and a `limit` into one of three plans: documents by id, index ranges, or a scan of every document (`packages/tanstack-db/src/plan.ts:42`, `:86`).
- [R] It reads `eq`, `in`, `gt`, `gte`, `lt`, `lte`, `like` and `ilike` from the top-level conjuncts of the `where` (`plan.ts:242`). Anything else is left to a filter that runs on each row after the read (`packages/tanstack-db/src/index.ts:556`).
- [R] With no index that fits, the plan is a scan (`plan.ts:102`). A plan holds at most 64 ranges (`plan.ts:55`).
- [R] The index orders strings by code point and TanStack by UTF-16 unit, so a string is used as a bound only when both orders agree on it (`plan.ts:324`).
- [R] The index orders by type first, where a JavaScript comparison coerces (`packages/tanstack-db/README.md:64`).
- [R] The adapter's key is the document's `id` (`index.ts:113`), and the row filter is TanStack's `compileSingleRowExpression` (`index.ts:3`).

### 2.3 The example that wires live lists by hand

- [R] `examples/linearlite-docstore` runs on `solid-js ^2.0.3` (`examples/linearlite-docstore/package.json:16`). Its `store.ts`, `list.ts` and `app.ts` are 673 lines.
- [R] It states each list's filter and order a second time in JavaScript (`keeps` and `orderOf`, `src/store.ts:33`, `:49`), and moves rows in memory when an issue changes (`remove` and `insert`, `src/list.ts:91`, `:104`).
- [R] It follows the change feed itself, with a set of the ids it is creating and a full read after a gap (`src/app.ts:59`, `:66`, `:83`).
- [R] The view reads the list with `createMemo(() => from(props.app.list.subscribe))` (`src/issues.tsx:19`).

## 3. TanStack DB facts

### 3.1 The core by part

[E parts] An entry that imports `createCollection`, `createLiveQueryCollection` and `eq` from `@tanstack/db` 1.0.0-rc.1.5 bundles to 261.2 kB minified, 77.5 kB gzip. Parts of 4 kB or more:

| Part | Minified |
|---|---:|
| `query/live` | 40.4 kB |
| `query/compiler` | 39.2 kB |
| `db-ivm` | 26.3 kB |
| `query/builder` | 17.5 kB |
| `collection/subscription` | 16.9 kB |
| `collection/state` | 16.3 kB |
| `utils` | 13.6 kB |
| `collection/sync` | 11.5 kB |
| `query/ir-stable-identity` | 8.6 kB |
| `collection/lifecycle` | 7.7 kB |
| `proxy` | 7.3 kB |
| `query/optimizer` | 6.9 kB |
| `collection/index` | 5.7 kB |
| `errors` | 5.7 kB |
| `transactions` | 5.5 kB |
| `collection/mutations` | 4.8 kB |
| `collection/changes` | 4.4 kB |
| `query/ir` | 4.2 kB |

The nine `collection/` parts of 1 kB or more, two of them under 4 kB, add up to 72.8 kB.

### 3.2 The builder alone

[E parts] An entry that builds one query with `Query`, `and`, `eq`, `gt`, `inArray` and takes `compileSingleRowExpression` bundles to 141.1 kB minified, 40.7 kB gzip. `query/live`, `db-ivm` and most of `query/compiler` are gone, but every `collection/` part is still there, with `proxy` and `transactions`. The builder itself is 17.3 kB of it.

[E tsdb] The cause is in the package: `dist/esm/query/builder/index.js` imports `CollectionImpl`.

### 3.3 The remote adapters

[E adapters] What each adapter uses of the collection it syncs:

| Adapter | `@tanstack/db` | Private state it reads | Synchronous reads |
|---|---|---|---|
| `@tanstack/query-db-collection` 1.5.2 | peer `^1.0.0-rc.0` | `_state.getAcceptedSyncedRow` 13 times, 6 other `_state` uses, `_sync.unloadSubset` 2 | `get` 2, `has` 1 |
| `@tanstack/electric-db-collection` 1.0.0-rc.1.5 | dependency, exactly `1.0.0-rc.1.5` | `_state.acceptedSyncedEntries` 2, `_state.syncedData.has` 1, `_state.pendingSyncedTransactions` 1 | None |

The counts leave out `metadata.collection`, which is the sync metadata store and not the collection. Both import values, not only types, from `@tanstack/db`: `whenSyncAccepted`, `withCollectionConfigFactory`, `validateSyncPersistenceCapability` and others. An app that used one of them on another core would bundle TanStack DB's core too.

[E tsdb] The contract an adapter implements is `SyncConfig`, whose `sync` function receives `{ collection, begin, write, commit, markReady, truncate, ... }`. `begin` and `write` return nothing, and `commit` returns `true` or a Promise (`SyncAppliedReceipt`). The object that `sync` returns can hold `loadSubset`, which a collection with `syncMode: "on-demand"` calls.

### 3.4 Solid

- [E adapters] `@tanstack/solid-db` 1.0.0-rc.1.5 has `solid-js ^1.9.0` as a peer dependency and `@tanstack/db` 1.0.0-rc.1.5 as a dependency.
- [E solid] In Solid 2.0.3 a memo's compute function can return a Promise or an `AsyncIterable` (`ComputeFunction`, `signals.d.ts:74`), and `from` turns a subscribe function into an `AsyncIterable` (`from.d.ts:46`).
- [E solid] `createProjection` takes a function that returns a Promise or an `AsyncIterable`, and a `key` option that names the property rows are matched by (`store/projection.d.ts:20`, `store/types.d.ts:54`).

## 4. Proposed design

All of this section is [I].

### 4.1 What app code looks like

```ts
import { createCollection, and, eq, inArray } from "@opfs-lsm/db"; // the name is open
import { queryCollectionOptions } from "@opfs-lsm/db/query";
import { useLiveQuery } from "@opfs-lsm/db/solid";

export const issues = createCollection(
	queryCollectionOptions({
		id: "issues",
		queryKey: ["issues"],
		queryFn: () => api.issues(),
		queryClient,
		getKey: (i) => i.id,
		// the one field TanStack DB does not have
		indexes: { byStatus: ["projectId", "status", "updatedAt"] },
		onUpdate: ({ transaction }) => api.patch(transaction.mutations[0]),
	}),
);

const open = useLiveQuery((q) =>
	q
		.from({ i: issues })
		.where(({ i }) => and(eq(i.projectId, projectId()), inArray(i.status, ["todo", "started"])))
		.orderBy(({ i }) => i.updatedAt, "desc")
		.limit(50),
);

issues.update(id, (draft) => {
	draft.status = "done";
});
const issue = await issues.get(id); // a Promise here, a value in TanStack DB
```

### 4.2 Live queries by read set

A live query is a function that reads one docstore snapshot. Each run records the kv key ranges it read:

```ts
// an index range up to the last entry returned, or one row key
type Read = { from: Uint8Array; to: Uint8Array };
type Watch = { run: () => Promise<unknown>; reads: Read[]; seq: number; dirty: boolean };
```

1. A run opens one snapshot, executes the plan, and records a `Read` per docstore call. A query with `limit: 50` read from the start of its range to its 50th entry, so a write past that entry does not touch it.
2. Each change event carries the keys of its batch. A watch is dirty when a key falls in one of its reads. A `gap` event makes every watch dirty.
3. Dirty watches run again together in one snapshot, at most once per frame, so every query on screen shows one state of the database.

The index decides what a query holds. The library keeps no copy of a filter or an order in JavaScript, which is what 2.3 does by hand and where the two string orders of 2.2 can disagree.

A join is two reads in one snapshot: an index lookup per row when the joined field has an index, a scan otherwise. `groupBy` and aggregates are computed again on each run. A `count` over one index range uses docstore's `count`, which reads no document.

### 4.3 Mutations

`insert`, `update` and `delete` write the visible row to docstore in one transaction with a pending record, which holds the row as it was:

```ts
type Pending = {
	id: string;
	collection: string;
	key: string;
	type: "insert" | "update" | "delete";
	original?: JsonDoc;
	tx: string;
};
```

The handler (`onInsert`, `onUpdate`, `onDelete`, or a transaction's `mutationFn`) then runs. On success the record is deleted. On failure the row goes back to `original`. A sync write to a row that has a pending record updates `original` and leaves the visible row, which is TanStack DB's rule that the visible state is the synced state with the optimistic changes over it.

Two effects differ from TanStack DB. Other tabs see an optimistic row, because it is stored. And `update` reads the row inside a docstore `modify`, so no write from another tab lands between the read and the write.

### 4.4 Remote collections

A collection's `sync` function gets the same `begin`, `write`, `commit`, `markReady` and `truncate`. `begin` and `write` fill a buffer, and `commit` lands it as one docstore transaction. Server rows are then on disk, so a reload shows them before the network answers. With `syncMode: "on-demand"`, a live query runs its plan on docstore and also passes the query to the adapter's `loadSubset`.

The library ships its own option creators, with TanStack DB's option names, because of 3.3. The Query one comes first.

### 4.5 Solid 2

`useLiveQuery` is a memo over the watch for a single value, and a projection with `key` for a list, so a run that returns the same rows keeps them and reports only the fields that changed. `<Loading>` covers the first read. This rests on 3.4 and is the same shape as `src/issues.tsx:19`.

### 4.6 Size

The parts of 3.1 that a design without an in-memory collection and without an incremental engine has no use for are `query/live`, `query/compiler` less its row evaluators, `db-ivm`, `query/optimizer`, `query/ir-stable-identity`, and most of `collection/`. The parts it has to match are the builder (17.5 kB), the expression tree (4.2 kB), the row evaluators (5.5 kB, what 3.2 keeps of `query/compiler`), the draft proxy (7.3 kB), and transactions with mutations (10.3 kB): 44.8 kB minified as TanStack DB writes them. The other four sizes are from 3.1. With the planner (4.3 kB), the executor, the watch registry and the sync buffer, my guess is 15 to 20 kB gzip. `@opfs-lsm/kv` and `@opfs-lsm/docstore` come on top, as a persistence package does for TanStack DB.

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

1. **A snapshot across collections.** 4.2 runs every dirty query in one snapshot, and a join reads two collections. `view` is per collection today (2.1).
2. **Index entry keys in the change feed.** 4.2 matches written keys against index ranges. `changes` drops them today (2.1).
3. **The key range a query read.** docstore can derive it from the query's bounds and its `next` cursor.
4. **Collections and indexes added after open.** TanStack DB creates a collection at any time and has no schema version. The library would derive the docstore schema from the collection options and raise the stored version itself (2.1).

The first three can sit behind an entry point of docstore that only this library imports, so docstore's main bundle does not grow.

## 7. Unconfirmed

- Nothing in sections 4 to 6 was run.
- Whether `from` subscribes inside the memo's own run, which decides whether signals read by the query function are tracked.
- The cost of a second run on cold pages and during a bulk write. 2.1 gives warm and cold times of first reads, not of reads that follow a write.
- A deep `offset` walks every entry it passes. The example's cursor cache (`rangeView`, `src/store.ts:74`) has no place in the design yet.
- The size in 4.6 is a guess from the sizes of TanStack DB's own parts.
- TanStack DB is a release candidate, and its adapters use private state, so its API can still move.
- Three defaults nobody has confirmed: the first builder has no `groupBy`, `having` or `distinct`; pending mutations roll back at the next open; every collection shares one default database.
- The Electric option creator is not designed.

## 8. Sources

- **[E parts]** `node docs/research/tanstack-db-drop-in/bundle-parts.mjs`, on the `@tanstack/db` that `bench/package.json` pins (1.0.0-rc.1.5) with the esbuild that `packages/kv/package.json` pins (0.28.2).
- **[E adapters]** `node docs/research/tanstack-db-drop-in/adapter-internals.mjs`, which downloads `@tanstack/query-db-collection` 1.5.2, `@tanstack/electric-db-collection` 1.0.0-rc.1.5 and `@tanstack/solid-db` 1.0.0-rc.1.5 from npm and counts each `collection.` member their sources use.
- **[E tsdb]** `@tanstack/db` 1.0.0-rc.1.5, `dist/esm/types.d.ts` (`SyncConfig`, `BaseCollectionConfig`) and `dist/esm/collection/index.d.ts`.
- **[E solid]** `@solidjs/signals` 2.0.3, `dist/types/`, the package `solid-js` 2.0.3 takes its reactive core from.
