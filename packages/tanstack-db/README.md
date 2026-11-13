# @opfs-lsm/tanstack-db

A TanStack DB collection stored in an [`@opfs-lsm/docstore`](../docstore/README.md) collection. Writes from every tab arrive live.

```sh
pnpm add @opfs-lsm/tanstack-db @opfs-lsm/docstore @opfs-lsm/kv \
  @tanstack/db
```

```ts
import { defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { openDb } from "@opfs-lsm/kv";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection } from "@tanstack/db";

type Todo = { id: string; title: string; done: boolean };
const schema = defineSchema<{ todos: Todo }>()({
	version: 1,
	collections: { todos: {} },
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

## Collection ids

The default id is `opfs-lsm:` plus the collection name. Pass your own `id` when another database has a collection with the same name.

```ts
todos.id; // => "opfs-lsm:todos"
const workKv = await openDb({ name: "work" });
const workStore = await openDocStore(workKv, schema);
const workOptions = docstoreCollectionOptions({
	collection: workStore.collection("todos"),
	id: "work:todos",
});
const work = createCollection(workOptions);
```

## Writes

The adapter stores every insert, update, and delete, so the options take no `onInsert`, `onUpdate`, or `onDelete`.

```ts
const tx = todos.insert([
	{ id: "2", title: "Eggs", done: false },
	{ id: "3", title: "Bread", done: false },
]);
await tx.when("settled"); // one kv transaction
```

## Whole rows

An update stores the whole row as this tab holds it. When two tabs update one row at once, the last write wins. Use [`transact`](#transact) when a change depends on the stored row.

```ts
todos.update("2", (draft) => {
	draft.done = true;
});
// stores { id: "2", title: "Eggs", done: true }
```

## Transact

`utils.transact` runs docstore's [`modifyMany`](../docstore/README.md#updates), so no other tab writes between its read and its write.

```ts
// merge may run more than once, so keep it pure
await todos.utils.transact(["1", "2", "9"], ([t1]) => [
	t1 && { ...t1, done: !t1.done },
	null,      // deletes 2
	undefined, // leaves 9
]);
todos.get("1"); // => { id: "1", title: "Buy milk", done: true }
todos.has("2"); // => false
```

```ts
await todos.utils.transact(["1"], () => []);
// throws DocStoreError "document", wrong length
await todos.utils.transact(["1"], ([t1]) => [
	t1 && { ...t1, id: "5" },
]);
// throws DocStoreError "document", another id
```

## Manual transactions

Call `utils.acceptMutations` once for each collection the transaction touches. Each call is its own kv transaction.

```ts
import { createTransaction } from "@tanstack/db";

const tx = createTransaction({
	mutationFn: async ({ transaction }) => {
		await todos.utils.acceptMutations(transaction);
		await work.utils.acceptMutations(transaction);
	},
});
tx.mutate(() => {
	todos.insert({ id: "4", title: "Jam", done: false });
	work.insert({ id: "w1", title: "Ship it", done: false });
});
await tx.when("settled");
```

## On-demand sync

`syncMode` defaults to `"eager"`, which loads every document. `"on-demand"` loads only the rows live queries ask for.

```ts
type Issue = {
	id: string;
	deleted: boolean;
	status: number;
	modified: number;
};
const tracker = defineSchema<{ issues: Issue }>()({
	version: 1,
	collections: {
		issues: {
			byStatus: { on: ["deleted", "status", "modified"] },
		},
	},
});
```

```ts
const trackerKv = await openDb({ name: "tracker" });
const trackerStore = await openDocStore(trackerKv, tracker);
const issuesOptions = docstoreCollectionOptions({
	collection: trackerStore.collection("issues"),
	syncMode: "on-demand",
});
const issues = createCollection(issuesOptions);
issues.size; // => 0 until a query loads
```

## Index choice

A load reads the index whose leading fields the query pins with `eq` or `inArray`. With no such index, it reads every document. It never reads a multi index.

```ts
import {
	and,
	createLiveQueryCollection,
	eq,
	inArray,
} from "@tanstack/db";

const triage = createLiveQueryCollection((q) =>
	q
		.from({ i: issues })
		.where(({ i }) =>
			and(eq(i.deleted, false), inArray(i.status, [1, 2])),
		),
);
// reads byStatus [false, 1] and [false, 2]
```

```ts
const byStatusOnly = createLiveQueryCollection((q) =>
	q.from({ i: issues }).where(({ i }) => eq(i.status, 1)),
);
// no index starts with status, so this reads every document
```

## Rows a load misses

An on-demand load finds a document through its index entry. A document the index skips is missed.

```ts
type Task = { id: string; due?: number | null; title?: string };
// indexes byDue: { on: "due" } and
// search: { on: "due", text: "title" }
const seen: Task = { id: "t1", due: null, title: "" };
const missed: Task = { id: "t2" };
// t2 has no due and no title, so loads through either miss it
```

**Note.** A search load matches words in NFC, so store text in NFC.

## String order

With TanStack's default string order, `"locale"`, a query ordered by a string reads every matching row. `"lexical"` follows the index order, so the query reads in pages.

```ts
const lexical = docstoreCollectionOptions({
	collection: trackerStore.collection("issues"),
	syncMode: "on-demand",
	defaultStringCollation: { stringSort: "lexical" },
});
```

## Closing

You own `kv`. Closing it stops every collection on it.

```ts
await kv.close();
todos.health.error?.name; // => "ClosedError"
todos.get("1"); // => { id: "1", ... }, the rows stay
const late = todos.insert({ id: "7", title: "Tea", done: false });
await late.when("settled"); // throws ClosedError
todos.has("7"); // => false, the insert rolled back
```
