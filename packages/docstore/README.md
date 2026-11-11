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

`openDocStore(kv, schema)` returns a `DocStore`. The caller opens `kv`, closes it, and keeps using it for `changes` and other layers. Keys that start with byte `0x64` belong to this package.

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

## Schema versions

`version` is an integer of at least 1. Bump it on every change to `collections`. Open reads the stored catalog and compares versions in one kv transaction:

| Declared version | Open does |
|---|---|
| No catalog stored | Stores this schema. Every index starts ready. |
| Lower than stored | Uses the stored catalog unchanged. |
| Equal to stored | Uses the stored catalog. Throws `"schema"` if a declared collection's indexes differ from the stored ones. |
| Higher than stored | Stores this schema. A new or changed index starts building. A removed or changed index's keys are swept. |

- Open resolves once every index the schema declares is ready or failed.
- A building index is filled from the rows in the background. A handle runs the backfill when it opens or clears the collection, so a backfill cut short by a closed tab resumes on the next open.
- A collection the new schema leaves out keeps its documents and indexes. A later schema that declares it again sees them.
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
| `delete(id)` | `boolean` | `true` if there was a document. |
| `deleteMany(ids)` | `number` | One kv transaction. Counts the distinct ids that existed. |
| `clear()` | `void` | One catalog write, whatever the size. The collection gets a new id, so every reader and writer stops seeing the old documents at once. The old keys are deleted in the background. |
| `query(q)` | `{ docs, next? }` | One page in index order. A multi index returns a document once per matching element. |
| `queryIds(q)` | `{ ids, next? }` | As `query`, without reading the documents. |
| `count(q)` | `number` | The entries `query` would return, up to `limit` if given. |

Each write method is one kv transaction. If another handle changed the catalog since this handle last read it, the write reads the new catalog and runs again.

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

## Order

Index values order as `null`, `false`, `true`, numbers ascending, then strings. `-0` equals `0`. Strings order by their UTF-8 bytes, so `"a"` sorts before `"a\u0000b"`, which sorts before `"aa"`. `eq: ["a"]` and `lte: "a"` do not return `"a\u0000b"`, and `gt: "a"` does.

## Errors

Every error this package throws on purpose is a `DocStoreError` with a `code`. kv's errors (`ConstraintError`, `ClosedError`, `CommitError`, `CorruptDatabaseError`) pass through unchanged.

| `code` | Thrown when |
|---|---|
| `"schema"` | The stored catalog and this schema disagree in a way this handle cannot work with. |
| `"unique"` | A write would give two documents one value of a unique index. `ids` is the incoming id, then the owner's id. |
| `"index-failed"` | A query reads an index whose backfill failed. `ids` names the documents. |
| `"query"` | A query is malformed. |
| `"cursor"` | `after` does not belong to this query. |
| `"document"` | An id is bad, an id repeats in one `putMany`, `modify` changed the id, or a value cannot go in an index. Nothing is stored. |

## Limits

- A document id is at most 1,024 UTF-8 bytes.
- An index key is at most 8 KiB. A write whose key would be longer throws `"document"`.
- A multi index takes at most 1,000 distinct elements per document.
- A write call is one kv batch, so kv's limits apply to it. kv allows 10,000 operations and 8 MiB per batch, and 16 MiB per value. Over a limit, kv throws `ConstraintError`.
