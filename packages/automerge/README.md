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

## Limits

- A key is at most 8 KiB, and a chunk at most 8 MiB. A larger write throws `ConstraintError`.
- A key segment with a lone surrogate throws `Error`, since it cannot round-trip through UTF-8.

## Benchmarks

`pnpm bench automerge/` compares it with automerge-repo's `IndexedDBStorageAdapter`. See [bench/README.md](../../bench/README.md).
