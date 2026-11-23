# @opfs-lsm/docstore

A typed document store on [`@opfs-lsm/kv`](../kv/README.md) that queries through the indexes you declare.

```sh
pnpm add @opfs-lsm/docstore @opfs-lsm/kv
```

```ts
import { openDb } from "@opfs-lsm/kv";
import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";

type Todo = {
	id: string;
	title: string;
	done: boolean;
	createdAt: number;
	tags: string[]
};
const schema = defineSchema({
	version: 1,
	collections: {
		todos: collection<Todo>().index("open", ["done", "createdAt"]),
	},
});
const kv = await openDb({ name: "app" });
const store = await openDocStore(kv, schema);
const todos = store.collection("todos");
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

A schema names each collection, with its document type and its indexes. The rest of this page uses this one.

```ts
type User = { id: string; email?: string };
const schema = defineSchema({
	version: 1,
	// an integer of at least 1. Bump it on every change to
	// collections
	collections: {
		todos: collection<Todo>()
			.index("open", ["done", "createdAt"])  // sorted
			.index("byTag", "tags[]")              // multi
			.text("search", "createdAt", "title")  // text
			.count("perDone", "done"),             // count
		users: collection<User>().unique("byEmail", "email"), // unique
	},
});
```

`collection<T>()` starts a declaration. `index`, `unique`, `text` and `count` each take the index name, then `by`: a field, or a list of fields. `text` takes the string field to search as its third argument, and `index` can take `{ include }` ([Included fields](#included-fields)). Each call returns a new declaration, so you can share a base.

```ts
const base = collection<Todo>().index("open", ["done", "createdAt"]);
const withSearch = base.text("search", "createdAt", "title");
// base is unchanged
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
collection<Card>(); // type error
collection<{ // type error, and so are Map, Uint8Array,
	// and classes
	id: string; at: Date
}>();
collection<{ id: string; at: number }>(); // ok
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
// getMany is one read: every document sees the same writes
```

`putMany` writes in one kv transaction, so every document lands or none does. In a collection with no index, it writes every document, even one whose bytes would not change.

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

## Validators

Give `collection` a [Standard Schema](https://standardschema.dev) validator in place of a type. zod, valibot, arktype and others implement it, and docstore adds no dependency. The document type is the validator's output, and the indexes are checked against it. A schema can mix validated collections and collections declared with a type.

```ts
import * as v from "valibot";

const Task = v.object({
	id: v.string(),
	title: v.pipe(v.string(), v.minLength(1)),
	done: v.optional(v.boolean(), false),
	createdAt: v.number(),
});
const schema = defineSchema({
	version: 1,
	collections: {
		tasks: collection(Task).index("byCreated", "createdAt"),
	},
});
const tasks = (await openDocStore(kv, schema)).collection("tasks");
```

`put`, `putMany`, and every document that `modify` or `modifyMany` returns go through the validator. The store keeps the validator's output, and reads the `id` from it: a validator that rewrites the id stores a `put` under the new one.

```ts
await tasks.put({ id: "t1", title: "Buy milk", createdAt: 1 });
await tasks.get("t1");
// => { id: "t1", title: "Buy milk", done: false, createdAt: 1 }
await tasks.modify("t1", (t) => ({ ...t, done: true }));
await tasks.put({ id: "t2", title: "", createdAt: 2 });
// throws DocStoreError "invalid", and nothing is stored
// its issues are the validator's: [{ message, path }]
```

Writes take the validator's input type, and reads return its output type. A transform makes the two differ. `modify` then turns the stored form back into an input.

```ts
const Visit = v.object({
	id: v.string(),
	at: v.pipe(v.date(), v.transform((d) => d.getTime())),
});
// with visits, a collection declared with Visit
await visits.put({ id: "v1", at: new Date() }); // stores at as a number
await visits.modify("v1", (x) => ({ ...x, at: new Date(x.at) }));
await visits.modify("v1", (x) => ({ ...x }));
// type error: at is a number, and the input takes a Date
```

A validator must be synchronous: one that returns a Promise throws `"invalid"` with no issues. An error it throws itself reaches the caller as it is, and nothing is stored. Reads never validate. The validators are not stored, so a change to one needs no `version` bump. They guard this handle's writes only: another schema, another tab or `kv.ingest` can still write documents they would reject.

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

`by` takes a field, a dot path such as `"meta.due"` up to four segments, or a list of fields. The examples start from these todos.

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
// one entry per document, ordered by its fields' values, then
// by id
await todos.queryIds({ index: "open" });
// => { ids: ["c", "a", "b"] }
todos.indexes.get("open");
// => { kind: "sorted", by: ["done", "createdAt"], unique: false }
```

