# @opfs-lsm/kv

A key-value store for the browser. Every tab of an origin shares one database, and a write is durable when its promise resolves.

```sh
pnpm add @opfs-lsm/kv
```

```ts
import { openDb } from "@opfs-lsm/kv";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b?: Uint8Array) => b && new TextDecoder().decode(b);

const db = await openDb({ name: "notes" });
const key = enc("hello");
const value = enc("world");

await db.put(key, value);
dec(await db.get(key)); // => "world"
```

Benchmarks against IndexedDB and browser support are in the [repository README](../../README.md). How the engine works is in [docs/design.md](../../docs/design.md).

## Open a database

Keys and values are `Uint8Array`, so the examples use the `enc` and `dec` helpers above.

```ts
// Every tab that opens "notes" shares it. A write lands in a
// write-ahead log (WAL) in IndexedDB. One SharedWorker per name,
// `opfs-lsm:notes`, flushes the WAL into sorted SST files in the
// Origin Private File System (OPFS) once 1 MiB is waiting, and
// compacts them.
const db = await openDb({ name: "notes" });

await openDb({ name: "my notes" });
// throws ConstraintError. Names match /^[A-Za-z0-9_-]{1,64}$/.

// In Node or a dedicated WebWorker, which have no SharedWorker or
// OPFS:
await openDb({ name: "notes" });
// throws StorageUnavailableError, never falls back to memory
```

```ts
await db.close(); // this tab's handle only
await db.get(key); // throws ClosedError
const again = await openDb({ name: "notes" });
// open a new handle instead
```

**Note.** Bundlers that need an explicit worker URL can import `@opfs-lsm/kv/shared-worker`.

## Reads and writes

```ts
const seq = await db.put(key, value);
// resolves on the WAL ack, with the record's seq
dec(await db.get(key));               // => "world"
await db.delete(key);                 // resolves with its seq too
await db.get(key);                    // => undefined

// get reads memory and SST files. It never touches IndexedDB.
await db.put(new Uint8Array(9 * 1024), value);
// throws ConstraintError. Keys are at most 8 KiB.
await db.put(key, new Uint8Array(9 << 20));
// throws ConstraintError. A batch, value included, is at most 8
// MiB.
```

## Batches

```ts
// `build` runs synchronously. Every op lands in one WAL record,
// with one ack. The 8 MiB limit counts key bytes, value bytes,
// and 256 bytes per op.
const seq = await db.batch((tx) => {
  tx.put(enc("a"), enc("1"));
  tx.put(enc("b"), enc("2"));
  tx.delete(key);
});

await db.batch(() => {});
// writes nothing, resolves with the last seq this handle applied
```

## Read-modify-write

`update` reads `keys` and writes in one IndexedDB transaction, so no other tab's write lands in between.

```ts
const count = await db.update([enc("count")], ([current], tx) => {
  // Runs synchronously with the current values, in the order of
  // `keys`. No await in here.
  const next = Number(dec(current) ?? 0) + 1;
  tx.put(enc("count"), enc(String(next)));
  return next;
});
count; // => 1
```

## Range scans

```ts
import { prefixBound, type KeyBounds } from "@opfs-lsm/kv";

await db.batch((tx) => {
  tx.put(enc("user/1"), enc("Ada"));
  tx.put(enc("user/2"), enc("Grace"));
  tx.put(enc("user/3"), enc("Linus"));
  tx.put(enc("post/1"), enc("user/2"));
});
const users: KeyBounds = prefixBound(enc("user/"));
// { start: "user/", endExclusive: "user0" }
```

```ts
for await (const { key, value } of db.range(users)) {
  dec(key); // => "user/1", then "user/2", then "user/3"
}

db.range({ start: enc("user/2"), endExclusive: enc("user/3") });
// yields "user/2"
db.range(); // yields every key, in byte order
```

### `reverse` and `limit`

```ts
// Same keys, largest first. Bounds stay in key order. `limit`
// keeps the largest.
db.range({ ...users, reverse: true, limit: 2 });
// yields "user/3", "user/2"

// To page backward, pass the last key you saw as `endExclusive`.
db.range({
  ...users,
  endExclusive: enc("user/2"),
  reverse: true,
  limit: 2
});
// yields "user/1"
```

### `valueContains`

```ts
// Keeps live puts whose current value holds every pattern.
db.range({ ...users, valueContains: [enc("a"), enc("e")] });
// yields "user/2" (Grace)
db.range({ ...users, valueContains: [enc("e")], limit: 1 });
// yields "user/2", since limit counts matches
```

