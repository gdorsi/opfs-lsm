# @opfs-lsm/yjs

A [Yjs](https://docs.yjs.dev) provider on [`@opfs-lsm/kv`](../kv/README.md), shaped like y-indexeddb's `IndexeddbPersistence`.

```sh
pnpm add @opfs-lsm/yjs @opfs-lsm/kv yjs
```

```ts
import { openDb } from "@opfs-lsm/kv";
import { KvPersistence } from "@opfs-lsm/yjs";
import * as Y from "yjs";

const db = await openDb({ name: "notes" });
const doc = new Y.Doc();
const persistence = new KvPersistence(db, "note-1", doc);
await persistence.whenSynced;
```

## Merging

Each update is one kv entry. A load that finds 500 entries or more merges them into one. The fourth argument sets that threshold.

```ts
new KvPersistence(db, "draft", new Y.Doc(), 100);
```

## Other tabs

A persistence loads once, when you construct it. It does not see updates other tabs write later, so add a Yjs provider that syncs open tabs.

## Limits

A failed write rejects the `flush()` or `destroy()` that waits for it.

```ts
const n = "x".repeat(9000);
await new KvPersistence(db, n, new Y.Doc()).whenSynced;
// throws ConstraintError, a key is at most 8 KiB in kv
doc.getText("t").insert(0, "x".repeat(9 << 20));
await persistence.flush();
// throws ConstraintError, an update is at most 8 MiB
```

## Deleting a document

```ts
await persistence.clearData(); // destroys it, then removes every stored update of this doc
```

Other documents in the db are untouched. Updates the doc receives after `clearData` are not stored.

## Flush and destroy

```ts
await persistence.flush(); // every update written so far is acked
await persistence.destroy(); // detaches from doc, then flushes
```

## Sharing a database

Many documents can share one db, and every key starts with the byte `y`. No persistence closes the db. Close it after you destroy every persistence on it.

## Benchmarks

`pnpm bench yjs/` compares it with y-indexeddb. See [bench/README.md](../../bench/README.md).
