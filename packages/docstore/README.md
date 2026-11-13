# @opfs-lsm/docstore

A typed document store on [`@opfs-lsm/kv`](../kv/README.md) that queries through the indexes you declare.

```sh
pnpm add @opfs-lsm/docstore @opfs-lsm/kv
```

```ts
import { openDb } from "@opfs-lsm/kv";
import { defineSchema, openDocStore } from "@opfs-lsm/docstore";

type Todo = {
	id: string;
	title: string;
	done: boolean;
	createdAt: number;
	tags: string[]
};
const schema = defineSchema<{ todos: Todo }>()({
	version: 1,
	collections: { todos: { open: { on: ["done", "createdAt"] } } },
});
const kv = await openDb({ name: "app" });
const todos = (await openDocStore(kv, schema)).collection(
	"todos"
);
await todos.put({
	id: "t1",
	title: "Buy milk",
	done: false,
	createdAt: 1,
	tags: ["home"]
});
await todos.query({ index: "open", eq: [false] });
// => { docs: [{ id: "t1", ... }] }
```

## Schemas

A schema names each collection and its indexes. The rest of this page uses this one.

```ts
type User = { id: string; email?: string };
const schema = defineSchema<{ todos: Todo; users: User }>()({
	version: 1,
	// an integer of at least 1. Bump it on every change to
	// collections
	collections: {
		todos: {
			open: { on: ["done", "createdAt"] },        // sorted
			byTag: { on: "tags", multi: true },         // multi
			search: { on: "createdAt", text: "title" }, // text
		},
		users: { byEmail: { on: "email", unique: true } }, // unique
	},
});
```

You open and close `kv` yourself, and other layers can keep using it.

```ts
const kv = await openDb({ name: "app" });
const store = await openDocStore(kv, schema);
// the first open stores the schema, with every index ready
const todos = store.collection("todos");
const users = store.collection("users");
await store.whenIdle();
// this handle's background backfills and sweeps are done
// docstore owns the kv keys that start with byte 0x64
```

## Documents

A document is a JSON object with a string `id`. Declare its type with `type`, because an `interface` does not satisfy `JsonDoc`.

```ts
interface Card { id: string }
defineSchema<{ cards: Card }>(); // type error
defineSchema<{ // type error, and so are Map, Uint8Array,
	// and classes
	events: { id: string; at: Date }
}>();
defineSchema<{ events: { id: string; at: number } }>(); // ok
```

The store keeps `JSON.stringify(doc)` and returns its `JSON.parse`. Indexes read that stored form too.

```ts
const todo: Todo = {
	id: "t1",
	title: "Buy milk",
	done: false,
	createdAt: -0,
	tags: ["home"]
};
await todos.put(todo); // upsert
await todos.get("t1");
// => { id: "t1", title: "Buy milk", done: false, createdAt: 0,
//    tags: ["home"] }
await todos.get("t9"); // => undefined
await todos.getMany(["t9", "t1"]);
// => [undefined, { id: "t1", ... }]
// undefined fields drop, -0 becomes 0, and NaN becomes null
// getMany reads each document on its own, not from one snapshot
```

`putMany` writes in one kv transaction, so every document lands or none does.

```ts
await todos.putMany([todo, { ...todo, id: "t2" }]);
await todos.put(todo); // same stored bytes, so nothing is written
await todos.put({ ...todo, id: "" });
// throws DocStoreError "document", see Limits
```

## Updates

`modify` reads, runs `fn`, and writes with no other write from any tab in between. `fn` may run more than once, so keep it pure.

```ts
await todos.modify("t1", (t) => ({ ...t, done: true }));
// => { id: "t1", ..., done: true }
await todos.modify("t9", (t) => t);
// => undefined, and fn never runs
await todos.modify("t1", (t) => ({ ...t, id: "t2" }));
// throws DocStoreError "document"
```

`modifyMany` does the same for several ids in one kv transaction. `fn` returns one entry per id.

```ts
await todos.modifyMany(["t1", "t2", "t3"], ([t1]) => [
	t1 && { ...t1, done: false },
	// a document is stored under its slot's id
	null,      // null deletes t2
	undefined, // undefined leaves t3, which still counts as read
]);
await todos.modifyMany(["t1", "t1"], (ts) => ts);
// throws DocStoreError "document", repeated id
await todos.modifyMany(["t1"], () => []);
// throws DocStoreError "document", wrong length
```

Unique indexes are checked across the whole call, so two users can swap emails.

```ts
await users.modifyMany(["u1", "u2"], ([u1, u2]) => [
	u2 && { ...u2, id: "u1" }, // u1 takes u2's email
	u1 && { ...u1, id: "u2" }, // u2 takes u1's email
]);
```