### Multi

`"tags[]"` reads each element of the array at `tags`. Only the first field of `by` can end in `[]`.

```ts
// one entry per distinct element, so a document can match more
// than once
await todos.queryIds({ index: "byTag" });
// => { ids: ["a", "c", "a"] }
await todos.queryIds({ index: "byTag", eq: ["home"] });
// => { ids: ["a", "c"] }
// an empty array gives no entry, and a scalar gives one
// with by: ["tags[]", "createdAt"], each entry is one tag, then
// createdAt
```

### Included fields

`include` names top-level fields that each entry of a sorted or multi index also holds. `queryEntries` returns them without reading the documents, so a list that shows only those fields costs one range scan, not a scan and a read per row.

```ts
const withList = collection<Todo>().index("list", ["done", "createdAt"], {
	include: ["title", "tags"],
});
// a store whose todos are withList
await todos.queryEntries({ index: "list", eq: [false] });
// => { entries: [
//      { id: "c", values: [false, 2],
//        fields: { title: "Call mom", tags: ["home", "home"] } },
//      { id: "a", values: [false, 3],
//        fields: { title: "Buy milk", tags: ["home", "shop"] } }] }
// fields is typed Pick<Todo, "title" | "tags">. A field the
// document lacks is left out, and the document still has its entry
```

**Note.** Each entry stores a copy of its fields, so the index takes more space, and a write that changes an included field rewrites the document's entries in that index. Include what a list shows, not the whole document. An included field can hold any JSON value. `index` takes up to 16 of them, `unique` and `text` take none. The included fields of one document may take at most 1 MiB in one index, counted once per entry: a larger document is one the index cannot hold.

### Text

```ts
// ordered by createdAt, carrying the lowercased words of title
// a word ends at every character that is not a letter, a combining mark or a digit
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

A document whose text field is `null` has an entry with no words, which a query without `match` reads and a `match` never finds. A document without the field has no entry.

### Unique

```ts
await users.put({ id: "u1", email: "ada@example.com" });
await users.put({ id: "u2", email: "ada@example.com" });
// throws DocStoreError "unique"
await users.putMany([{ id: "u3" }, { id: "u4" }]);
// no email, so no entry and no conflict
await users.put({ id: "u5", email: "\uD800" });
// throws DocStoreError "document"
// an indexed value is null, a boolean, a number, or a string with
// no lone surrogate
// sorted and multi indexes can be unique, text indexes cannot
```

### Count

A count index keeps how many documents hold each value of its fields, in the same kv transaction as the documents. It holds one or two small rows per value and no entries, so only `count` reads it. It suits fields with few values: a status, a flag, a tag.

```ts
await todos.count({ index: "perDone", eq: [false] });
// => 2, read from one or two rows
await todos.count({ index: "perDone" });
// => 3, one or two rows per value of done
await todos.count({ index: "perDone", eq: [[false, true]] });
// => 3, the numbers of the listed values, added
// count("perDone", ["done", "createdAt"]) counts each pair of
// values. eq and one bound pick pairs as they do in a sorted
// index
// count("perTag", "tags[]") counts a document once per distinct
// tag. Its eq takes one tag, not a list: two tags can share a
// document
// a write that moves a document to another value reads and
// writes two numbers. One that moves none does neither
await todos.query({ index: "perDone" });
// type error, and DocStoreError "query": no entries to read
todos.indexes.has("perDone");
// => false, it lists the indexes query reads
```

## Queries

A query names an index and a range in it. Without `index`, it reads the documents in id order.

### Bounds

`eq` fixes the first fields of `by`. `gt`, `gte`, `lt`, and `lte` bound the next one.

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

### Offsets

`offset` passes over results before the first one. It walks the entries it passes and reads none of their documents, so a far page costs less than the pages before it would. To go on from a page, `after` is cheaper: it starts at the cursor.

```ts
await todos.queryIds({ index: "open", offset: 1, limit: 1 });
// => { ids: ["a"], next }
await todos.count({ index: "open", offset: 1 }); // => 2
await todos.queryIds({ index: "open", offset: -1 });
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

### Several values of a field

An index keeps the entries of one value of a field together, in a run of their own. In `open`, the todos that are not done come first in `createdAt` order, and the done ones follow. So "the oldest todos, done or not" are two runs, read and merged by `createdAt`.

