# opfs-lsm

opfs-lsm stores your web app's data in the browser, in place of IndexedDB or SQLite. Every tab of your site shares one database and sees the writes of the other tabs as they happen. In batches of 1,000, it writes 17× faster than IndexedDB, and it reads a key 45× faster.

> [!WARNING]
> opfs-lsm is still under heavy development.
>
> We want it to be the building block for the best UX in web apps, and still ironing the fundamental details.
>
> Still, storage is fault-tolerant and heavily tested, so if you want to play around, feedback is very welcome!

## Check that opfs-lsm fits your app

opfs-lsm helps most when your app keeps its data in the browser and reads it on every screen: lists that load, sort, and filter, or documents that reopen. It also helps when users keep several tabs open, and each tab must show the writes of the others.

Use another store in these cases:

- **Your users run older browsers.** kv is [Baseline 2026](docs/browser-support.md): every major browser has run it since May 2026, when Chrome on Android added SharedWorker. Samsung Internet and Android WebView run it without SST files, so it never compacts and keeps the whole database in each tab's memory. So does Safari 16 to 25 wherever its SharedWorker cannot write files [without `createWritable()`](docs/browser-support.md#without-createwritable).
- **Your app stores little and writes one record at a time.** IndexedDB writes a single awaited record about as fast, and it loads no SharedWorker and no wasm engine.
- **You need SQL.** opfs-lsm has no SQL. db queries use TanStack DB's query syntax, and each query reads one collection, so there are no joins. A query is fast only through an index you declare. With no index that fits, it reads the whole collection.

## Packages

### Framework adapters

Each adapter stores the data of one framework in opfs-lsm. Your app keeps calling the framework's own API.

- **[`@opfs-lsm/tanstack-db`](packages/tanstack-db)** keeps TanStack DB collections in docstore. Writes from every tab reach every collection live. In on-demand mode, a collection loads only the rows its live queries ask for, through docstore indexes. Example: [LinearLite](examples/linearlite-tanstackdb).
- **[`@opfs-lsm/tanstack-query`](packages/tanstack-query)** persists the TanStack Query cache one query per kv entry. `createQueryPersister(db)` returns TanStack's per-query persister on kv.
- **[`@opfs-lsm/yjs`](packages/yjs)** keeps Yjs documents. `KvPersistence` has the `whenSynced`, `clearData`, and `destroy` of y-indexeddb, and merges the stored updates of a document into one when they reach 500. Example: [Whiteboard](examples/whiteboard-yjs).
- **[`@opfs-lsm/automerge`](packages/automerge)** is a storage adapter for automerge-repo. Pass `kvStorage(db)` to `new Repo({ storage })`. Example: [Notes](examples/notes-manager-automerge).

### Building blocks

- **[`@opfs-lsm/db`](packages/db)** keeps your app's documents in typed collections on docstore. A collection can check each write with a Standard Schema validator before it stores anything. Live queries use TanStack DB's query syntax, read through the indexes you declare, and update when a write from any tab changes their result. Its own errors are typed classes with a fixed `_tag` and `code`.
- **[`@opfs-lsm/docstore`](packages/docstore)** stores JSON documents in typed collections. You declare indexes in a versioned schema: sorted, array, text, and unique. A Standard Schema validator checks the writes of a collection. Queries read through them in pages, and each collection has counts, snapshot reads, and a change feed. Example: [LinearLite on docstore](examples/linearlite-docstore).
- **[`@opfs-lsm/kv`](packages/kv)** is the key-value store under every other package. Keys and values are bytes, kept in key order. It has batches, range scans, range deletes, counts, snapshot reads, read-modify-write, a change feed with a sequence number for every write, and a reserve that gives your app room to free space when the browser refuses a write.

## Set it up

### Store your app's data with db

db opens kv and docstore for you, so one package covers an app's own data.

1. Install `@opfs-lsm/db`.
2. Declare each collection and the indexes its queries read through.
3. Open the database when your app starts. Every tab that passes the same `name` shares it.
4. Decide what your app does when `openDatabase` rejects with `StorageError` code `unavailable`. db never falls back to memory.

```sh
pnpm add @opfs-lsm/db
```