## Joins

`rangeJoin` scans a range and reads the key `keyOf` returns for each entry, the way an index entry points at its row.

```ts
// post/1 holds its author's key.
const posts = await db.rangeJoin(
  prefixBound(enc("post/")),
  (entry) => entry.value
);
dec(posts[0]?.entry.key); // => "post/1"
dec(posts[0]?.joined);    // => "Grace"

// `joined` is undefined when keyOf returns undefined or the key
// has no value. The scan and the joined reads see one state.
// Writes that land meanwhile are not seen.
```

## Snapshots

```ts
const seen = await db.view(async (snap) => {
  await db.put(enc("user/4"), enc("Barbara"));
  // snap reads the state when the view opened
  return snap.get(enc("user/4"));
});
seen; // => undefined

// snap.range(...) takes the same options as db.range.
// snap.seq is the seq of the last write the snapshot includes.
```

## Changes

```ts
const stop = db.changes((event) => {
  switch (event.kind) {
    case "append":
      // one per WAL record, from any tab, once each, in seq order
      // op.type is "put", "del" or "deleteRange"
      for (const op of event.ops) console.log(op.type);
      break;
    case "gap":
      // this handle skipped records a flush folded. Read again.
      break;
    case "closed": // the last event
  }
});
```

```ts
const seq = await db.put(key, value);
// The listener got this before the put resolved:
// { kind: "append", seq, ops: [{ type: "put", key, value }] }
stop();
```

## Other tabs

```ts
// Tab A
await db.put(enc("theme"), enc("dark"));

// Tab B, right after. Without sync, it sees the write a moment
// later, when A's BroadcastChannel message arrives.
await db.sync();
// catches up to every write acked before the call, from any tab
dec(await db.get(enc("theme"))); // => "dark"
```

## Range deletes

```ts
// Every row in [start, endExclusive), in one op however many rows
// that is.
await db.batch((tx) => tx.deleteRange(users));
await db.batch((tx) =>
  tx.deleteRange({ endExclusive: enc("m") })
);
// a missing bound is open
await db.batch((tx) => tx.deleteRange({})); // every row
```

```ts
await db.batch((tx) => {
  tx.put(enc("user/9"), enc("Ken"));
  tx.deleteRange(users); // never removes a put of its own batch
});
dec(await db.get(enc("user/9"))); // => "Ken"
```

```ts
// Remove only rows last written at or before `through`, such as a
// write's seq, snap.seq, or a change's seq.
// A row another tab wrote after you read the range stays.
const seq = await db.put(enc("user/1"), enc("Ada"));
await db.batch((tx) => tx.deleteRange(users, { through: seq }));

await db.batch((tx) =>
  tx.deleteRange({ start: enc("b"), endExclusive: enc("b") })
);
// throws ConstraintError
await db.batch((tx) => tx.deleteRange({}, { through: -1 }));
// throws ConstraintError
```

```ts
await db.put(enc("user/1"), enc("Ada"));
await db.view(async (snap) => {
  await db.batch((tx) => tx.deleteRange(users));
  await db.get(enc("user/1")); // => undefined
  dec(await snap.get(enc("user/1")));
  // => "Ada", since a view opened before keeps reading it
});
// Other tabs skip the rows once they apply the record, at the
// latest after their next sync(). Change listeners get { type:
// "deleteRange", start, endExclusive, through }, with `through`
// resolved.
```

**Note.** A removed row that was not flushed yet never reaches OPFS. One already in an SST file is skipped until compaction rewrites that file and frees its space.

## Storage quota

The WAL and the SST files count against the origin's storage quota. Open with `maxBytes`, and the SharedWorker asks an `onPressure` handler to free space. kv never removes a row itself, and a write never waits or fails because of the cap.

```ts
// offer when usage passes 90% of the origin's quota
await openDb({ name: "log", maxBytes: "quota" });
// offer when this database's SST files pass 64 MiB
await openDb({ name: "log", maxBytes: 64 * 1024 * 1024 });
await openDb({ name: "log", maxBytes: 0 });
// throws ConstraintError
```

Here keys start with a timestamp, so the handler drops the oldest rows. `need` is what to free to get back to 4/5 of the cap, and with `"quota"` it counts the whole origin, so free at most half of `bytes`.