## Deletes

```ts
await todos.putMany([
	todo,
	{ ...todo, id: "t2" },
	{ ...todo, id: "t3" }
]);
await todos.delete("t1"); // => true
await todos.delete("t1"); // => false
await todos.deleteMany(["t2", "t3", "t3", "t9"]);
// => 2, the distinct ids that existed
await todos.clear();      // one catalog write, at any size
```

`clear` gives the collection a new id, so every reader and writer stops seeing the old documents at once. A background sweep deletes the old keys.

## Indexes

`on` takes a dot path such as `"meta.due"`, up to four segments, or a tuple of paths. The examples start from these todos.

```ts
await todos.putMany([
	{
		id: "a",
		title: "Buy milk",
		done: false,
		createdAt: 3,
		tags: ["home", "shop"]
	},
	{
		id: "b",
		title: "Fix window",
		done: true,
		createdAt: 1,
		tags: []
	},
	{
		id: "c",
		title: "Call mom",
		done: false,
		createdAt: 2,
		tags: ["home", "home"]
	},
]);
```

### Sorted

```ts
// one entry per document, ordered by the values at on, then by id
await todos.queryIds({ index: "open" });
// => { ids: ["c", "a", "b"] }
todos.indexes.get("open");
// => { kind: "sorted", on: ["done", "createdAt"], unique: false }
```

### Multi

```ts
// one entry per distinct element, so a document can match more
// than once
await todos.queryIds({ index: "byTag" });
// => { ids: ["a", "c", "a"] }
await todos.queryIds({ index: "byTag", eq: ["home"] });
// => { ids: ["a", "c"] }
// an empty array gives no entry, and a scalar gives one
// with on: ["tags", "createdAt"], each entry is one tag, then
// createdAt
```

### Text

```ts
// ordered by createdAt, carrying the lowercased words of title
// a word ends at every character that is not a letter or a digit
await todos.queryIds({ index: "search", match: "ow" });
// => { ids: ["b"] }, "ow" is inside "window"
await todos.queryIds({ index: "search", match: "MOM ca" });
// => { ids: ["c"] }, every word must match
await todos.queryIds({ index: "search", gte: 2, match: "m" });
// => { ids: ["c", "a"] }
await todos.queryIds({ index: "search", match: " - " });
// throws DocStoreError "query", no words
await todos.queryIds({ // type error, open is not a text index
	index: "open",
	match: "milk"
});
```

### Unique

```ts
await users.put({ id: "u1", email: "ada@example.com" });
await users.put({ id: "u2", email: "ada@example.com" });
// throws DocStoreError "unique"
await users.putMany([{ id: "u3" }, { id: "u4" }]);
// no value at on, so no entry and no conflict
await users.put({ id: "u5", email: "\uD800" });
// throws DocStoreError "document"
// an indexed value is null, a boolean, a number, or a string with
// no lone surrogate
// sorted and multi indexes can be unique, text indexes cannot
```

## Queries

A query names an index and a range in it. Without `index`, it reads the documents in id order.

### Bounds

`eq` fixes the first components of `on`. `gt`, `gte`, `lt`, and `lte` bound the next one.

```ts
await todos.queryIds({ index: "open", eq: [false], gt: 2 });
// => { ids: ["a"] }
await todos.queryIds({ index: "open", gte: false, lt: true });
// => { ids: ["c", "a"] }
await todos.queryIds({ lt: "b" });
// => { ids: ["a"] }, in id order
await todos.queryIds({ index: "open", gt: 2 }); // type error,
// done comes first
await todos.queryIds({ index: "open", gt: false, gte: false });
// throws DocStoreError "query"
```

### Prefixes

```ts
await users.queryIds({ index: "byEmail", startsWith: "ada@" });
// => { ids: ["u1"] }
await todos.queryIds({ startsWith: "a" }); // => { ids: ["a"] }
await users.queryIds({
	index: "byEmail",
	startsWith: "a",
	lt: "b"
});
// throws DocStoreError "query"
```

### Pages

`next` is exclusive, and each page reads one kv snapshot. An `after` made before a `clear`, or before the index was redefined, throws `"cursor"`.

```ts
const first = await todos.queryIds({ index: "open", limit: 2 });
// => { ids: ["c", "a"], next }
const rest = await todos.queryIds({
	index: "open",
	after: first.next
});
// => { ids: ["b"] }
rest.next; // => undefined, nothing follows
await todos.queryIds({
	index: "open",
	eq: [true],
	after: first.next
});
// throws DocStoreError "cursor"
await todos.queryIds({ index: "open", limit: 0 });
// throws DocStoreError "query"
```

