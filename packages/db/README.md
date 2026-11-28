# @opfs-lsm/db

A database for web apps, stored in OPFS through [`@opfs-lsm/docstore`](../docstore/README.md). You declare collections and their indexes, write documents, and run live queries written in TanStack DB's query syntax. A query reads through the index you declared that fits it best, or the whole collection when none does. The library keeps no index of its own, and no copy of your rows beyond the last result each subscriber holds.

```sh
pnpm add @opfs-lsm/db
```

```ts
import { collection, eq, openDatabase, query } from "@opfs-lsm/db";

type Todo = { id: string; title: string; done: boolean; created: number };

const db = await openDatabase({
	name: "app",
	version: 1,
	collections: {
		todos: collection<Todo>().index("byDone", ["done", "created"]),
	},
});
const { todos } = db.collections;

const open = query((q) =>
	q
		.from({ t: todos })
		.where(({ t }) => eq(t.done, false))
		.orderBy(({ t }) => t.created),
);
open.subscribe((rows) => console.log(rows));
await todos.insert({ id: "t1", title: "Buy milk", done: false, created: 1 });
// logs the open todos after the first read, and again each time
// they change
```

## Open

```ts
import { collection, openDatabase } from "@opfs-lsm/db";
import * as v from "valibot";

const Issue = v.strictObject({
	id: v.string(),
	title: v.pipe(v.string(), v.minLength(1)),
	status: v.picklist([0, 1, 2, 3, 4]),
	priority: v.picklist([0, 1, 2, 3, 4]),
	created: v.number(),
	modified: v.number(),
});
type Detail = { id: string; body: string };

const db = await openDatabase({
	name: "linearlite",
	// an integer of at least 1. Raise it whenever collections or
	// their indexes change
	version: 3,
	collections: {
		issues: collection(Issue)
			.text("byModified", "modified", "title")
			.index("byCreated", "created")
			.index("byStatus", ["status", "priority", "modified"])
			.index("byPriority", ["priority", "status", "modified"]),
		details: collection<Detail>(),
	},
});

const { issues, details } = db.collections;
await db.close();
```

One call opens the storage and the collections. There is no default database: a collection handle belongs to the database that opened it. Every tab of the origin that opens the same `name` shares the data.

