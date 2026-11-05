# opfs-lsm

A simple, fast and flexible k/v storage for the browsers.

`@opfs-lsm/kv` stores byte keys and values. The promise from `put` or `batch` is the ack. When that promise resolves, the write is in the shared IndexedDB write-ahead log (WAL). Sorted SST files in the Origin Private File System (OPFS) hold sealed data after ingest. Every tab of an origin can open the same name. A SharedWorker turns the WAL into SST files.

`@opfs-lsm/collections` builds tables and secondary indexes on the same WAL and OPFS path. Its table API is Dexie-shaped: `put`, `get`, `where`, and `orderBy` over JSON rows.

The storage layout, consistency rules, and ingest path are in [docs/design.md](docs/design.md).

## `@opfs-lsm/kv`

### Open a database

```ts
import { openDb } from "@opfs-lsm/kv";

const db = await openDb({
  name: "notes",
  workerUrl: new URL("@opfs-lsm/kv/shared-worker", import.meta.url),
});

const key = new TextEncoder().encode("hello");
const value = new TextEncoder().encode("world");
await db.put(key, value);
const found = await db.get(key);
```

`workerUrl` is the SharedWorker module this package exports. In Node, or under `forceMemory: true`, the call uses an in-memory filesystem and a local ingest host instead.

If the page has no SharedWorker or OPFS, and you pass neither `fs`, `ingest`, nor `forceMemory`, `openDb` throws `StorageUnavailableError`. Pass `allowEphemeral: true` when you want an in-memory database that lasts only for the page.

### `OpenOptions`

| Option | Role |
| --- | --- |
| `name` | Database name. Tabs that share this name share one WAL. |
| `workerUrl` | SharedWorker script URL for browser default wiring. |
| `fs` | Filesystem used for SST reads on this tab. Omit to use OPFS in the browser. |
| `ingest` | Ingest client. Omit when `workerUrl` is set. |
| `ingestPolicy` | When the memtable flushes to an OPFS run. |
| `writerId` | Stable writer id for tests. Default is a random UUID. |
| `forceMemory` | Use MemoryFs even when OPFS is available. |
| `allowEphemeral` | Use MemoryFs when the page cannot open OPFS. |

### `Db`

Keys and values are `Uint8Array`.

| Method | Role |
| --- | --- |
| `get(key)` | Point read from the memtable and SST files. Does not touch IndexedDB. |
| `put(key, value)` | Append one put. Resolves on WAL ack. |
| `delete(key)` | Append one delete. Resolves on WAL ack. |
| `batch(build)` | Build puts and deletes synchronously. Resolves on one WAL ack. |
| `update(keys, body)` | Read `keys` and write in one IndexedDB transaction. No conflict window. |
| `range(range?)` | Async scan by key range (`start`, `endExclusive`, `limit`). |
| `rangeFollow(range, follow)` | Scan a range, then point-read follow keys, in one IndexedDB transaction. |
| `view(body)` | Read-only snapshot pinned to the WAL head and OPFS generation at open. |
| `changes(listener)` | Subscribe to durable WAL appends and ingest generation bumps. Returns unsubscribe. |
| `sync()` | Catch up to every write acked before the call from any tab. |
| `ingest()` | Flush the memtable now and wait for the compaction it starts. |
| `close()` | Close this tab's handle. |

```ts
await db.batch((tx) => {
  tx.put(key, value);
  tx.delete(oldKey);
});

await db.sync();
await db.ingest();
```

Advanced exports include `prefixBound`, `EngineHost`, `BrowserFs`, `MemoryFs`, the error classes (`StorageUnavailableError`, `ClosedError`, and others), and the SharedWorker entry `@opfs-lsm/kv/shared-worker`.

## `@opfs-lsm/collections`

### Open a collection database

```ts
import { openCollectionDb } from "@opfs-lsm/collections";

const db = await openCollectionDb({
  name: "app",
  workerUrl: new URL("@opfs-lsm/kv/shared-worker", import.meta.url),
  schema: {
    tables: [
      {
        name: "users",
        primaryKey: "id",
        indexes: [
          { name: "email", path: "email" },
          { name: "byOrg", path: ["orgId", "createdAt"] },
        ],
      },
    ],
  },
});

const users = db.table<{
  id: string;
  email: string;
  orgId: string;
  createdAt: number;
}>("users");

await users.put({
  id: "u1",
  email: "a@example.com",
  orgId: "acme",
  createdAt: Date.now(),
});

const row = await users.get("u1");
const byEmail = await users.where("email", "a@example.com");
```

`OpenCollectionOptions` is `OpenOptions` from `@opfs-lsm/kv` plus a required `schema`. `CollectionDb` exposes `table(name)`, `ingest()`, `close()`, and the underlying `kv` handle.

### `Table`

Rows are JSON objects. The primary key field defaults to `"id"` and must be a string.

| Method | Role |
| --- | --- |
| `get(id)` | Load one row by primary key. |
| `put(doc)` | Upsert one row and refresh its index keys. |
| `putMany(docs)` | Upsert many rows in one read+write transaction. Chunk to about 1,000 rows. |
| `update(id, mutate)` | Read-modify-write one row. Must keep the primary key. |
| `delete(id)` | Delete one row and its index keys. |
| `clear()` | Delete every row and index entry in chunks. Returns the row count. |
| `where(index, value)` | Equality or compound-prefix lookup on a declared index. |
| `orderBy(index, opts?)` | Walk an index in key order. Optional `from`, `toExclusive`, `limit`. |
| `page(index, opts)` | One cursor page of an index. Pass `next` from the previous call as `after`. |

An index `path` is a field name, a dot path, or a compound list such as `["orgId", "createdAt"]`. Set `multiEntry: true` to index each element of an array-valued path.

## Clone and run

`engines.node` in `package.json` is `>=22`. `.nvmrc` pins 24. `packageManager` is `pnpm@10.33.2`.

```
git clone https://github.com/gdorsi/opfs-lsm.git
cd opfs-lsm
pnpm install
pnpm test
pnpm bench:browser
pnpm bench:collections
pnpm todo:example
pnpm automerge:example
```

`pnpm test` typechecks and runs the unit suites. `pnpm bench:browser` starts headless Chrome against the SharedWorker path. Set `CHROME_PATH` when Chrome is not on the default macOS path or on `PATH` as `google-chrome`.
