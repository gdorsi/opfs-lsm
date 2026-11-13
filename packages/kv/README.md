# @opfs-lsm/kv

A key-value store for the browser. Keys and values are bytes. Every tab of an origin shares one database, and a write is durable when its promise resolves.

Why to pick it over IndexedDB, the benchmarks, and browser support are in the [repository README](../../README.md). How the engine works is in [docs/design.md](../../docs/design.md).

The promise from `put` or `batch` is the ack. When it resolves, the write is one row in a write-ahead log (WAL) in IndexedDB that every tab shares. Each database name has one SharedWorker, `opfs-lsm:<name>`. It flushes the WAL into sorted SST files in the Origin Private File System (OPFS) once 1 MiB of key and value bytes is waiting, and compacts those files in the background.

## Open a database

```ts
import { openDb } from "@opfs-lsm/kv";

const db = await openDb({ name: "notes" });

const key = new TextEncoder().encode("hello");
const value = new TextEncoder().encode("world");
await db.put(key, value);
const found = await db.get(key);
```

`destroyDb(name)` deletes every record of a database without opening it, so it also works on one that `openDb` refuses with `CorruptDatabaseError`. Open handles behave as after `dangerousDestroy()`.

`openDb` opens OPFS and starts the database's SharedWorker, or joins it when another tab started it. Where SharedWorker or OPFS is missing, as in Node or a dedicated WebWorker, it rejects with `StorageUnavailableError`. It never keeps the data in memory instead. Tests get an in-memory database from `openHarnessDb({ forceMemory: true })` in `@opfs-lsm/kv/testing`.

## `OpenOptions`

| Option | Role |
| --- | --- |
| `name` | Database name. Tabs that share this name share one WAL. |
| `cacheBytes` | Bytes of SST pages, Bloom filters, and block indexes this tab keeps. Default 256 MiB. A smaller request is raised to 1 MiB. It does not cover the memtable, the wasm heap, or values returned to the caller. |
| `memtableBytes` | Bytes of rows this tab holds that are not yet flushed to OPFS, counted as key bytes, value bytes, and an estimate per row. Default 16 MiB. A smaller request is raised to 1 MiB. At 7/8 of it the tab asks the host to flush and keeps writing. At the limit a write waits until the host returns that flush, so a writing tab's memtable stays near the limit. A host that cannot flush does not hold writes for good. When tabs differ, the host flushes once the WAL passes the smallest ask: 1 MiB, or 7/8 of `memtableBytes` when that is lower. |
| `compactionMemoryBytes` | Bytes the SharedWorker may spend on flushing and compacting this database: its wasm heap and the run data in flight. Default 32 MiB. A smaller request is raised to 8 MiB. A smaller figure gives smaller flush runs and a smaller read window, and under about 17.5 MiB fewer runs in one compaction step. The host's figures stop growing at 64 MiB. When tabs differ, the host uses the smallest, until the last tab closes the database. It counts memory that is alive, not garbage the browser has not collected yet. |
| `maxBytes` | Bytes of SST files the database should stay under, or `"quota"` for 90% of the browser's storage quota for the origin. kv never removes a row for it: it asks an `onPressure` handler to. A write never waits for the cap and is never refused because of it. When tabs differ, the host uses the smallest number and honors `"quota"` too, until the last tab closes the database. See [Size cap](#size-cap). |

Harness knobs used by tests (`forceMemory`, `fs`, `ingest`, `maxWalBytes`, `writerId`, `trace`) live on `openHarnessDb` from `@opfs-lsm/kv/testing`. `maxWalBytes` overrides the 1 MiB flush. `ingest(db)` from the same entry flushes the memtable now and waits for the compaction it starts.

## `Db`

Keys and values are `Uint8Array`.

