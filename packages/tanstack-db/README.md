# @opfs-lsm/tanstack-db

A [TanStack DB](https://tanstack.com/db/latest/docs/overview) collection stored in an [`@opfs-lsm/docstore`](../docstore/README.md) collection. Writes from every tab arrive live.

```sh
pnpm add @opfs-lsm/tanstack-db @opfs-lsm/docstore @opfs-lsm/kv \
  @tanstack/db
```

```ts
import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { openDb } from "@opfs-lsm/kv";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection } from "@tanstack/db";

type Todo = { id: string; title: string; done: boolean };
const schema = defineSchema({
	version: 1,
	collections: { todos: collection<Todo>() },
});
const kv = await openDb({ name: "app" });
const store = await openDocStore(kv, schema);
const options = docstoreCollectionOptions({
	collection: store.collection("todos"),
});
const todos = createCollection(options);
todos.insert({ id: "1", title: "Buy milk", done: false });
// stored, and every tab on "app" sees it
```

## On-demand sync

`syncMode` defaults to `"eager"`, which loads every document. `"on-demand"` loads only the rows live queries ask for, through the docstore index whose leading fields the query pins with `eq` or `inArray`. With no index that fits, a load reads every document.

```ts
type Issue = { id: string; status: number; modified: number };
const tracker = defineSchema({
	version: 1,
	collections: {
		issues: collection<Issue>().index("byStatus", ["status", "modified"]),
	},
});
const trackerKv = await openDb({ name: "tracker" });
const trackerStore = await openDocStore(trackerKv, tracker);
const issuesOptions = docstoreCollectionOptions({
	collection: trackerStore.collection("issues"),
	syncMode: "on-demand",
});
const issues = createCollection(issuesOptions);
```

```ts
import { createLiveQueryCollection, eq } from "@tanstack/db";

const status1 = createLiveQueryCollection((q) =>
	q.from({ i: issues }).where(({ i }) => eq(i.status, 1)),
);
// reads byStatus [1]
```

**Note.** A load through an index assumes each document fits it, or it misses documents the query matches:

- A document without an indexed field, or without a text index's text field, has no entry in that index. Store `null` instead.
- The index orders by type first (null, then false, then true, then numbers, then strings) where JavaScript coerces, so `gt(i.status, 0)` misses a `status` stored as `true`, and `lt(i.status, 9)` misses `"7"`. Keep one type, plus `null`, in an indexed field, and compare it with values of that type: `gt(i.estimate, "2")` misses an `estimate` stored as `3`.
- A text index holds text in NFC, so `like` and `ilike` through it miss text stored decomposed (NFD). Store `text.normalize("NFC")`.

## Transact

An update stores the whole row as this tab holds it, so when two tabs update one row, the last write wins. `utils.transact` reads and writes in one docstore [`modifyMany`](../docstore/README.md#updates), so no other tab writes in between.

```ts
// merge may run more than once, so keep it pure
await todos.utils.transact(["1", "2", "9"], ([t1]) => [
	t1 && { ...t1, done: !t1.done },
	null,      // deletes 2
	undefined, // leaves 9
]);
todos.get("1"); // => { id: "1", title: "Buy milk", done: true }
```

`transact` resolves once the collection shows the write, which an on-demand collection does when a loaded query keeps the document. While another transaction on the collection is persisting, TanStack applies the synced row once that transaction settles.

## Closing

You own `kv` and the store. Closing `kv` stops every collection on it, and later writes throw `ClosedError`.
