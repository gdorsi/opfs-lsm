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

## Limits

- A key is at most 8 KiB, and a batch at most 8 MiB. A larger write throws `ConstraintError`, which fate reports as a storage error.
- fate's `exclusive` sections need Web Locks (`navigator.locks`).

## Benchmarks

`pnpm bench fate/` compares it with `@nkzw/fate-indexeddb` under one fate client. See [bench/README.md](../../bench/README.md).
