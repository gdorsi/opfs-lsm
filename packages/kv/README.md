# @opfs-lsm/kv

A key-value store for the browser. Every tab of an origin shares one database, and a write survives a crash of its tab once its promise resolves.

```sh
pnpm add @opfs-lsm/kv
```

```ts
import { openDb } from "@opfs-lsm/kv";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b?: Uint8Array) => b && new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);

const db = await openDb({ name: "notes" });
const key = enc("hello");
const value = enc("world");

await db.put(key, value);
dec(await db.get(key)); // => "world"
```

The [Overview](../../README.md) helps you pick between kv and the packages built on it. [Benchmarks](../../docs/benchmarks.md) compares kv with IndexedDB, and [Browser support](../../docs/browser-support.md) lists the minimum browser versions. How the engine works is in [docs/design.md](../../docs/design.md).

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

// In Node, or a dedicated WebWorker, which has OPFS but no
// SharedWorker:
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

// Many keys in one read, in the order asked. With a decode
// function a value is not copied: decode reads the stored bytes.
// It must not change them or keep them, not even a subarray: they
// are the bytes every later read sees, and kv does not check.
// Decode to a string, a number or a parsed object and return that.
await db.getMany([key, enc("missing")]);
// => [Uint8Array, undefined]
await db.getMany([key], (bytes) => dec(bytes)); // => ["world"]

await db.delete(key);                 // resolves with its seq too
await db.get(key);                    // => undefined

// get and getMany read memory and SST files. They never touch
// IndexedDB.

// Every key and value a read returns is a copy you may change. A copy
// of 65 bytes to 1 KiB shares its ArrayBuffer with other copies, as
// Node's Buffer pool does: read it through byteOffset, a multiple
// of 8, and byteLength. Posting or storing it clones the whole
// shared buffer, and transferring that buffer detaches the other
// copies, so slice() it before you post, store, transfer or keep it.

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
// and 256 bytes per op. Each op copies its bytes when it is
// called, so a buffer can be reused for the next op. A `tx`
// used after `build` returns throws `ConstraintError`.
const seq = await db.batch((tx) => {
  tx.put(enc("a"), enc("1"));
  tx.put(enc("b"), enc("2"));
  tx.delete(key);
});

await db.batch(() => {});
// writes nothing, resolves with the last seq this handle applied
```

## Read-modify-write

`update` reads `keys` and writes as one step: its writes commit only if no other write landed since the read, from this tab or another. Concurrent updates lose nothing, and there is no conflict to handle.

```ts
const count = await db.update([enc("count")], ([current], tx) => {
  // Runs synchronously with the current values, in the order of
  // `keys`. No await in here, and no side effects.
  const next = Number(dec(current) ?? 0) + 1;
  tx.put(enc("count"), enc(String(next)));
  return next;
});
count; // => 1
```

The body usually runs once, and the update costs what a `put` costs. It runs again when another write landed between its read and its commit, when it writes nothing or throws, and when the browser refuses the write for lack of space: three times at most. Only its last run counts: what it wrote, returned or threw. So keep it free of side effects, such as a counter outside the database or a network call. The updates of one handle run one at a time, in call order.

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

### `offset`

```ts
// Passes over entries before the first one. Each still costs a
// step of the scan, but no key or value is copied.
db.range({ ...users, offset: 1, limit: 1 });
// yields "user/2"
```

`limit` and `offset` are integers of 0 or more, or `Infinity`. Anything else rejects with `ConstraintError`.

### `valueContains`

```ts
// Keeps live puts whose current value holds every pattern.
db.range({ ...users, valueContains: [enc("a"), enc("e")] });
// yields "user/2" (Grace)
db.range({ ...users, valueContains: [enc("e")], limit: 1 });
// yields "user/2", since limit counts matches
```

### `count`

```ts
// How many entries db.range would yield, with the same options.
// It copies no key or value.
await db.count(users); // => 3
await db.count({ ...users, valueContains: [enc("e")] }); // => 1
```

## Tuple keys

`@opfs-lsm/kv/tuple` encodes a tuple of `null`, booleans, finite numbers and strings as key bytes. The bytes sort the way the tuples sort, so a range scan reads tuples in order.

```ts
import { decodeTuple, encodeTuple, tupleBounds } from "@opfs-lsm/kv/tuple";