### Reverse

```ts
const back = await todos.queryIds({
	index: "open",
	reverse: true,
	limit: 1
});
// => { ids: ["b"], next }
await todos.queryIds({
	index: "open",
	reverse: true,
	after: back.next
});
// => { ids: ["a", "c"] }
await todos.query({ index: "open", reverse: true });
// => { docs: [{ id: "b", ... }, ...] }
```

### Counts

```ts
await todos.count({ index: "open", eq: [false] }); // => 2
await todos.count({ index: "byTag" });
// => 3, entries, not documents
await todos.count({ index: "open", limit: 1 });
// => 1, count stops at limit
```

### Order

```ts
// null < false < true < numbers < strings, and -0 equals 0
// strings order by UTF-8 bytes, so "a" < "a\u0000b" < "aa"
await users.putMany([
	{ id: "x1", email: "a" },
	{ id: "x2", email: "a\u0000b" },
	{ id: "x3", email: "aa" }
]);
await users.queryIds({ index: "byEmail", lte: "a" });
// => { ids: ["x1"] }
await users.queryIds({ index: "byEmail", gt: "a", lt: "ab" });
// => { ids: ["x2", "x3"] }
```

## Snapshots

`view` runs its body once against one state of the database, whatever any tab writes meanwhile.

```ts
const { page, total } = await todos.view(async (snap) => ({
	page: await snap.queryIds({ index: "open", limit: 2 }),
	total: await snap.count({ index: "open" }),
	// the same state as page
}));
// snap has seq, get, getMany, query, queryIds, and count
// changes events with a seq at or below snap.seq are in the
// snapshot, later ones are not
// todos.query, todos.queryIds, and todos.count each run a view
// with one read
```

A snapshot reads only. It does not see a write, a `clear`, or a schema change made after it began.

```ts
await todos.view(async (snap) => {
	await todos.delete("a");
	return snap.get("a"); // => { id: "a", ... }
});
```

## Changes

`changes` reports every change to the collection's documents in kv seq order, from this handle, other handles, and other tabs.

```ts
const stop = todos.changes((event) => {
	// changes has one entry per document
	if (event.kind === "append") console.log(event.changes);
	// what you hold may be stale
	if (event.kind === "gap") console.log("read again");
	// the last event
	if (event.kind === "closed") console.log("kv closed");
});
await todos.put(todo); // the listener sees it before put resolves
stop();
```

```ts
await todos.put({ ...todo, done: true });
// changes => [{ id: "t1", deleted: false, doc: { id: "t1", ...,
//            done: true } }]
await todos.delete("t1");
// changes => [{ id: "t1", deleted: true }], with no doc
// doc is parsed when you first read it, so reading only id and
// deleted costs no JSON.parse
```

**Note.** A gap means kv skipped records a flush folded, or the collection was cleared or dropped. Index entries and catalog writes send no event, and a listener that throws is logged and skipped.

To follow the collection with no hole and no repeat, subscribe first, read a snapshot, then apply only events above `snap.seq`. Hold the events that arrive while a snapshot loads, and read again on a gap.

```ts
const rows = new Map<string, Todo>();
let seen = 0;
let held: CollectionChange<Todo>[] | undefined;
```

```ts
const apply = (event: CollectionChange<Todo>) => {
	if (held) held.push(event);
	else if (event.kind === "gap") void load();
	else if (event.kind === "append" && event.seq > seen) {
		for (const c of event.changes) {
			if (c.deleted) rows.delete(c.id);
			else rows.set(c.id, c.doc!);
		}
	}
};
```

```ts
async function load() {
	held = [];
	await todos.view(async (snap) => {
		rows.clear();
		for (const t of (await snap.query({})).docs)
			rows.set(t.id, t);
		seen = snap.seq;
	});
	const replay = held;
	held = undefined;
	replay.forEach(apply);
}
```

```ts
// subscribe before the first read, so no event falls between them
todos.changes(apply);
await load();
```

## Schema versions

Open compares the declared `version` with the stored one, in one kv transaction. A higher version stores the new schema, builds new indexes, and sweeps the keys of removed ones.

```ts
const v2 = defineSchema<{ todos: Todo; users: User }>()({
	version: 2,
	collections: {
		todos: {
			...schema.collections.todos,
			byCreated: { on: "createdAt" }
		},
		users: schema.collections.users,
	},
});
await openDocStore(kv, v2);
// resolves once byCreated is ready or failed
await todos.put(todo);
// a v1 handle keeps byCreated up to date too
// a backfill cut short by a closed tab resumes on the next open
```

