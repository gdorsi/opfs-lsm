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

Content the doc already holds when you construct the persistence is stored too, as one entry.

## Merging

Each update is one kv entry, and a load replays every entry of its doc. Once a doc has 500 entries or more and has had no update for a second, they are merged into one, whether it reached 500 at load or while open. Loading never waits on a merge. The fourth argument sets the threshold, and `trimDelayMs` the wait.

```ts
const p = new KvPersistence(db, "draft", new Y.Doc(), 100);
p.trimDelayMs = 5000;
```

A merge reads every entry of the doc first, other tabs' included, and applies them to the doc, as y-indexeddb does.

## Other tabs

A persistence loads once, when you construct it. Other tabs' later updates reach the doc only when a merge reads them, so add a Yjs provider that syncs open tabs.

## Limits

The next `flush()` or `destroy()` stores a write that failed again, as the whole doc state. It rejects when that write fails too, as the examples below do.

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

If a write failed, the next `flush()` writes the whole doc state again. It rejects if that write fails too, and the next call retries.

## Sharing a database

Many documents can share one db, and every key starts with the byte `y`. No persistence closes the db. Close it after you destroy every persistence on it.

## Benchmarks

`pnpm bench yjs/` compares it with y-indexeddb. See [bench/README.md](../../bench/README.md).