await db.batch((tx) => {
  tx.put(encodeTuple(["ada", 1]), enc("first"));
  tx.put(encodeTuple(["ada", 2]), enc("second"));
  tx.put(encodeTuple(["ada\u0000", 1]), enc("other"));
  tx.put(encodeTuple(["adam", 1]), enc("other"));
});
// Every key that continues ["ada"], and none that continues "ada\u0000" or "adam".
for await (const { key } of db.range(tupleBounds(encodeTuple(["ada"])))) {
  decodeTuple(key).values; // => ["ada", 1], then ["ada", 2]
}
```

Tuples compare field by field. Fields sort as `null`, then `false`, then `true`, then numbers, then strings. Numbers compare by value with `-0` equal to `0`, and strings compare by code point. A tuple sorts before every longer tuple that starts with it.

- `encodeTuple(values, prefix?, tail?)` returns `prefix`, the fields, then `tail`. It throws a `TypeError` for another type of value, and a `RangeError` for a number that is not finite, a string with a lone surrogate, or a `tail` that starts with byte FF.
- `decodeTuple(key, count?, from?)` returns `{ values, end }`. Without `count` it reads every field to the end of `key`. A `tail` can start with any byte but FF, a tag included, so a key with a tail needs its `count`. `key.subarray(end)` is the tail. Bytes that `encodeTuple` does not write throw `CorruptDatabaseError`.
- `skipTuple(key, count, from?)` returns the `end` of the fields without decoding them. It throws `CorruptDatabaseError` when a field has no end, and does not check what the field holds.
- `tupleBounds(prefix)` and `stringPrefixBounds(prefix, s)` return `KeyBounds`. The first holds every key that continues `prefix` where a field ends. The second holds every key whose next field is a string that starts with `s`.

A field holds its own end, so neither the fields nor a tail need a length.

```text
01 null   02 false   03 true
04 + float64 big-endian, -0 as +0; sign bit set: every bit flipped, else the sign bit flipped
05 + UTF-8 with each 00 written 00 FF, then 00
```

After a complete field the next byte is a tag (01..05), a UTF-8 byte or nothing, never FF. `tupleBounds` relies on that: its range is `prefix` up to `prefix ++ FF`. Do not use `prefixBound` for a tuple. The key of `["ada"]` is `05 61 64 61 00`, and the key of `["ada\u0000"]` starts with the same bytes, so `prefixBound` returns both.

## Joins

`snap.rangeJoin` scans a range and reads the key `keyOf` returns for each entry, the way an index entry points at its row. It runs inside a `view`, so the scan and the joined reads see one state.

```ts
// post/1 holds its author's key.
const posts = await db.view((snap) =>
  snap.rangeJoin(prefixBound(enc("post/")), (entry) => entry.value)
);
dec(posts[0]?.entry.key); // => "post/1"
dec(posts[0]?.joined);    // => "Grace"

// `joined` is undefined when keyOf returns undefined or the key
// has no value. Writes that land meanwhile are not seen.
```

`snap.rangeValues(range, decode)` returns every entry of a range in one call as `{ key, value }`, where `value` is what `decode` returns for the stored bytes. The rule of `getMany`'s `decode` applies.

## Snapshots

```ts
const seen = await db.view(async (snap) => {
  await db.put(enc("user/4"), enc("Barbara"));
  // snap reads the state when the view opened
  return snap.get(enc("user/4"));
});
seen; // => undefined