`collection(validator)` takes any [Standard Schema](https://standardschema.dev) (valibot, zod, arktype and others). `collection<T>()` takes a type and validates nothing beyond the [indexed fields](#write). Declare a document type with `type`, because an `interface` does not satisfy the document constraint.

Each index method takes the index name, then `by`: a field, a dot path such as `"meta.due"`, or a list of them.

- `index` declares a sorted index, ordered by the values at `by`, then by `id`.
- `unique` declares a sorted index in which no two documents share the values at `by`.
- `text` declares a sorted index that also holds the words of a string field, its third argument. `like` and `ilike` on that field search those words.

## Write

```ts
const now = Date.now();
const issue = (id: string) => ({
	id,
	title: "Fix login",
	status: 1 as const,
	priority: 0 as const,
	created: now,
	modified: now,
});

await issues.insert(issue("i1"));
await issues.insert([issue("i2"), issue("i3")]);
// one transaction. ConflictError "duplicate" if an id exists,
// and then nothing is stored
await issues.upsert([issue("i2"), issue("i4")]);
// one transaction. Replaces what exists
const next = await issues.update("i1", (draft) => {
	draft.status = 3;
	draft.modified = Date.now();
});
// => the stored document. NotFoundError if there is no "i1"
await issues.delete("i1"); // a missing id is not an error
await issues.delete(["i2", "i3"]);
await issues.get("i4"); // => the document, or undefined
```

Every write is validated before anything is stored. The validator must be synchronous.

A write must also give a value to every field that a sorted, unique or text index names. `null` counts as a value. A missing field throws `ValidationError` with code `indexed-field`. So every index holds every document, and any index can answer a query.

```ts
type Task = { id: string; title: string; due: number | null };
// with tasks, a collection declared as
// collection<Task>().index("byDue", "due")
await tasks.insert({ id: "t1", title: "Later", due: null }); // ok
await tasks.insert({ id: "t2", title: "No due" } as Task);
// throws ValidationError "indexed-field"
```

**Note.** The rule covers writes made under the current declaration. A document stored under an older `version`, before an index on a field it lacks was added, has no entry in that index. A query that reads the index does not see the document. Write the field, with `null` if it has no value, before or when you raise `version`.

**Note.** In a unique index `null` is a value like any other, so only one document can hold it.

`update` runs `fn` inside one read-modify-write transaction. `fn` gets a fresh copy of the stored document and changes it in place. It may run more than once, for example when another tab writes the same document meanwhile or when it changes nothing, so keep it pure. The changed draft goes through the validator, so a validator that transforms its input must accept the stored form too.

## Query

```ts
import { and, eq, ilike, inArray, not, query } from "@opfs-lsm/db";

const open = query((q) =>
	q
		.from({ i: issues })
		.where(({ i }) => and(inArray(i.status, [1, 2]), not(eq(i.priority, 4))))
		.orderBy(({ i }) => i.modified, "desc")
		.limit(50),
);

const rows = await open.run(); // one read
const stop = open.subscribe(
	(rows) => render(rows),
	// a DbError. The subscription has ended
	(error) => showError(error),
);
stop();
```

`query` builds a query bound to the database of the collection it reads. Building reads nothing.

- `from({ alias: collection })` names the collection and the alias its fields go by. A query reads one collection.
- `where` takes `eq`, `gt`, `gte`, `lt`, `lte`, `inArray`, `like`, `ilike`, `and`, `or`, `not`, or a boolean field alone, as in `({ i }) => i.done`. Several `where` calls must all hold.
- `orderBy` takes a field and `"asc"` or `"desc"`. Chain it for more fields. Without `orderBy`, rows come in `id` order.
- `offset` and `limit` take a count.
- `select(({ i }) => ({ id: i.id, title: i.title }))` gives each row those fields only.
- `findOne()` yields one row or `undefined`. `count()` yields a number.

The operators are typed from the document, so `eq(i.status, "x")` on a number field does not compile.

A builder is immutable, so a page and its total can share a base.

```ts
import type { QueryRoot } from "@opfs-lsm/db";

const filtered = (q: QueryRoot, status: (0 | 1 | 2 | 3 | 4)[]) =>
	q.from({ i: issues }).where(({ i }) => inArray(i.status, status));

const page = query((q) =>
	filtered(q, [1, 2])
		.orderBy(({ i }) => i.status)
		.orderBy(({ i }) => i.priority)
		.orderBy(({ i }) => i.modified)
		.offset(50)
		.limit(50),
);
const total = query((q) => filtered(q, [1, 2]).count());
```

### Comparison and order

There is one order for everything, the one the indexes keep: `null`, then `false`, `true`, numbers, and strings by code point. Rows that tie come in `id` order. `"desc"` reverses all of it, so nulls come first ascending and last descending. There is no locale collation.

- A missing field reads as `null`.
- `eq(i.assignee, null)` is true for a missing or null assignee.
- `gt`, `gte`, `lt` and `lte` compare two values of one type. `lt(i.due, 5)` is false for a `null` due date and for a string.
- `like` matches `%` as any run of characters and `_` as one character, on the whole string. `ilike` does the same in lower case. Both compare text in Unicode NFC, so a pattern typed with `é` matches a text stored as `e` and a combining accent.
- A `\` makes the `%`, `_` or `\` after it literal: `like(i.title, "100\\%")` in JavaScript source matches the title `100%`. Escape text a user types before it goes into a pattern, as in `q.replace(/[\\%_]/g, "\\$&")`.

### Plans

```ts
open.explain();
// => { kind: "index", index: "byModified", ranges: 1,
//      ordered: true, exact: false }
```

`byModified` yields rows in the query's order, so the read stops after 50 rows that pass the filter. `byStatus` would read only the two statuses, and would then have to read and sort every match.

- `ordered` means rows come off the index in the query's order, so a `limit` stops the read early.
- `exact` means the index alone decides which rows match. `offset`, `limit` and `count()` are then answered from the index entries, and no document is read for them.
- `{ kind: "scan" }` is a read of the whole collection in `id` order. It works, slower.
- `{ kind: "ids" }` is a read by id, for a `where` that names ids.
- `{ kind: "none" }` reads nothing: no document can pass the `where`.

With a `limit`, an index that yields the order is chosen first. Without one, and for a count, the index that reads the fewest other rows is chosen first. A count that an index answers alone counts that index's entries. So a count with no `where` reads no row: it counts the entries of the sorted index with the fewest fields, among those that are not unique.

An index serves an order when the `orderBy` fields are the index's fields after the ones the `where` pins. A field pinned to one value drops out of the order. A field pinned to several values with `inArray` can lead the order: the query then reads one range per value, one after the other.

| Query | Plan |
|---|---|
| no filter, `orderBy` modified, `offset`, `limit` | `byModified`, ordered, exact |
| `inArray(status, [1, 2])`, `orderBy` status, priority, modified | `byStatus`, 2 ranges, ordered, exact |
| `inArray(status, [1, 2])`, `orderBy` modified, `limit` | `byModified`, ordered, filtered |
| `ilike(title, "%login%")`, `orderBy` modified | `byModified` through its words, ordered, filtered |
| `inArray(status, [1, 2])`, `count()` | `byStatus`, exact: entries counted, no document read |
| no filter, `count()` | `byCreated`, exact: entries counted, no document read |

### Live results

`subscribe(next, error)` calls `next` with the result after the first read, then each time the result changes. It never calls it synchronously, and never twice in a row with an equal result. It returns a function that stops every call.

A row whose content did not change is the same object as in the previous result. A keyed list, such as Solid's `createProjection` or a React list with `key`, then redraws only the rows that changed. Rows are shared by every subscriber of the query and by later results: read them, and write changes to the collection, never to a row.

A write reads again only the queries it may affect, except two kinds that it patches from the change itself, with no read:

- A count with no `offset` or `limit` whose plan is exact on an index declared with `index` (the `count()` rows of the table above). The count moves by the index entries the write added and removed in its ranges.
- A list with no `limit` or `offset` whose plan reads no `text` index. Each write puts its document where the order says, takes it out, or leaves it. A `select` must include every field of the order, since the rows are placed by their own fields.

The other queries read again: a window with `limit` or `offset`, `findOne`, a plan on a `text` index, a count with a filter its ranges do not cover, a `select` that drops a field of the order. Those that need a read read together, from one snapshot, once per microtask batch, and a collection's subscriptions wait for one read at a time. Writes that arrive during a read become one more read. Each result is handed over as soon as it is read, and the rows before the counts, so a page never waits for its count. Both come from the same snapshot: for a moment the count may lag the page, and it never shows another state of the collection.

Writes from other tabs update queries the same way.

`error` gets the `DbError` that ended the subscription. `db.close()` ends every subscription with `ClosedError` code `closed`, and a [deleted](#delete) database ends them with code `destroyed`. Nothing is called after `error`.

## Delete

```ts
import { deleteDatabase } from "@opfs-lsm/db";

await deleteDatabase("linearlite");
```

`deleteDatabase(name)` deletes every document and index stored under `name`. Every open handle on it, in any tab, ends its subscriptions with `ClosedError` code `destroyed`, and its later calls reject with `ClosedError`. It resolves once the storage is gone, so the next `openDatabase` of that name starts empty.

## Solid

```tsx
import { eq, query } from "@opfs-lsm/db";
import { useLiveQuery } from "@opfs-lsm/db/solid";
import { createSignal, Errored, For, isPending, Loading } from "solid-js";

const withStatus = (status: number) =>
	query((q) =>
		q
			.from({ i: issues })
			.where(({ i }) => eq(i.status, status))
			.orderBy(({ i }) => i.modified, "desc")
			.limit(50),
	);
const countWithStatus = (status: number) =>
	query((q) =>
		q
			.from({ i: issues })
			.where(({ i }) => eq(i.status, status))
			.count(),
	);

function IssueList() {
	const [status, setStatus] = createSignal(1);
	const rows = useLiveQuery(() => withStatus(status()));
	const total = useLiveQuery(() => countWithStatus(status()));

	return (
		<Errored fallback={(error) => <p>{String(error())}</p>}>
			<Loading fallback={<p>Reading</p>}>
				<button onClick={() => setStatus(2)}>In progress</button>
				<p class={{ stale: isPending(total) }}>{total()} issues</p>
				<ul>
					<For each={rows()}>{(issue) => <li>{issue.title}</li>}</For>
				</ul>
			</Loading>
		</Errored>
	);
}
```

`@opfs-lsm/db/solid` is the adapter for Solid 2. It needs `solid-js` 2.0.3 or later, which the core entry does not import.

`useLiveQuery(() => query)` subscribes to the query and returns an accessor of its result: the rows, one row, or a number.

- The function may read signals and props. When one changes, the subscription moves to the new query. The accessor keeps the last result until the new one is read, and `isPending(rows)` is true meanwhile.
- Until the first read the accessor is not ready, as an async memo is. Read it under `<Loading>`.
- The result is a store whose rows are matched by `id`. A change to one document updates only what reads the fields that changed, so an edited title redraws one text node and a row that moved keeps its elements. A `select` without `id` gives rows that are replaced when they change.
- The error that ends a subscription is thrown where the accessor is read, for `<Errored>` or an effect's `error` to catch.
- The subscription stops when the component that called `useLiveQuery` is disposed.

## Tests

```ts
import "fake-indexeddb/auto";
import { openMemoryDatabase } from "@opfs-lsm/db/testing";

const here = await openMemoryDatabase({ name: "test", version: 1, collections });
const there = await openMemoryDatabase({ name: "test", version: 1, collections });
```

`openMemoryDatabase` takes what `openDatabase` takes and stores the data in memory, so a test of an app's queries and writes runs in Node. Two opens of one name share the data, as two tabs of one origin do. The process needs an `indexedDB`, such as the one of [`fake-indexeddb`](https://github.com/dumbmatter/fakeIndexedDB).

## Errors

Every rejection and every `subscribe` error is a `DbError` with a fixed `_tag` and a `code`. An error that your own `update` callback or validator throws passes through as it is. So does the `TypeError` of a document that JSON cannot hold, such as one with a cycle or a `BigInt`, and nothing is stored.

```ts
import { NotFoundError, ValidationError } from "@opfs-lsm/db";

try {
	await issues.update("i9", (draft) => {
		draft.title = "";
	});
} catch (err) {
	if (err instanceof ValidationError) err.issues; // the validator's issues
	if (err instanceof NotFoundError) err.id; // => "i9"
}
```

| `_tag` | `code` | When |
|---|---|---|
| `ValidationError` | `invalid`, `async`, `id`, `indexed-field` | A write was refused before storing. `invalid`: the validator's `issues` say why. `async`: the validator returned a Promise. `id`: no usable string id, one id twice in a call, or `update` changed it. `indexed-field`: an indexed field is missing or holds a value the index cannot. |
| `ConflictError` | `duplicate`, `unique` | `insert` met an existing id, or a unique index already holds the value. `ids` names the documents. |
| `NotFoundError` | `missing` | `update` found no document. |
| `QueryError` | `operand`, `source` | A query that cannot run: an `orderBy` that is not a field, a `limit` or an `offset` that is not a count, a `from` that is not a collection of an open database. A mistake the builder can see is thrown by `query` itself. |
| `SchemaError` | `version`, `catalog` | `openDatabase`. `version`: this version is stored with other collections or indexes, so raise it. `catalog`: any other disagreement with the stored schema. |
| `ClosedError` | `closed`, `destroyed` | The database was closed, or deleted. |
| `StorageError` | `commit`, `quota`, `unavailable`, `corrupt`, `limit`, `index-failed` | The storage failed. `cause` is the storage's own error. |

`AnyDbError` is the union of the seven classes, so a `switch` on `_tag` narrows to one of them. The `_tag` is also what Effect's `catchTag` matches, so a wrapper needs no mapping of its own.

```ts
import { Effect } from "effect";
import type { AnyDbError } from "@opfs-lsm/db";

const rename = (id: string, title: string) =>
	Effect.tryPromise({
		try: () =>
			issues.update(id, (draft) => {
				draft.title = title;
			}),
		catch: (err) => err as AnyDbError,
	}).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)));
```
