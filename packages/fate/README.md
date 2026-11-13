# @opfs-lsm/fate

Persistence storage for the fate data client (`@nkzw/fate`) on [`@opfs-lsm/kv`](../kv/README.md). It takes the place of the storage in `@nkzw/fate-indexeddb`.

```sh
pnpm add @opfs-lsm/fate @opfs-lsm/kv @nkzw/fate
```

```ts
import { createClient } from "@nkzw/fate";
import { createPersistence } from "@nkzw/fate/persistence";
import { openDb } from "@opfs-lsm/kv";
import { kvStorage } from "@opfs-lsm/fate";

const db = await openDb({ name: "app" });
const storage = kvStorage(db);
const persistence = createPersistence({ key: "acct:1", storage });
// roots, transport, and types are your app's
const client = createClient({
  persistence, roots, transport, types
});
```

## Sharing a database

You own `db` and close it. Every key this adapter writes starts with the byte `f`, so other apps and adapters can share the db.

## Atomic batches

A `writeBatch` is one kv transaction, so it lands whole or not at all.

```ts
await storage.writeBatch([
  ["ok", 1],
  ["\uD800", 2],
]);
// throws Error, a lone surrogate, and "ok" is not written
await storage.read("ok"); // => undefined
```

## Values

Values go through JSON, not structured clone as in `@nkzw/fate-indexeddb`. fate does not rely on the difference.

```ts
const value = { n: NaN, at: new Date(0), gone: undefined };
await storage.writeBatch([["v", value]]);
await storage.read("v");
// => { n: null, at: "1970-01-01T00:00:00.000Z" }
```

## Key order

`scan` returns keys in UTF-8 byte order, where IndexedDB uses UTF-16 code unit order. fate does not rely on the difference.

```ts
await storage.writeBatch([
  ["k\u{1F600}", 1], // outside the BMP
  ["k￿", 2],
]);
(await storage.scan("k")).map((e) => e.key);
// => ["k￿", "k\u{1F600}"]
// IndexedDB returns "k\u{1F600}" first
```

## Other tabs

A read outside an `exclusive` section can miss a write another tab just acked. Each `exclusive` grant first catches up.

```ts
// Tab A
await storage.writeBatch([["theme", "dark"]]);

// Tab B
await storage.read("theme"); // can still miss A's write
await storage.exclusive("prefs", () => storage.read("theme"));
// => "dark"
```

`subscribe` fires on writes to that key from this tab and from other tabs, deletes included.

## Limits

fate reports a `ConstraintError` as a storage error.

```ts
await storage.writeBatch([["x".repeat(9000), 1]]);
// throws ConstraintError, a key is at most 8 KiB in kv
await storage.writeBatch([["big", "x".repeat(9 << 20)]]);
// throws ConstraintError, a batch is at most 8 MiB in kv
await storage.exclusive("prefs", async () => {});
// throws Error where navigator.locks is missing
```

## Benchmarks

`pnpm bench fate/` compares it with `@nkzw/fate-indexeddb` under one fate client. See [bench/README.md](../../bench/README.md).
