# @opfs-lsm/docstore

A document store on `@opfs-lsm/kv`. Collections hold JSON documents with a string `id`. You declare each collection's indexes in a versioned schema, and queries read through those indexes.

```ts
import { openDb } from "@opfs-lsm/kv";
import { defineSchema, openDocStore } from "@opfs-lsm/docstore";

type Todo = { id: string; title: string; done: boolean; createdAt: number; tags: string[] };

const schema = defineSchema<{ todos: Todo }>()({
	version: 1,
	collections: {
		todos: {
			open: { on: ["done", "createdAt"] },
			byTag: { on: "tags", multi: true },
			search: { on: "createdAt", text: "title" },
		},
	},
});

const kv = await openDb({ name: "app" });
const todos = (await openDocStore(kv, schema)).collection("todos");

await todos.put({ id: "t1", title: "Buy milk", done: false, createdAt: 1, tags: ["home"] });
const first = await todos.query({ index: "open", eq: [false], limit: 20 });
const second = await todos.query({ index: "open", eq: [false], limit: 20, after: first.next });
const hits = await todos.queryIds({ index: "search", match: "mil" });
```

## Open a store

`openDocStore(kv, schema)` returns a `DocStore`. The caller opens `kv`, closes it, and keeps using it for `ingest` and other layers. Keys that start with byte `0x64` belong to this package.

`DocStore` has two methods:

- `collection(name)` returns a typed `Collection`. Its operations throw `"schema"` if the stored catalog has no collection with that name.
- `whenIdle()` resolves when the background backfills and sweeps this handle runs have finished.

## Documents

A document is a JSON object with a string `id`. Declare document types with `type`, not `interface`, because only a type literal satisfies the `JsonDoc` constraint. A `Date`, `Map`, `Uint8Array`, or class instance fails to compile.

The store keeps `JSON.stringify(doc)` and returns `JSON.parse` of that text. That stored form drops `undefined` fields, turns `-0` into `0`, and turns `NaN` into `null`. Indexes read the stored form, never the object you passed.

An id is a non-empty string of at most 1,024 UTF-8 bytes with no lone surrogate.

## Indexes

Each index has a name, unique within its collection, and one of three kinds. `on` is a dot path or a tuple of dot paths. The schema types accept paths of up to four segments, such as `a.b.c.d`.

| Kind | Declaration | Entries per document |
|---|---|---|
| sorted | `{ on, unique? }` | One, ordered by the values at `on`, then the id. |
| multi | `{ on, multi: true, unique? }` | One per distinct element of the array at the first path, each followed by the values at the other paths. |
| text | `{ on, text }` | One, ordered by `on`, carrying the words of the string at `text`. |

- A document with no value at some path of `on` has no entry in that index.
- An empty array at a multi path gives no entry. A scalar there gives one entry.
- A unique index refuses a second document with the same values. Documents with no entry never conflict.
- Every value at an `on` path must be `null`, a boolean, a number, or a string with no lone surrogate. A write with another value at an indexed path throws `"document"`.

`collection.indexes` maps each index name the handle's schema declares to an `IndexInfo`, for a layer that plans queries:

| Field | Meaning |
|---|---|
| `kind` | `"sorted"`, `"multi"` or `"text"`. |
| `on` | The dot paths the index orders by, in order. |
| `unique` | Whether the index is unique. |
| `text` | The dot path of a text index's words. Absent for the other kinds. |

`indexes` follows the schema, not the stored catalog. A query on a declared index that a newer schema redefined, or whose backfill failed, still throws.

## Schema versions

`version` is an integer of at least 1. Bump it on every change to `collections`. Open reads the stored catalog and compares versions in one kv transaction:

| Declared version | Open does |
|---|---|
| No catalog stored | Stores this schema. Every index starts ready. |
| Lower than stored | Uses the stored catalog unchanged. |
| Equal to stored | Uses the stored catalog. Throws `"schema"` if a declared collection's indexes differ from the stored ones, or a collection named in `drop` is still stored. |
| Higher than stored | Stores this schema. A new or changed index starts building. A removed or changed index's keys are swept. A collection named in `drop` leaves the catalog and its keys are swept. |

- Open resolves once every index the schema declares is ready or failed.
- A building index is filled from the rows in the background. A handle runs the backfill when it opens or clears the collection, so a backfill cut short by a closed tab resumes on the next open.
- A collection the new schema leaves out keeps its documents and indexes. A later schema that declares it again sees them.
- To delete a collection, name it in `drop` (`{ version: 3, collections: { … }, drop: ["notes"] }`). A name may not be both declared and dropped, and a name not stored is ignored. Handles on an older schema get `"schema"` from the dropped collection. A later schema that declares the name again starts it empty.
- A backfill that finds two documents with one unique value, or a value an index cannot hold, marks the index failed. Queries on a failed index throw `"index-failed"` with the ids. The next version bump rebuilds it.
- Writes maintain every building or ready index the stored catalog holds, including indexes this handle's schema does not declare.
- A query reads an index only if the schema declares it with the stored definition and the index is ready. A query on a failed index throws `"index-failed"`. A query on any other index throws `"schema"`.

