# @opfs-lsm/tanstack-db

`docstoreCollectionOptions` keeps a TanStack DB collection in an [`@opfs-lsm/docstore`](../docstore) collection. Every tab that opens the same database sees the others' writes live. An on-demand collection loads only what live queries ask for, and reads it through the docstore collection's indexes.

```ts
import { defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { openDb } from "@opfs-lsm/kv";
import { docstoreCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection } from "@tanstack/db";

type Todo = { id: string; title: string; done: boolean };

const schema = defineSchema<{ todos: Todo }>()({ version: 1, collections: { todos: {} } });
const kv = await openDb({ name: "app" });
const docs = await openDocStore(kv, schema);
const todos = createCollection(docstoreCollectionOptions({ collection: docs.collection("todos") }));

todos.insert({ id: "1", title: "milk", done: false });
```

Rows are docstore documents: JSON objects with a string `id`, which is also the TanStack key. The config takes TanStack's collection options except `getKey`, `schema`, `utils` and the mutation handlers. The default `id` is `opfs-lsm:<collection name>`. A `DbClient` keeps one collection per `id`, so pass your own when one page opens the same collection name in two databases.

The caller owns the kv db and the `DocStore`, and many collections share them. Closing the db stops every collection on it: their rows stay, `collection.health.error` holds the cause, and later writes reject and roll back.

## Writes

The adapter persists every insert, update and delete, so the config takes no `onInsert`, `onUpdate` or `onDelete`. A collection's mutations in one TanStack transaction are one kv transaction: `putMany` when they only insert and update, `deleteMany` when they only delete, `modifyMany` when they mix. Other tabs receive them as one change. An update stores the whole row as this tab holds it.

For a manual transaction, call `utils.acceptMutations` from each collection it touches:

```ts
import { createTransaction } from "@tanstack/db";

const tx = createTransaction({ mutationFn: ({ transaction }) => todos.utils.acceptMutations(transaction) });
tx.mutate(() => {
	todos.insert({ id: "2", title: "eggs", done: false });
	todos.update("1", (draft) => {
		draft.done = true;
	});
});
await tx.when("settled");
```

To change documents against what is stored, with nothing landing in between from this tab or another, use `utils.transact(ids, merge)`. It is docstore's `modifyMany`. `merge` gets the stored documents in the order of `ids`, `undefined` for a missing one, and returns one entry per id: a document to put, `null` to delete, or `undefined` to leave it. `merge` may run more than once, the first time on what this tab last saw, so it must be pure and accept any input. The promise resolves once the collection shows the write. An eager collection always shows it. An on-demand collection shows it when a loaded query keeps the document; other writes persist but stay out of memory. A `merge` that throws writes nothing. One that returns the wrong number of entries, or a document under another id, rejects with DocStoreError `"document"` and writes nothing.

```ts
await todos.utils.transact(["1"], ([todo]) => [todo ? { ...todo, done: !todo.done } : undefined]);
```

## Eager

`syncMode: "eager"`, the default, reads every document on start from one docstore `view`. After that, the collection's change feed carries every tab's writes with their values, so the adapter reads nothing to apply them. On a `gap`, after a tab falls behind a flush or the collection is cleared, it reads the collection again.

## On demand

With `syncMode: "on-demand"`, the collection is ready at once and holds only what live queries load. TanStack sends each query's `where`, `orderBy` and `limit`, and the adapter reads the rows in one `view`:

- A `where` that pins `id` with `eq` or `inArray` reads those documents.
- Otherwise it reads the index whose leading fields the `where` pins with `eq` or `inArray`: one range per combination of pinned values, at most 64, narrowed by a `gt`, `gte`, `lt` or `lte` on the next field.
- With `orderBy` and `limit`, it prefers an index that lists the pinned fields, then the order field. It reads each range in order, in pages, until it has `limit` matching rows, and merges the ranges.
- A text index is read only when the `where` holds a `like` or `ilike` on its text field. The pattern's words become its `match`.
- Anything else reads every document.

Every row read is checked against the `where`, so the index changes what a load costs, never what it loads. Multi indexes are not read.

```ts
import { and, createLiveQueryCollection, eq, inArray } from "@tanstack/db";

type Issue = { id: string; deleted: boolean; status: number; modified: number };

const tracker = defineSchema<{ issues: Issue }>()({
	version: 1,
	collections: { issues: { byStatus: { on: ["deleted", "status", "modified"] } } },
});
const store = await openDocStore(await openDb({ name: "tracker" }), tracker);
const issues = createCollection(docstoreCollectionOptions({ collection: store.collection("issues"), syncMode: "on-demand" }));

const open = createLiveQueryCollection((q) =>
	q
		.from({ i: issues })
		.where(({ i }) => and(eq(i.deleted, false), inArray(i.status, [1, 2])))
		.orderBy(({ i }) => i.modified, "desc")
		.limit(50),
);
```

This reads the newest 50 rows of each of the `byStatus` ranges `[false, 1]` and `[false, 2]`, then the rows tied with the 50th.

A row stays in memory while some loaded query keeps it, and follows every tab's writes. A query without a limit keeps every row its `where` matches. An ordered window keeps the matching rows at or before its last row, so a row that moves past it leaves memory, and TanStack asks for more when the window runs short. When the last live query on a subset goes away, the rows no other loaded query keeps leave memory. A `gap` reads every loaded query again.

After an optimistic `update` or `delete` moves a row out of an ordered window, TanStack refills the window from the rows it holds, without asking the adapter. Those can include rows another live query loaded further down the order, so the window can skip a row no query loaded. `utils.transact` writes through the change feed, and TanStack then asks for the rows it needs.

What the index order assumes:

- An index has no entry for a document that lacks one of its fields. A query reads a document through an index only if the document has every field the index names, so store `null` rather than leaving a field out.
- A field the query orders by holds one type, plus `null`. The index orders `null`, then `false` and `true`, then numbers, then strings. TanStack compares mixed types its own way.
- The index orders strings by code point. With `stringSort: "lexical"`, TanStack compares UTF-16 units, which agree except between U+E000 to U+FFFF and characters past U+FFFF. TanStack's default, `"locale"`, orders strings by locale. A locale order is still read in pages while the rows hold numbers or booleans; a window that holds a string reads every matching row instead. Set `defaultStringCollation: { stringSort: "lexical" }` to read string orders in pages.
- Text search finds a pattern's words inside the words of the text after NFC normalization. An `ilike` on text stored in another normal form can match a row the index misses.