```ts
const db = await openDb({ name: "log", maxBytes: "quota" });
// Register in the turn openDb resolves. With no handler, kv logs
// a warning and the database keeps growing.
db.onPressure(async ({ bytes, need }) => {
  const goal = Math.min(need, bytes / 2);
  let freed = 0;
  for await (const { key, value } of db.range()) {
    if (freed >= goal) {
      // a range delete frees space sooner than point deletes
      await db.batch((tx) =>
        tx.deleteRange({ endExclusive: key })
      );
      return;
    }
    freed += key.byteLength + value.byteLength;
  }
});
```

The offer comes back after a flush while too little was freed, so make the handler safe to run again. The engine's [Size cap](../../docs/design.md#size-cap) covers how kv measures and which tab answers.

**Note.** If the origin runs out anyway, flushes fail with `StorageFullError`. The acked writes stay in the WAL, and the SharedWorker flushes again after another 1 MiB of writes or the next `openDb`.

## Destroy

```ts
await db.dangerousDestroy(); // deletes every record, in every tab
await db.get(key);           // => undefined
await db.put(key, value);
// writes after it land in the empty database

// Handles stay open. Other tabs read empty at their next sync()
// or write, each with a `gap` event. It waits for a running flush
// or compaction step. Once it resolves, the records never come
// back, even after a power loss. A crash before that leaves the
// database as if it had not run.
```

```ts
import { destroyDb } from "@opfs-lsm/kv";

// Does not open the database, so it also empties one that openDb
// refuses with CorruptDatabaseError.
await destroyDb("notes");
// open handles behave as after dangerousDestroy()
```

## Testing

```ts
import "fake-indexeddb/auto"; // Node has no IndexedDB
import { openHarnessDb, ingest } from "@opfs-lsm/kv/testing";

// In memory. Two opens of one name in one process act as two
// tabs.
const tabA = await openHarnessDb({
  name: "notes",
  forceMemory: true
});
const tabB = await openHarnessDb({
  name: "notes",
  forceMemory: true
});

await tabA.put(key, value);
await ingest(tabA);
// flushes now and waits for the compaction it starts
await tabB.sync();
dec(await tabB.get(key)); // => "world"
```

`openHarnessDb` also takes `fs`, `ingest`, `writerId`, `trace`, and `maxWalBytes`, which replaces the 1 MiB flush trigger.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | required | Tabs that pass the same name share one database. |
| `cacheBytes` | 256 MiB, at least 1 MiB | SST pages, Bloom filters and block indexes this tab caches. |
| `memtableBytes` | 16 MiB, at least 1 MiB | Unflushed rows this tab holds. At the limit a write waits for a flush ([Backpressure](../../docs/design.md#backpressure)). |
| `compactionMemoryBytes` | 32 MiB, at least 8 MiB | Memory the SharedWorker spends to flush and compact ([Memory budget](../../docs/design.md#memory-budget)). |
| `maxBytes` | none | `"quota"`, or SST bytes to stay under. See [Storage quota](#storage-quota). |

When tabs pass different values, the SharedWorker uses the smallest `compactionMemoryBytes` and `maxBytes` until the last tab closes the database.

## Errors

```ts
import { OpfsLsmError } from "@opfs-lsm/kv";

// Errors from the SharedWorker keep their class in the tab.
try {
  await db.put(new Uint8Array(9 * 1024), value);
} catch (err) {
  if (err instanceof OpfsLsmError) err.code; // => "constraint"
}
```

| Class | `code` | When | What to do |
| --- | --- | --- | --- |
| `StorageUnavailableError` | `unavailable` | No SharedWorker or OPFS, the wasm engine did not load, or IndexedDB did not open. `cause` holds the browser's error. | Retry `openDb`, or reload the page. |
| `StorageFullError` | `quota` | The origin is out of quota, so a flush fails. No `Db` method throws it, but `ingest(db)` does. | Free space. See [Storage quota](#storage-quota). |
| `CorruptDatabaseError` | `corrupt` | A file does not decode or is gone. kv changes nothing. | Do not retry. `destroyDb(name)` empties it. |
| `CommitError` | `commit` | The WAL has a gap or a row that does not decode. | |
| `ConstraintError` | `constraint` | A name, key, value, batch or range is invalid or over a limit. | Fix the call. |
| `ClosedError` | `closed` | The handle is closed. | Open a new one. |

**Note.** Chrome can damage its IndexedDB store when it crashes, then delete it or keep failing the open. If it deletes it, writes not flushed to OPFS yet are lost, and flushed data stays.