## Collection methods

| Method | Returns | Notes |
|---|---|---|
| `get(id)` | `T \| undefined` | The stored form. |
| `getMany(ids)` | `(T \| undefined)[]` | In the order of `ids`. Each document is read on its own, not from one snapshot. |
| `put(doc)` | `void` | Upsert. Same as `putMany([doc])`. |
| `putMany(docs)` | `void` | One kv transaction. All documents land or none do. A document whose stored bytes would not change writes nothing. |
| `modify(id, fn)` | `T \| undefined` | `fn` gets the stored form and returns the next document with the same id. `fn` may run more than once. Returns the stored result, or `undefined` without calling `fn` if there is no document. |
| `modifyMany(ids, fn)` | `void` | Read-modify-write several documents in one kv transaction. `fn` gets the stored forms in the order of `ids` (`undefined` for a missing one) and returns one entry per id: a document to store, whose id is that slot's id; `null` to delete; `undefined` to leave as is. `fn` may run more than once. |
| `delete(id)` | `boolean` | `true` if there was a document. |
| `deleteMany(ids)` | `number` | One kv transaction. Counts the distinct ids that existed. |
| `clear()` | `void` | One catalog write, whatever the size. The collection gets a new id, so every reader and writer stops seeing the old documents at once. The old keys are deleted in the background. |
| `query(q)` | `{ docs, next? }` | One page in index order. A multi index returns a document once per matching element. |
| `queryIds(q)` | `{ ids, next? }` | As `query`, without reading the documents. |
| `count(q)` | `number` | The entries `query` would return, up to `limit` if given. |
| `view(body)` | `R` | Runs `body` once with a `CollectionSnapshot` and returns what it returns. See [Snapshots](#snapshots). |
| `changes(listener)` | `() => void` | Reports every change to the collection's documents. Returns the function that stops it. See [Changes](#changes). |

Each write method is one kv transaction. If another handle changed the catalog since this handle last read it, the write reads the new catalog and runs again.

No write from another handle or tab lands between the read of `modify` and `modifyMany` and their write. In a collection without a unique index, they read the documents and run `fn` inside one kv transaction. With a unique index, the keys to read depend on what `fn` returns, so they read the documents first, run `fn`, and commit only if every document `fn` saw still holds the same bytes. Otherwise they read again and run `fn` again. A slot `modifyMany` leaves as is counts as read: if that document changed, `fn` runs again. `fn` must be pure.

`modifyMany` throws `"document"` and stores nothing for a repeated id, a result that is not one entry per id, or a document under another id than its slot's. It checks unique indexes across the whole call, so two documents can swap values.

## Queries

A query names an index, or names none and reads the documents in id order.

| Field | Meaning |
|---|---|
| `index` | The index name. Absent means the documents in id order, with the id as the one component. |
| `eq` | Values for the first k components of `on`. |
| `gt`, `gte`, `lt`, `lte` | Bounds on component k + 1. At most one of `gt` and `gte`, and at most one of `lt` and `lte`. |
| `startsWith` | A string prefix of component k + 1. No other bound with it. |
| `match` | Text indexes only. Keeps entries where every word of `match` occurs inside a word of the text. `ow` finds `window`. |
| `limit` | A positive integer. Absent means every result. |
| `after` | The `next` of the previous page. |
| `reverse` | Descending order of the same range. |

- The query types follow the index's `on` paths. A bound of the wrong type, or a bound on a component the `eq` does not reach, fails to compile.
- `next` is set when more entries follow the page. It is exclusive. The next page starts after it, or before it with `reverse`.
- An `after` from another range, from past the range, or made before a `clear` or a redefinition throws `"cursor"`.
- Text search lowercases the text and splits it into words at every character that is not a letter or a digit. A `match` with no words throws `"query"`.
- Each page reads one kv snapshot.

## Snapshots

`view(body)` runs `body` once with a `CollectionSnapshot` and resolves with what `body` returns. Every read of the snapshot sees one state of the database, whatever is written meanwhile by this handle, other handles or other tabs. A `clear` or a schema change after the snapshot began does not reach it.

| Member | Meaning |
|---|---|
| `seq` | The kv seq of the snapshot. Every `changes` event with a seq at or below it is reflected in what the snapshot reads, and none above it is. |
| `get`, `getMany` | As the collection's, from the snapshot. |
| `query`, `queryIds`, `count` | As the collection's, from the snapshot. |

- `query`, `queryIds` and `count` on the collection are each a `view` with one read. Use `view` to read a page and its count, or several queries, from one state.
- `view` throws `"schema"` without running `body` if the stored catalog lacks the collection.
- A snapshot reads only. A write made inside `body` is not visible to it.

## Changes

`changes(listener)` calls `listener` with every change to the collection's documents, from this handle, other handles and other tabs, in kv seq order. It subscribes to kv once per call. A new listener holds the events that arrive until it has read the catalog and loses none. Once it has started, this handle's own writes reach it before they resolve.

| `kind` | Fields | Sent when |
|---|---|---|
| `"append"` | `seq`, `changes` | A kv write changed documents of this collection. `changes` has one entry per document in the write. |
| `"gap"` | | What the listener holds may be stale: read again. Sent when kv reports a gap (this handle skipped records that a flush folded) and when the collection is cleared or dropped, since its keys changed. A collection that is dropped or absent sends a gap, then nothing until it exists again. |
| `"closed"` | | The kv handle closed. This is the last event. |

- A change is `{ id, deleted, doc }`. `doc` is the stored form after the change, parsed on first access, so a listener that reads only `id` and `deleted` pays no `JSON.parse`. A delete has no `doc`.
- The feed reports documents only. Index entries and catalog writes that leave the collection's id alone, such as a backfill finishing or a schema version, send nothing.
- A listener that throws is logged and skipped. Other listeners and the store go on.
- Calling `changes` on a closed kv handle throws `ClosedError`.

To read the collection and then follow it without a hole or a repeat, subscribe first, read a snapshot, and apply the events with a seq above `snap.seq`. Hold the events that arrive while a snapshot loads, and read again on a gap:

```ts
const rows = new Map<string, Todo>();
let seen = 0;
let held: CollectionChange<Todo>[] | undefined;

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

async function load() {
	held = [];
	await todos.view(async (snap) => {
		rows.clear();
		for (const t of (await snap.query({})).docs) rows.set(t.id, t);
		seen = snap.seq;
	});
	const replay = held;
	held = undefined;
	replay.forEach(apply);
}

todos.changes(apply);
await load();
```

## Order

Index values order as `null`, `false`, `true`, numbers ascending, then strings. `-0` equals `0`. Strings order by their UTF-8 bytes, so `"a"` sorts before `"a\u0000b"`, which sorts before `"aa"`. `eq: ["a"]` and `lte: "a"` do not return `"a\u0000b"`, and `gt: "a"` does.

## Storage quota

Documents and index entries are kv rows, so they count against the origin's storage quota. To free space before the origin runs out, open kv with `maxBytes: "quota"` and answer its offers with `kv.onPressure`. kv's [Storage quota](../kv/README.md#storage-quota) explains the offer.

Free space with `clear()`. After it, a background sweep removes the collection's old keys with one kv range delete, and their space comes back once compaction rewrites the files that hold them. `delete` and `deleteMany` remove one key at a time, and kv frees those bytes late, as its [Size cap](../kv/README.md#size-cap) explains. Clear a collection your app can fetch again, such as a cache of server data:

```ts
const kv = await openDb({ name: "app", maxBytes: "quota" });
const comments = (await openDocStore(kv, schema)).collection("comments");

kv.onPressure(async () => {
	if ((await comments.queryIds({ limit: 1 })).ids.length > 0) await comments.clear();
});
```

The handler skips an empty collection, because an offer can come back before the space is free. A `clear()` of an empty collection still sends every `changes` listener a gap.

## Errors

Every error this package throws on purpose is a `DocStoreError` with a `code`. kv's errors (`ConstraintError`, `ClosedError`, `CommitError`, `CorruptDatabaseError`) pass through unchanged.

| `code` | Thrown when |
|---|---|
| `"schema"` | The stored catalog and this schema disagree in a way this handle cannot work with. |
| `"unique"` | A write would give two documents one value of a unique index. `ids` is the incoming id, then the owner's id. |
| `"index-failed"` | A query reads an index whose backfill failed. `ids` names the documents. |
| `"query"` | A query is malformed. |
| `"cursor"` | `after` does not belong to this query. |
| `"document"` | An id is bad, an id repeats in one `putMany` or `modifyMany`, `modify` or `modifyMany` returned a document under another id, `modifyMany` returned the wrong number of entries, or a value cannot go in an index. Nothing is stored. |

## Limits

- A document id is at most 1,024 UTF-8 bytes.
- An index key is at most 8 KiB. A write whose key would be longer throws `"document"`.
- A multi index takes at most 1,000 distinct elements per document.
- A write call is one kv batch, so kv's limits apply to it. kv allows 8 MiB per batch, counted as the key bytes, the value bytes, and 256 bytes for each operation. It has no separate limit on the number of operations. Over a limit, kv throws `ConstraintError`.
