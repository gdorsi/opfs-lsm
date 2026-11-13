# @opfs-lsm/automerge

An automerge-repo storage adapter on [`@opfs-lsm/kv`](../kv/README.md).

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
const handle = repo.create({ count: 0 });
handle.change((d) => {
  d.count++;
});
handle.doc(); // => { count: 1 }
```

## Opening

Pass a db whose `openDb` has resolved, so writes other tabs acked before the open are visible.

## Closing

The adapter owns the db, and closing the storage closes it.

```ts
await storage.close?.(); // closes db
await storage.close?.(); // a second call resolves
await db.get(Uint8Array.of(1)); // throws ClosedError
```

## Removing a document

`removeRange` deletes in batches of 1,000 keys, one kv transaction each. A range larger than that is not removed atomically.

## Limits

```ts
await storage.save(["x".repeat(8191)], Uint8Array.of(1));
// throws ConstraintError, a key is at most 8 KiB in kv
await storage.save(["big"], new Uint8Array(9 << 20));
// throws ConstraintError, a write is at most 8 MiB in kv
await storage.save(["\uD800"], Uint8Array.of(1));
// throws Error, a lone surrogate cannot round-trip through UTF-8
```

## Benchmarks

`pnpm bench automerge/` compares it with automerge-repo's `IndexedDBStorageAdapter`. See [bench/README.md](../../bench/README.md).
