# opfs-lsm

A simple, fast and flexible k/v storage for the browsers.

> [!WARNING]
> opfs-lsm is not stable yet. Expect breaking changes, including to the on-disk format, so data written by one version may not open in the next. Two things are missing before a stable release:
>
> - Tests on mobile browsers.
> - Final storage formats. The WAL and SST layouts still change while we tune performance.

`@opfs-lsm/kv` stores byte keys and values. The promise from `put` or `batch` is the ack. When that promise resolves, the write is one byte row in the shared IndexedDB write-ahead log (WAL). Sorted SST files in the Origin Private File System (OPFS) hold sealed data after ingest. Every tab of an origin can open the same name. Each name has its own SharedWorker, `opfs-lsm:<name>`, which flushes the WAL into SST files once uningested key and value bytes reach 1 MiB.

`@opfs-lsm/docstore` ([packages/docstore](packages/docstore)) stores JSON documents in collections on top of kv. A versioned schema declares each collection's indexes, and one `query` method reads through them.

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
| `name` | Database name. Tabs that share this name share one WAL. |
| `memoryBudget` | Bytes of SST pages, Bloom filters, and block indexes this tab keeps. Default 256 MiB. A smaller request is raised to 1 MiB. It does not cover the memtable, the wasm heap, or values returned to the caller. |
| `memtableBytes` | Bytes of rows this tab holds that are not yet flushed to OPFS, counted as key bytes, value bytes, and an estimate per row. Default 16 MiB. A smaller request is raised to 1 MiB. At 7/8 of it the tab asks the host to flush and keeps writing. At the limit a write waits until the host returns that flush, so a writing tab's memtable stays near the limit. A host that cannot flush does not hold writes for good. When tabs differ, the host flushes once the WAL passes 7/8 of the smallest. |
| `compactionMemoryBytes` | Bytes the SharedWorker may spend on flushing and compacting this database: its wasm heap and the run data in flight. Default 32 MiB. A smaller request is raised to 8 MiB. A smaller figure gives smaller flush runs and a smaller read window, and under about 17.5 MiB fewer runs in one compaction step. The host's figures stop growing at 64 MiB. When tabs differ, the host uses the smallest, until the last tab closes the database. It counts memory that is alive, not garbage the browser has not collected yet. |

Harness knobs used by tests (`forceMemory`, `fs`, `ingest`, `ingestPolicy`, `writerId`, `allowEphemeral`, `trace`) live on `openHarnessDb` from `@opfs-lsm/kv/testing`. `ingestPolicy.maxWalBytes` overrides the 1 MiB flush.

### `Db`

Keys and values are `Uint8Array`.

| Method | Role |
| --- | --- |
| `get(key)` | Point read from the memtable and SST files. Does not touch IndexedDB. |
| `put(key, value)` | Append one put. Resolves on WAL ack, with the record's seq. |
| `delete(key)` | Append one delete. Resolves on WAL ack, with the record's seq. |
| `batch(build)` | Build puts and deletes synchronously. Resolves on one WAL ack, with the record's seq. |
| `update(keys, body)` | Read `keys` and write in one IndexedDB transaction. No conflict window. |
| `range(range?)` | Async scan by key range (`start`, `endExclusive`, `limit`). `reverse: true` yields the same keys from the largest down, and `limit` keeps the largest. `valueContains` keeps live puts whose current value holds every pattern. |
| `rangeFollow(range, follow)` | Scan a range, then point-read each follow key, on the memtable and SST generation pinned for the call. |
| `view(body)` | Read-only snapshot pinned to the WAL head and the installed OPFS generation when the view opens. |
| `changes(listener)` | Subscribe to every WAL record this handle applies, from any tab, with its ops, once each and in seq order. A `gap` event means the handle skipped records a flush folded, so read again. Returns unsubscribe. |
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

Advanced exports include `prefixBound`, `EngineHost`, `BrowserFs`, `MemoryFs`, and the error classes (`StorageUnavailableError`, `ClosedError`, and others). The SharedWorker entry `@opfs-lsm/kv/shared-worker` remains for bundlers that need an explicit worker URL.

## `@opfs-lsm/docstore`

```ts
import { openDb } from "@opfs-lsm/kv";
import { defineSchema, openDocStore } from "@opfs-lsm/docstore";

type User = { id: string; email: string; orgId: string; createdAt: number };

const schema = defineSchema<{ users: User }>()({
  version: 1,
  collections: {
    users: {
      byEmail: { on: "email", unique: true },
      byOrg: { on: ["orgId", "createdAt"] },
    },
  },
});

const kv = await openDb({ name: "app" });
const users = (await openDocStore(kv, schema)).collection("users");

await users.put({ id: "u1", email: "a@example.com", orgId: "acme", createdAt: Date.now() });

const row = await users.get("u1");
const byEmail = await users.query({ index: "byEmail", eq: ["a@example.com"] });
const newest = await users.query({ index: "byOrg", eq: ["acme"], reverse: true, limit: 20 });
```

`openDocStore(kv, schema)` uses the `kv` handle you opened. You keep closing it and calling `changes` and `ingest` on it. A collection has `get`, `getMany`, `put`, `putMany`, `modify`, `delete`, `deleteMany`, `clear`, `query`, `queryIds` and `count`. Each write is one kv transaction that also maintains the indexes. The index kinds (sorted, multi, text), schema versions, query rules, key order, errors and limits are in [packages/docstore/README.md](packages/docstore/README.md).

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

`pnpm test` typechecks and runs the unit suites. `pnpm bench` runs the benchmarks in headless Chrome: kv against raw IndexedDB, docstore against Dexie, and the Yjs and Automerge adapters against their IndexedDB counterparts. `pnpm bench:size` prints the bundle sizes. See [bench/README.md](bench/README.md). Set `CHROME_PATH` when Chrome is not on the default macOS path or on `PATH` as `google-chrome`. The formal suite and the Chrome proof helper are in [docs/verification.md](docs/verification.md).
