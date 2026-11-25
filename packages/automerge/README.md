# @opfs-lsm/automerge

An [automerge-repo](https://automerge.org/docs/hello/) storage adapter on [`@opfs-lsm/kv`](../kv/README.md).

```sh
pnpm add @opfs-lsm/automerge @opfs-lsm/kv @automerge/automerge-repo
```

```ts
import { Repo } from "@automerge/automerge-repo";
import { kvStorage } from "@opfs-lsm/automerge";
import { openDb } from "@opfs-lsm/kv";

const db = await openDb({ name: "automerge" });
const storage = kvStorage(db);
const repo = new Repo({ storage });
```

## Closing

The adapter owns the db, and closing the storage closes it.

```ts
await storage.close?.(); // closes db
```

## Without storage

```ts
import { noStorage, openDb } from "@opfs-lsm/kv";

const db = await openDb({ name: "automerge" }).catch(noStorage);
const repo = new Repo({ storage: kvStorage(db), isEphemeral: !db });
```

Where the browser cannot store, the db is `undefined` ([Browsers without storage](../kv/README.md#browsers-without-storage)). The adapter then keeps every chunk in its own memory, so a document the Repo evicts and finds again keeps its content, and a reload starts empty. Pass `isEphemeral: !db`. A Repo with storage tells its peers a storage id to keep sync state for, and this one gets a new id on every load.

## Limits

- A key is at most 8 KiB, and a chunk with its key and 256 bytes at most 8 MiB, kv's batch limit. A larger write throws `ConstraintError`.
- A key segment with a lone surrogate throws `Error`, since it cannot round-trip through UTF-8.

## Benchmarks

`pnpm bench automerge/` compares it with automerge-repo's `IndexedDBStorageAdapter`. See [bench/README.md](../../bench/README.md).
