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

Content the doc already holds when you construct the persistence is stored too, as one entry. That includes a pending update, one that arrived before the update it builds on. Yjs fires no update event for an update that goes pending later, so `destroy()` stores it, and a crash before `destroy()` loses it.

## Merging

Each update is one kv entry, and a load replays every entry of its doc. A persistence counts the entries it loaded and the ones it wrote since. Once that count reaches 500 and the doc has had no update for a second, every entry of the doc is merged into one. Entries another tab writes do not count, so two tabs that each stay under 500 leave their entries to the next load, which finds 500 or more and merges. Loading never waits on a merge. The fourth argument sets the threshold, and `trimDelayMs` the wait.

```ts
const p = new KvPersistence(db, "draft", new Y.Doc(), 100);
p.trimDelayMs = 5000;
```

A merge reads every entry of the doc first, other tabs' included, and applies them to the doc, as y-indexeddb does. A doc whose merged state does not fit in one kv batch (8 MiB, counting keys and 256 bytes per op) is not merged, so each of its loads replays every entry.

## Other tabs

A persistence loads once, when you construct it. Other tabs' later updates reach the doc only when a merge reads them, so add a Yjs provider that syncs open tabs.

## Limits

A document name with a lone surrogate makes the constructor throw `Error`, since it cannot round-trip through UTF-8.

```ts
const n = "x".repeat(9000);
await new KvPersistence(db, n, new Y.Doc()).whenSynced;
// throws ConstraintError, a key is at most 8 KiB in kv
doc.getText("t").insert(0, "x".repeat(9 << 20));
await persistence.flush();
// throws ConstraintError, an update with its key and 256 bytes is at most 8 MiB
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

If a write failed, the next `flush()` or `destroy()` puts that update again. It rejects if that put fails too, and the next call retries. A failed update stays in memory until a put of it lands.

## Sharing a database

Many documents can share one db, and every key starts with the byte `y`. No persistence closes the db. Close it after you destroy every persistence on it.

## Benchmarks

`pnpm bench yjs/` compares it with y-indexeddb. See [bench/README.md](../../bench/README.md).