| Member | Role |
| --- | --- |
| `name` | The name passed to `openDb`. |
| `get(key)` | Point read from the memtable and SST files. Does not touch IndexedDB. |
| `put(key, value)` | Append one put. Resolves on WAL ack, with the record's seq. |
| `delete(key)` | Append one delete. Resolves on WAL ack, with the record's seq. |
| `batch(build)` | Build puts, deletes and range deletes synchronously. Resolves on one WAL ack, with the record's seq. |
| `update(keys, body)` | Read `keys` and write in one IndexedDB transaction. No conflict window. |
| `range(range?)` | Async scan by key range (`start`, `endExclusive`, `limit`). `reverse: true` yields the same keys from the largest down, and `limit` keeps the largest. `valueContains` keeps live puts whose current value holds every pattern. |
| `rangeJoin(range, keyOf)` | Scan a range and join each entry to the value at `keyOf(entry)`, as an index entry joins its row. The scan and the reads see one state. |
| `view(body)` | Read-only snapshot of the state when the view opens. `snap.seq` is the seq of the last record it includes, counted as write acks and `changes` count it. |
| `onPressure(handler)` | Answer the offers to bring the database under `maxBytes`. See [Size cap](#size-cap). Returns unsubscribe. |
| `changes(listener)` | Subscribe to every WAL record this handle applies, from any tab, with its ops, once each and in seq order. A range delete comes as a `deleteRange` op with its bounds and its `through`, resolved. A `gap` event means the handle skipped records a flush folded, so read again. Returns unsubscribe. |
| `sync()` | Catch up to every write acked before the call from any tab. |
| `close()` | Close this tab's handle. |
| `dangerousDestroy()` | Delete every record, in every tab. Writes acked before it are gone, and writes after it land in the empty database. Every handle stays open: this one reads empty when it resolves, other tabs at their next `sync` or write, each with a `gap` event. The host removes the files no tab is reading, and the rest once their tabs move on. Waits for a flush or compaction step already running. Once it resolves, the deleted records never come back, even after a power loss. A crash before that leaves the database as if it had not run. |

```ts
await db.batch((tx) => {
  tx.put(key, value);
  tx.delete(oldKey);
});

await db.sync();
```

### Range deletes

`tx.deleteRange(bounds, options?)` removes every row in `[start, endExclusive)` in one op, however many rows that is. A bound left out is open: `deleteRange({})` removes every row. It removes the rows written before its batch, never the puts in its own batch, and a later put into the range is read as usual. `options.through` narrows it to the rows last written at a seq of at most `through`, as a write's ack returns it, so a range delete does not remove a row another tab wrote after the caller read the range. Reads in this tab skip the removed rows once the ack resolves, other tabs once they apply the record and at the latest after their next `sync`, and a `view` opened before the range delete keeps reading them. A removed row that was not yet flushed is never written to OPFS. One already in an SST file is skipped by reads until compaction rewrites that file without it, so its space comes back.

```ts
const seq = await db.put(key, value);
await db.batch((tx) => tx.deleteRange(prefixBound(prefix), { through: seq }));
```

An empty or inverted range, or a `through` that is not a whole number of at least 0, throws `ConstraintError`.

### Size cap

When the SST files pass `maxBytes`, the SharedWorker offers `{ bytes, maxBytes, need }` to one handle: `bytes` is the size of the SST files, and `need` is how much to free to come back to 7/8 of `maxBytes`. The handlers of every handle compete for the Web Lock `opfs-lsm-pressure/<name>`, and only the holder's run, one after another. A handler removes what the layer chooses with ordinary writes, so the database stays consistent and other tabs see the removal as any write. If the holder closes or its tab goes away mid-answer, the next handle to take the lock gets the offer.

Here keys start with a timestamp, so the layer drops the oldest rows that hold `need` bytes:

```ts
const db = await openDb({ name: "log", maxBytes: 64 * 1024 * 1024 });
db.onPressure(async ({ need }) => {
  let freed = 0;
  let end: Uint8Array | undefined;
  for await (const { key, value } of db.range()) {
    if (freed >= need) {
      end = key;
      break;
    }
    freed += key.byteLength + value.byteLength;
  }
  // No `end`: every row together holds less than `need`, so all of them go.
  await db.batch((tx) => tx.deleteRange(end ? { endExclusive: end } : {}));
});
```

Answer with `deleteRange`. Its bytes come back once a flush holds it and compaction rewrites the files it covers. A point `delete` frees file bytes only when a merge drops its tombstone at the deepest level, which may be late. The SharedWorker measures again after the next flush, so the offer comes back while the answer freed too little, at most once per compaction pass: a handler must be safe to run again. The next offer waits for the handlers to settle, so a handler that never settles stops the offers. Under writes heavy enough that compaction does not catch up, the offer comes late.

With `maxBytes: "quota"`, the SharedWorker offers when `navigator.storage.estimate()` reports `usage` over 90% of `quota`: `bytes` is `usage`, `maxBytes` is that 90%, and `need` is the same distance to 7/8 of it. The estimate covers the whole origin (the WAL in IndexedDB, other databases, caches) and is approximate, so a handler may not be able to free `need` from this database alone. Without a usable estimate there is no offer. The SharedWorker reads the estimate only while no superseded SST file is left on disk, so a long `view` that keeps old files open holds the quota offer back.

Without `"quota"`, `bytes` counts SST files only. It includes rows that a delete or an overwrite hides and no merge has dropped yet, and leaves out the WAL and the SST files a long `view` keeps open. A handle opened with `maxBytes` and no handler warns once per offer when no handle answers, and the database keeps growing. Call `onPressure` in the same turn that `openDb` resolves: an offer that arrives before the handler logs that warning, and the handler still gets the offer once it registers.

## Errors

Every error the engine throws on purpose is an `OpfsLsmError` with a `code`. A host error keeps its class when it crosses the SharedWorker port.

| Class | `code` | Meaning | What to do |
| --- | --- | --- | --- |
| `StorageUnavailableError` | `unavailable` | The context has no SharedWorker or OPFS, the wasm engine did not load, or the browser's IndexedDB store failed to open. `cause` holds the browser's error when there is one. | For a failed IndexedDB open, retry `openDb`, or reload the page. Chrome can damage its own IndexedDB store when it crashes, and then deletes it or keeps failing the open. If it deletes it, the writes not yet flushed to OPFS are lost and the flushed data is kept. |
| `StorageFullError` | `quota` | The browser refused a flush or compaction write because the origin is out of storage quota. | The host rejects the flush, and no `Db` method surfaces that. The acked writes stay in the WAL, and the host flushes again after another 1 MiB of writes or the next `openDb`. `ingest(db)` from `@opfs-lsm/kv/testing` flushes now and rejects with this error. |
| `CorruptDatabaseError` | `corrupt` | A file of the database does not decode, or a file it needs is gone. | Do not retry. The engine changes nothing. `destroyDb(name)` empties the database. |
| `CommitError` | `commit` | The WAL has a gap or a row that does not decode. | |
| `ConstraintError` | `constraint` | A key, value or batch is not valid or is over a limit. | Fix the call. |
| `ClosedError` | `closed` | The handle is closed. | Open a new one. |

`@opfs-lsm/kv` also exports `prefixBound`, the `KeyBounds` and `DeleteRangeOptions` types of `deleteRange`, and the error classes above. The harness that tests use (`EngineHost`, `MemoryFs`, `openHarnessDb`) is in `@opfs-lsm/kv/testing`. The SharedWorker entry `@opfs-lsm/kv/shared-worker` remains for bundlers that need an explicit worker URL.