```ts
import { collection, eq, openDatabase, query, StorageError } from "@opfs-lsm/db";

type Todo = { id: string; title: string; done: boolean; created: number };

const db = await openDatabase({
	name: "app",
	version: 1,
	collections: { todos: collection<Todo>().index("byDone", ["done", "created"]) },
}).catch((err) => {
	// The browser lacks an API the storage needs, or failed to load one.
	if (err instanceof StorageError && err.code === "unavailable") return undefined;
	throw err;
});
if (db) {
	const { todos } = db.collections;
	const open = query((q) => q.from({ t: todos }).where(({ t }) => eq(t.done, false)).orderBy(({ t }) => t.created));
	open.subscribe((rows) => console.log(rows)); // again each time the open todos change, in any tab
	await todos.insert({ id: "t1", title: "Buy milk", done: false, created: Date.now() });
}
```

[db's page](packages/db) covers writes, queries, live results, and errors.

### Start from kv for the other packages

The adapters and docstore run on a kv database that your app opens.

1. Install `@opfs-lsm/kv` and the package you use. Each package page lists the other packages it needs.
2. Open the database when your app starts. Every tab that passes the same `name` shares it.
3. Decide what your app does when `openDb` rejects with `StorageUnavailableError`. kv never falls back to memory.
4. Pass `db` to your package, as its page shows.

```ts
import { openDb, StorageUnavailableError } from "@opfs-lsm/kv";

const db = await openDb({ name: "app" }).catch((err) => {
	// The browser lacks an API kv needs, or failed to load one.
	if (err instanceof StorageUnavailableError) return undefined;
	throw err;
});
if (!db) {
	// Run without local data, or ask the user to reload.
}
```

## Use it well

kv is fastest when it reads local data and writes in batches. These rules help your app do both, and keep one tab from losing the writes of another.

### Open one database for the whole app

Each database name gets its own SharedWorker and its own files, so a second database costs a second open. The packages keep their keys apart, so they can share one database. Pass the same `db` to every package that takes one. db opens its own database by name, so give it a name no other package uses.

Closing an Automerge storage also closes its database, so close that storage last.

### Write in batches

Each write waits for an IndexedDB commit before its promise resolves with the ack. A loop that awaits one `put` per row commits one transaction per row, and writes no faster than IndexedDB. Put the rows of one change in one call instead. They share one transaction, and they commit together or not at all.

- In kv, call `db.batch((tx) => { ... })`.
- In docstore, call `collection.putMany(docs)`.
- In TanStack DB, pass an array to `collection.insert(rows)`.

A batch is at most 8 MiB, so split a large import into several batches.

### Change a value in one step

To change a value based on what is stored, read and write it in one call: `db.update` in kv, `collection.modify` in docstore, or `collection.utils.transact` in TanStack DB. Another tab can write between a `get` and a later `put`, and the `put` then overwrites that write. A TanStack DB `update` stores the whole row as this tab holds it, so the last tab to write wins.

### Follow changes instead of reading again

`changes` reports every write from every tab, in order. Update your UI from its events, and read again on a `gap` event. The docstore [Changes](packages/docstore/README.md#changes) section shows how to load a snapshot and follow it without missing a write.

A tab sees the write of another tab a moment after its ack. To wait for every write acked so far, call `db.sync()`.

The TanStack DB adapter applies the writes of other tabs for you. The Yjs adapter loads a document only once, so add a Yjs provider that syncs open tabs.

### Read related values from one snapshot

When a screen shows values that must agree, such as a page of rows and their total, read them in one `view`. Another write can commit between two separate reads, so each can see a different state. `db.view` in kv and `collection.view` in docstore read a snapshot that later writes do not change.

### Query through an index

docstore reads through the indexes you declare in its schema. Declare one for each query a screen runs.

With TanStack DB, open a large collection with `syncMode: "on-demand"`. The default, `"eager"`, loads every row when the collection opens. On demand, a live query loads only its own rows, through the docstore index whose leading fields the query pins with `eq` or `inArray`. With no index that fits, the load reads every document.

### Free space when the storage is full

kv never deletes a row on its own. If your data can grow without limit, such as a cache of server data, free space in an `onStorageFull` handler, which kv calls when the browser refuses a write. The kv [Storage quota](packages/kv/README.md#storage-quota) section shows how.

## Read more

- [How opfs-lsm works](docs/how-it-works.md) explains why it is built on IndexedDB and OPFS, and what that costs.
- [Benchmarks](docs/benchmarks.md) compares it with IndexedDB, SQLite, and Dexie, and lists the bundle size.
- [Browser support](docs/browser-support.md) lists the minimum version in each browser and what is tested.
- [Engine design](docs/design.md) describes the files on disk, the protocols, and the invariants.
- [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, tests, benchmarks, and releases.

## License

MIT