// snap.range(...) and snap.count(...) take the same options as db.range.
// snap.rangeJoin(...) is described under Joins.
// snap.seq is the seq of the last write the snapshot includes.
```

## Changes

```ts
const stop = db.changes((event) => {
  switch (event.kind) {
    case "append":
      // one per WAL record, from any tab, once each, in seq order
      // op.type is "put", "del" or "deleteRange". ops is empty for
      // an update that ran again: the record its first run wrote
      for (const op of event.ops) console.log(op.type);
      break;
    case "gap":
      // this handle skipped records a flush folded. Read again.
      break;
    case "closed": // the last event. event.reason is "close" or "destroyed"
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

The WAL and the SST files count against the origin's storage quota. kv keeps a reserve file of `reserveBytes`. When the browser refuses a write, the SharedWorker deletes the file, the write runs again, and an `onStorageFull` handler is asked to free space. kv never removes a row itself.

```ts
// a 24 MiB reserve
await openDb({ name: "log" });
await openDb({ name: "log", reserveBytes: 64 * 1024 * 1024 });
// no reserve: a refused write fails, and
// onStorageFull is never called
await openDb({ name: "log", reserveBytes: 0 });
await openDb({ name: "log", reserveBytes: -1 });
// throws ConstraintError
```

Here keys start with a timestamp, so the handler drops the oldest rows. `bytes` is the size of the SST files. `need` is the size of the reserve to write back. Something else in the origin may hold the space, so free at most half of `bytes`.

```ts
const db = await openDb({ name: "log" });
// Register in the turn openDb resolves. With no handler, kv logs
// a warning and the next refused write fails.
db.onStorageFull(async ({ bytes, need }) => {
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

The deleted reserve is the room the handler's writes need: a delete frees space only once a flush and a compaction hold it. kv then writes the reserve again, and asks again while it does not fit, so make the handler safe to run again. [Reserve](../../docs/reserve.md) covers the states and which tab answers.

**Note.** While the reserve is gone and the origin is still full, `put`, `delete`, `batch` and `update` reject with `StorageFullError` after one more try, and `update` may run its body again for that try. Flushes fail with the same error. The acked writes stay in the WAL, and the SharedWorker flushes again after another 1 MiB of writes or the next `openDb`.

## Destroy

```ts
await db.dangerousDestroy(); // deletes every record, in every tab
await db.get(key);           // => undefined
await db.put(key, value);
// writes after it land in the empty database

// Handles stay open, and so does the storage. Other tabs read
// empty at their next sync() or write, each with a `gap` event.
```

```ts
import { destroyDb } from "@opfs-lsm/kv";

// Removes the database: its rows, its OPFS folder and its
// IndexedDB database. Every handle on it, in every tab and this
// one, closes first, with a `closed` event whose reason is
// "destroyed". Works when openDb throws CorruptDatabaseError.
// On a name with nothing stored it creates nothing.
await destroyDb("notes");
```

Both wait for a running flush or compaction step. Once one resolves, the records never come back, even after a power loss. A crash before that leaves the database as if it had not run, or empty.

`destroyDb` keeps one small row per removed name in the IndexedDB database `opfs-lsm-destroyed`. Opening the name after `destroyDb` finished deletes it. That row is what keeps a power loss from bringing the removed rows back.

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

`openHarnessDb` also takes `fs`, `ingest`, `writerId`, and `maxWalBytes`, which replaces the 1 MiB flush trigger.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | required | Tabs that pass the same name share one database. |
| `cacheBytes` | 256 MiB, at least 1 MiB | SST blocks and Bloom filters this tab caches. |
| `memtableBytes` | 16 MiB, at least 1 MiB | Unflushed rows this tab holds. At the limit a write waits for a flush ([Backpressure](../../docs/design.md#backpressure)). |
| `compactionMemoryBytes` | 32 MiB, at least 8 MiB | Memory the SharedWorker spends to flush and compact ([Memory budget](../../docs/design.md#memory-budget)). |
| `reserveBytes` | 24 MiB | Bytes the SharedWorker keeps in a file and gives back when the browser refuses a write. 0 keeps none. See [Storage quota](#storage-quota). |
| `syncReads` | off | Read SST files synchronously, through a dedicated worker. Pass `syncReads` from `@opfs-lsm/kv/sync-reads`. Chromium only, on a cross-origin isolated page. |

When tabs pass different values, the SharedWorker uses the smallest `compactionMemoryBytes` and the largest `reserveBytes` until the last tab closes the database.

```ts
import { openDb } from "@opfs-lsm/kv";
import { syncReads } from "@opfs-lsm/kv/sync-reads";

const db = await openDb({ name: "app", syncReads });
```

With `syncReads`, a read of a block that is not cached returns in the same task. Without it, such a read waits for a round trip to the browser process. A dedicated worker holds the SST files open and answers through a `SharedArrayBuffer`. That takes two things:

- A cross-origin isolated page: one served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- A browser that opens a sync access handle read-only. Today only Chromium does.

Where either is missing, the database opens and reads as it does without the option, with no error and no warning. Only an app that imports `@opfs-lsm/kv/sync-reads` bundles the code behind the option.

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
| `StorageUnavailableError` | `unavailable` | No SharedWorker or OPFS, or one that failed to start or open, the wasm engine did not load, or IndexedDB did not open. `cause` holds the browser's error. | Retry `openDb`, or reload the page. |
| `StorageFullError` | `quota` | The origin is out of quota and the reserve is gone, so a write or a flush fails. `cause` holds the browser's error for a write. | Free space. See [Storage quota](#storage-quota). |
| `CorruptDatabaseError` | `corrupt` | A file does not decode or is gone. kv changes nothing. | Do not retry. `destroyDb(name)` removes it. |
| `CommitError` | `commit` | The WAL has a gap or a row that does not decode. | |
| `ConstraintError` | `constraint` | A name, key, value, batch or range is invalid or over a limit. | Fix the call. |
| `ClosedError` | `closed` | The handle is closed: by `close()`, by `destroyDb`, or because the browser closed its IndexedDB connection. | Open a new one. |

**Note.** Chrome can damage its IndexedDB store when it crashes, then delete it or keep failing the open. If it deletes it, writes not flushed to OPFS yet are lost, and flushed data stays.