A slot of `eq` takes a value, or a list of values that the field can have. The query reads one run per value and merges them. Nothing else changes: a bound applies to the field after `eq`, and the results come in the order of the fields after `eq`, then by id. The order does not follow the listed field: for the results of one value after those of another, run one query per value.

```ts
// the entries of "open", ordered by done, then createdAt
//   [false, 2] c
//   [false, 3] a
//   [true, 1]  b
await todos.queryIds({ index: "open", eq: [[false, true]] });
// => { ids: ["b", "c", "a"] }, by createdAt across both values
await todos.queryEntries({
	index: "open",
	eq: [[false, true]],
	limit: 2
});
// => { entries: [{ id: "b", values: [true, 1] },
//      { id: "c", values: [false, 2] }], next }
// each entry has its own values
```

With more fields, the list sits in the slot of the field it is about. SQL writes the same query with `IN`.

```ts
// issues: .index("byStatus", ["projectId", "status", "updatedAt"])
await issues.query({
	index: "byStatus",
	eq: [projectId, ["todo", "started"]],
	// projectId is this one, status is todo or started
	reverse: true, // newest updatedAt first
	limit: 50
});
// In SQL: WHERE projectId = ? AND status IN ('todo', 'started')
// ORDER BY updatedAt DESC LIMIT 50
```

`limit`, `offset`, `after` and `reverse` work as in any query, and the order the values are listed in does not matter. A cursor must belong to a result of the same query, so it throws `"cursor"` when its own value is not listed.

```ts
const first = await todos.queryIds({
	index: "open",
	eq: [[true, false]],
	limit: 2
});
// => { ids: ["b", "c"], next }
await todos.queryIds({
	index: "open",
	eq: [[true, false]],
	after: first.next
});
// => { ids: ["a"] }
await todos.queryIds({
	index: "open",
	eq: [[true]],
	after: first.next
});
// throws DocStoreError "cursor", c holds false, and only true is listed
await todos.queryIds({
	index: "open",
	eq: [[false, true]],
	reverse: true,
	limit: 1
});
// => { ids: ["a"], next }
```

A bound applies to the field after `eq`, in every run.

```ts
await todos.queryIds({ index: "open", eq: [[false, true]], gt: 1 });
// => { ids: ["c", "a"] }, the bound is on createdAt
```

On a multi index, a document that holds two of the values comes once, and `count` counts documents. `queryEntries` gives its entry of the smaller value, or of the larger one with `reverse`. An index with `include` returns each entry's `fields` here too.

```ts
await todos.queryIds({ index: "byTag", eq: [["home", "shop"]] });
// => { ids: ["a", "c"] }, a holds both
await todos.count({ index: "byTag", eq: [["home", "shop"]] });
// => 2
```

**Note.** That `count` walks the entries to count each document once, where a count of one value reads none. `offset` also walks the entries it passes on any query with a list.

Several slots can hold lists. Each combination of one value per slot is a run, and the runs merge as before.

```ts
await todos.queryIds({
	index: "open",
	eq: [[false, true], [1, 3]]
});
// => { ids: ["a", "b"] }, [false, 3] and [true, 1], by id
```

An empty list matches nothing, and a query takes up to 64 combinations once repeated values are dropped. A unique index and the documents in id order take no lists.

```ts
await todos.queryIds({ index: "open", eq: [[]] });
// => { ids: [] }
await users.queryIds({ index: "byEmail", eq: [["a", "b"]] });
// type error, and DocStoreError "query" when run
// a unique index has one document per value: query each value
await todos.queryIds({ eq: [["a", "b"]] });
// type error, and DocStoreError "query" when run
// to read documents by id, use getMany
```

### Counts

```ts
await todos.count({ index: "open", eq: [false] }); // => 2
await todos.count({ index: "byTag" });
// => 3, entries, not documents
await todos.count({ index: "open", limit: 1 });
// => 1, count stops at limit
```

