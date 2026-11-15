# opfs-lsm

opfs-lsm stores your web app's data in the browser, in place of IndexedDB or SQLite. Every tab of your site shares one database and sees the writes of the other tabs as they happen. In batches of 1,000, it writes 8.1× faster than IndexedDB, and it reads a key 49× faster.

> [!WARNING]
> opfs-lsm is still under heavy development.
>
> We want it to be the building block for the best UX in web apps, and still ironing the fundamental details.
>
> Still, storage is fault-tolerant and heavily tested, so if you want to play around, feedback is very welcome!

## Check that opfs-lsm fits your app

opfs-lsm helps most when your app keeps its data in the browser and reads it on every screen: lists that load, sort, and filter, or documents that reopen. It also helps when users keep several tabs open, and each tab must show the writes of the others.

Use another store in these cases:

- **Your users run older browsers.** kv is [Baseline 2026](docs/browser-support.md): every major browser has run it since May 2026, when Chrome on Android added SharedWorker. Samsung Internet and Android WebView do not run it.
- **Your app stores little and writes one record at a time.** IndexedDB opens in 1.8 ms against 13.3 ms for kv, and writes a single awaited record at the same speed.
- **You need SQL.** opfs-lsm has no query language. docstore reads only through the indexes you declare in its schema.

## Pick a package

Start from the library that holds your app's data. Each adapter takes the place of a storage option that library ships with.

| Your data lives in | Install | In place of | Example app |
| --- | --- | --- | --- |
| TanStack DB collections | [`@opfs-lsm/tanstack-db`](packages/tanstack-db) | `indexedDBCollectionOptions` or TanStack's SQLite persistence | [LinearLite](examples/linearlite-tanstackdb) |
| Yjs documents | [`@opfs-lsm/yjs`](packages/yjs) | y-indexeddb | [Whiteboard](examples/whiteboard-yjs) |
| automerge-repo | [`@opfs-lsm/automerge`](packages/automerge) | `IndexedDBStorageAdapter` | [Pages](examples/pages-fate-automerge) |
| The fate client | [`@opfs-lsm/fate`](packages/fate), not on npm yet | `@nkzw/fate-indexeddb` | [LinearLite on fate](examples/linearlite-fate) |
| JSON documents of your own | [`@opfs-lsm/docstore`](packages/docstore) | Dexie | [LinearLite on docstore](examples/linearlite-docstore) |
| Your own sync engine | [`@opfs-lsm/kv`](packages/kv) | IndexedDB | |

The packages build on each other. `@opfs-lsm/kv` stores bytes under byte keys, in key order. `@opfs-lsm/docstore` stores JSON documents on kv and queries them through the indexes you declare. The TanStack DB adapter runs on docstore, and the other adapters run on kv.

Pick the highest layer that fits. Use kv directly only when you want to lay out the keys yourself, as a sync engine does.

## Set it up

Every package runs on a kv database, so setup starts the same way.

1. Install `@opfs-lsm/kv` and the package you picked. Each package page lists the other packages it needs.
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

Each database name gets its own SharedWorker and its own files, so a second database costs a second open. The packages keep their keys apart, so they can share one database. The [Pages example](examples/pages-fate-automerge) keeps the fate cache and the Automerge documents in one. Pass the same `db` to every package.

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

### Cap the data that can grow

kv never deletes a row on its own. If your data can grow without limit, such as a cache of server data, open with `maxBytes` and free space in an `onPressure` handler. The kv [Storage quota](packages/kv/README.md#storage-quota) section shows how.

## Read more

- [How opfs-lsm works](docs/how-it-works.md) explains why it is built on IndexedDB and OPFS, and what that costs.
- [Benchmarks](docs/benchmarks.md) compares it with IndexedDB, SQLite, and Dexie, and lists the bundle size.
- [Browser support](docs/browser-support.md) lists the minimum version in each browser and what is tested.
- [Engine design](docs/design.md) describes the files on disk, the protocols, and the invariants.
- [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, tests, benchmarks, and releases.

## License

MIT
