# opfs-lsm

A simple, fast and flexible k/v storage for the browsers.

`@opfs-lsm/kv` stores byte keys and values. The promise from `put` or `batch` is the ack. When that promise resolves, the write is one record in this tab's own log, a file in the Origin Private File System (OPFS) that a dedicated WebWorker writes through a SyncAccessHandle and flushes within 100 ms. The tab reads its acked writes from then on. Every tab of an origin can open the same name. Each name has its own SharedWorker, `opfs-lsm:<name>`, which ingests every tab's log into sorted SST files about once a second, or at once when 1 MiB of flushed records waits. The order it ingests in is the only order across tabs: other tabs see a write once it is ingested, and when two tabs write one key, the one ingested last wins.

`@opfs-lsm/collections` builds tables and secondary indexes on the same logs and OPFS path. Its table API is Dexie-shaped: `put`, `get`, `where`, and `orderBy` over JSON rows.

`@opfs-lsm/yjs` ([packages/yjs](packages/yjs)) is a Yjs provider shaped like y-indexeddb, and `@opfs-lsm/automerge` ([packages/automerge](packages/automerge)) is an automerge-repo storage adapter. Both keep many documents in one kv db.

The storage layout, consistency rules, and ingest path are in [docs/design.md](docs/design.md). How to verify a change is in [docs/verification.md](docs/verification.md).

## `@opfs-lsm/kv`

### Open a database

```ts
import { openDb } from "@opfs-lsm/kv";

const db = await openDb({ name: "notes" });

const key = new TextEncoder().encode("hello");
const value = new TextEncoder().encode("world");
await db.put(key, value);
const found = await db.get(key);
```

In the browser, `openDb` opens OPFS and starts that SharedWorker. In Node it uses an in-memory filesystem and a local ingest host. If the page has no SharedWorker or OPFS, `openDb` throws `StorageUnavailableError`.

### `OpenOptions`

| Option | Role |
| --- | --- |
| `name` | Database name. Tabs that share this name share one SharedWorker and one set of SST files. |
| `memoryBudget` | Bytes of SST pages, Bloom filters, and block indexes this tab keeps. Default 256 MiB. A smaller request is raised to 1 MiB. It does not cover this tab's writes not yet ingested, the wasm heap, or values returned to the caller. |
| `pendingBytes` | Key and value bytes of this tab's writes not yet ingested, at most. Default 32 MiB, at least 1 MiB. Past it a write waits for an ingest and rejects with `CommitError` after 30 s. |

Harness knobs used by tests (`forceMemory`, `fs`, `segments`, `host`, `spawn`, `segmentBytes`, `allowEphemeral`, `trace`) live on `openHarnessDb` from `@opfs-lsm/kv/testing`, with `Host` and its `HostLimits` for an ingest host on the page.

### `Db`

Keys and values are `Uint8Array`.

| Method | Role |
| --- | --- |
| `get(key)` | Point read from this tab's writes not yet ingested, then the SST files. |
| `put(key, value)` | Append one put to this tab's log. Resolves on the ack. |
| `delete(key)` | Append one delete. Resolves on the ack. |
| `batch(build)` | Build puts and deletes synchronously. One record: it applies whole or not at all. Resolves on one ack. |
| `update(keys, body)` | Read `keys` after this tab's earlier writes, then write what `body` puts. Updates on one tab never lose each other's writes. Across tabs it is last writer wins: another tab's write to the same keys that is ingested later replaces it. |
| `range(range?)` | Async scan by key range (`start`, `endExclusive`, `limit`). `reverse: true` yields the same keys from the largest down, and `limit` keeps the largest. `valueContains` keeps live puts whose current value holds every pattern. |
| `rangeFollow(range, follow)` | Scan a range, then point-read each follow key, on one state pinned for the call. |
| `view(body)` | Read-only snapshot: the installed SST generation and this tab's writes as they were when the view opened. |
| `changes(listener)` | Subscribe to this tab's acked writes (`local`) and to installs of newer SST generations (`ingest`). Returns unsubscribe. |
| `sync()` | Install a generation that holds this tab's writes acked before the call and every other tab's writes flushed before it. The SharedWorker asks the other tabs to flush and waits for them at most 500 ms. |
| `ingest()` | `sync()`, then compaction until a pass installs nothing. |
| `close()` | Close this tab's handle. |

```ts
await db.batch((tx) => {
  tx.put(key, value);
  tx.delete(oldKey);
});

await db.sync();
await db.ingest();
```

Advanced exports include `prefixBound`, `BrowserFs`, `MemoryFs`, and the error classes (`StorageUnavailableError`, `ClosedError`, and others). The SharedWorker entry `@opfs-lsm/kv/shared-worker` remains for bundlers that need an explicit worker URL.

## `@opfs-lsm/collections`

### Open a collection database

```ts
import { openCollectionDb } from "@opfs-lsm/collections";

const db = await openCollectionDb({
  name: "app",
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
| `clear()` | Delete every row and its index entries in chunks. Returns the row count. |
| `where(index, value)` | Equality or compound-prefix lookup on a declared index. |
| `orderBy(index, opts?)` | Walk an index in key order. Optional `from`, `toExclusive`, `limit`. |
| `page(index, opts)` | One cursor page of an index. Pass `next` from the previous call as `after`. |
| `search(text, opts)` | Word-prefix text search, one cursor page, in `search.sortBy` order. Needs a `search` spec on the table. |

An index `path` is a field name, a dot path, or a compound list such as `["orgId", "createdAt"]`. Set `multiEntry: true` to index each element of an array-valued path.

For text search, give the table `search: { path: "title", sortBy: "newest" }`. A row then gets one extra key holding its lowercased words, so a put costs one key more, not one per word and per prefix as a `multiEntry` term index does. `table.search("mil bre", { limit: 50 })` returns rows with, for every word typed, a word that starts with it (case-insensitive, letters and digits), ordered by `sortBy` ascending. Store a descending number to get newest first, and treat `sortBy` as immutable: changing it moves the row's key. A search reads the search keys until a page fills: a common word returns in microseconds, and a word that matches nothing reads every search key of the table.

## Clone and run

`engines.node` in `package.json` is `>=22`. `.nvmrc` pins 24. `packageManager` is `pnpm@10.33.2`.

```
git clone https://github.com/gdorsi/opfs-lsm.git
cd opfs-lsm
pnpm install
pnpm test
pnpm bench kv/
pnpm todo:example
pnpm automerge:example
```

`pnpm test` typechecks and runs the unit suites. `pnpm bench` runs the benchmarks in headless Chrome: kv against raw IndexedDB, collections against Dexie, and the Yjs and Automerge adapters against their IndexedDB counterparts. `pnpm bench:size` prints the bundle sizes. See [bench/README.md](bench/README.md). Set `CHROME_PATH` when Chrome is not on the default macOS path or on `PATH` as `google-chrome`. The formal suite and the Chrome proof helper are in [docs/verification.md](docs/verification.md).