`count` walks the entries it counts. On a [count index](#count) it adds the numbers of the values in range instead. There it takes `eq`, one bound and `limit`, and not `after`, `offset`, `reverse` or `match`.

### Entries

An entry already holds the values its index orders by. `queryEntries` returns them with each id, typed from `by`, and reads no document. An entry of an index with `include` also has `fields` ([Included fields](#included-fields)); other entries have no `fields` key.

```ts
await todos.queryEntries({ index: "open", eq: [false] });
// => { entries: [{ id: "c", values: [false, 2] },
//      { id: "a", values: [false, 3] }] }
await todos.queryEntries({ lt: "b" });
// => { entries: [{ id: "a", values: ["a"] }] }, a row's one
// value is its id
```

Group on the values without reading documents.

```ts
const perTag = new Map<string, number>();
const { entries } = await todos.queryEntries({ index: "byTag" });
for (const { values: [tag] } of entries)
	perTag.set(tag, (perTag.get(tag) ?? 0) + 1);
// perTag => Map { "home" => 2, "shop" => 1 }
```

To show one page of several ranges in one order, put a list in `eq`: see [Several values of a field](#several-values-of-a-field).

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
// snap has seq, get, getMany, query, queryIds, queryEntries,
// and count
// changes events with a seq at or below snap.seq are in the
// snapshot, later ones are not
// todos.query, todos.queryIds, todos.queryEntries, and
// todos.count each run a view with one read
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
	if (event.kind === "closed") console.log("kv closed:", event.reason); // "close" or "destroyed"
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
// an event's docs are parsed together when you first read one, so
// reading only id and deleted costs no JSON.parse
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
const v2 = defineSchema({
	version: 2,
	collections: {
		todos: schema.collections.todos.index("byCreated", "createdAt"),
		users: schema.collections.users,
	},
});
await openDocStore(kv, v2);
// resolves once byCreated is ready or failed
await todos.put(todo);
// a v1 handle keeps byCreated up to date too
// a backfill cut short by a closed tab resumes on the next open
```

Adding a count index to a stored collection counts its documents from one snapshot, while other tabs keep writing. Redefining or removing it drops its numbers. A database whose schema has a count index stores catalog format 4, which a version of this library from before count indexes refuses to open.

To delete a collection and its documents, name it in `drop`. A collection you only leave out keeps its documents for a later schema.

```ts
const v3 = defineSchema({
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
await openDocStore(kv, { ...v3, collections: { todos: collection<Todo>() } });
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
const v4 = defineSchema({
	version: 4,
	collections: {
		todos: v3.collections.todos.unique("byTitle", "title"),
	},
});
const todos4 = (await openDocStore(kv, v4)).collection("todos");
await todos4.query({ index: "byTitle" });
// throws DocStoreError "index-failed"
// err.ids names the documents. Fix them, then bump the version to
// rebuild
```

**Note.** `todos.indexes` follows this handle's schema. A query on an index that a newer schema redefined throws `"schema"`. A changed `include` redefines its index, which is rebuilt like a new one.

## Storage quota

Documents and index entries count against the origin's storage quota. Answer kv's `onStorageFull`, as kv's [Storage quota](../kv/README.md#storage-quota) explains.

```ts
const kv = await openDb({ name: "app" });
const store = await openDocStore(kv, schema);
// a cache your app can fetch again
const users = store.collection("users");

kv.onStorageFull(async () => {
	// kv can ask again before the space is free, so skip an
	// empty collection. Clearing one still sends every changes
	// listener a gap.
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
| `"schema"` | The stored catalog and this schema disagree, the catalog lacks the collection, or a queried index is still building. Or a collection or index name is not a letter or `_` followed by letters, digits or `_`, or is one `Object.prototype` holds, such as `toString`. | Open with the newer schema, or bump `version`. Query a building index again later. Rename the collection or index. |
| `"unique"` | Two documents would share a unique value. | Change or delete one of `ids`. |
| `"index-failed"` | A query reads an index whose backfill failed. | Fix the documents in `ids`, then bump `version`. |
| `"query"` | A query is malformed. | Fix the query. |
| `"cursor"` | `after` belongs to another range, or predates a `clear` or a redefinition. | Query again without `after`. |
| `"document"` | A bad or repeated id, a changed id, or a value an index cannot hold. | Fix the document. Nothing was stored. |
| `"invalid"` | A validator rejected a document: `issues` lists why, and `ids` names it if it has a string id. Or a validator returned a Promise. | Fix the document, or use a synchronous validator. Nothing was stored. |
| `ConstraintError` | A write passes kv's batch limit, or a query value makes a key over kv's 8 KiB limit. | Split the write, or shorten the query value. |
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
// throws DocStoreError "document", over 1,000 distinct elements
// in an array field
// an index added later fails over a stored document whose
// entries in it pass 8 MiB, counting 256 bytes per entry
const days = Array.from({ length: 33 }, (_, i) => i);
await todos.queryIds({ index: "open", eq: [[false, true], days] });
// throws DocStoreError "query", 2 x 33 combinations in eq,
// over 64
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