To delete a collection and its documents, name it in `drop`. A collection you only leave out keeps its documents for a later schema.

```ts
const v3 = defineSchema<{ todos: Todo }>()({
	version: 3,
	collections: { todos: v2.collections.todos },
	drop: ["users"],
	// a name not stored is ignored. Declared again later, it starts
	// empty
});
await openDocStore(kv, v3);
await users.get("u1");
// throws DocStoreError "schema" on a v1 or v2 handle
// a name cannot be both declared and dropped
```

```ts
await openDocStore(kv, schema);
// a lower version uses the stored catalog unchanged
await openDocStore(kv, { ...v3, collections: { todos: {} } });
// throws DocStoreError "schema"
// the same version must declare the stored indexes, and drop
// nothing still stored
```

A backfill that meets a unique conflict, or a value an index cannot hold, marks the index failed.

```ts
await todos.putMany([
	{ ...todo, id: "d1" },
	{ ...todo, id: "d2" }
]);
// same title
const v4 = defineSchema<{ todos: Todo }>()({
	version: 4,
	collections: {
		todos: {
			...v3.collections.todos,
			byTitle: { on: "title", unique: true }
		}
	},
});
const todos4 = (await openDocStore(kv, v4)).collection("todos");
await todos4.query({ index: "byTitle" });
// throws DocStoreError "index-failed"
// err.ids names the documents. Fix them, then bump the version to
// rebuild
```

**Note.** `todos.indexes` follows this handle's schema. A query on an index that a newer schema redefined throws `"schema"`.

## Storage quota

Documents and index entries count against the origin's storage quota. Open kv with `maxBytes: "quota"` and answer its offers, as kv's [Storage quota](../kv/README.md#storage-quota) explains.

```ts
const kv = await openDb({ name: "app", maxBytes: "quota" });
const users = (await openDocStore(kv, schema)).collection(
	"users"
);
// a cache your app can fetch again

kv.onPressure(async () => {
	// an offer can come back before the space is free, so skip an
	// empty collection
	// clearing an empty collection still sends every changes
	// listener a gap
	if ((await users.queryIds({ limit: 1 })).ids.length > 0)
		await users.clear();
});
```

**Note.** `clear` frees space with one kv range delete once compaction rewrites the files. `delete` and `deleteMany` remove one key at a time, and kv frees those bytes late.

## Errors

Every error this package throws on purpose is a `DocStoreError` with a `code`. kv's errors, such as `ConstraintError`, `ClosedError`, `CommitError`, and `CorruptDatabaseError`, pass through unchanged.

```ts
try {
	await users.put({ id: "u2", email: "ada@example.com" });
} catch (err) {
	if (err instanceof DocStoreError && err.code === "unique")
		err.ids; // => ["u2", "u1"], incoming then owner
}
```

| Error | When | What to do |
|---|---|---|
| `"schema"` | The stored catalog and this schema disagree. | Open with the newer schema, or bump `version`. |
| `"unique"` | Two documents would share a unique value. | Change or delete one of `ids`. |
| `"index-failed"` | A query reads an index whose backfill failed. | Fix the documents in `ids`, then bump `version`. |
| `"query"` | A query is malformed. | Fix the query. |
| `"cursor"` | `after` belongs to another range, or predates a `clear` or a redefinition. | Query again without `after`. |
| `"document"` | A bad or repeated id, a changed id, or a value an index cannot hold. | Fix the document. Nothing was stored. |
| `ConstraintError` | A write passes kv's batch limit. | Split the write. |
| `ClosedError` | The kv handle closed, also from `changes`. | Open kv again. |

## Limits

```ts
await todos.put({ ...todo, id: "x".repeat(1025) });
// throws DocStoreError "document", over 1,024 UTF-8 bytes
await todos.put({ ...todo, id: "\uD800" });
// throws DocStoreError "document", a lone surrogate
await users.put({ id: "u6", email: "x".repeat(9000) });
// throws DocStoreError "document", over 8 KiB of index key
const tags = Array.from({ length: 1001 }, (_, i) => `t${i}`);
await todos.put({ ...todo, tags });
// throws DocStoreError "document", over 1,000 elements per multi
// index
// a write call is one kv batch of at most 8 MiB, counting keys,
// values, and 256 bytes per op
// kv has no separate cap on the number of ops
const big = Array.from({ length: 9000 }, (_, i) => ({
	...todo,
	id: `big${i}`,
	title: "x".repeat(1000)
}));
await todos.putMany(big); // throws ConstraintError
```
