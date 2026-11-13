# @opfs-lsm/yjs

A Yjs provider on [`@opfs-lsm/kv`](../kv/README.md), shaped like y-indexeddb's `IndexeddbPersistence`.

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
await persistence.whenSynced; // resolves with persistence
persistence.synced; // => true
```

## Sharing a database

Many documents share one kv db. Every key starts with the byte `y`, so other layers can use the db too.

```ts
const a = new KvPersistence(db, "a", new Y.Doc());
const ab = new KvPersistence(db, "a/b", new Y.Doc());
a.doc.getText("t").insert(0, "hello");
ab.doc.getText("t").insert(0, "other");
await Promise.all([a.destroy(), ab.destroy()]);

const again = new KvPersistence(db, "a", new Y.Doc());
await again.whenSynced;
// "a" never loads the updates of "a/b"
again.doc.getText("t").toString(); // => "hello"
await again.destroy();
```

## Flush and destroy

```ts
const memo = new Y.Doc();
const p = new KvPersistence(db, "memo", memo);
memo.getText("t").insert(0, "kept");
await p.flush(); // every update written so far is acked
await p.destroy(); // detaches from memo, then flushes
memo.getText("t").insert(0, "lost "); // not stored
// memo.destroy() destroys the persistence too
```

## Merging

Each local update is one kv entry. A load that finds 500 entries or more merges them into one. The fourth argument sets that threshold.

```ts
new KvPersistence(db, "draft", new Y.Doc(), 100);
```

## Other tabs

A persistence loads once, when you construct it. Updates another tab writes later reach only a persistence you construct after them.

```ts
// Tab A
doc.getText("t").insert(0, "hi");
await persistence.flush();

// Tab B, where persistence loaded before A wrote
doc.getText("t").toString(); // => ""
await db.sync();
const later = new KvPersistence(db, "note-1", new Y.Doc());
await later.whenSynced;
later.doc.getText("t").toString(); // => "hi"
```

To keep open tabs in step, add a Yjs provider that syncs them. kv's [Other tabs](../kv/README.md#other-tabs) explains `sync`.

## Limits

A failed write rejects the `flush()` or `destroy()` that waits for it.

```ts
new KvPersistence(db, "x".repeat(70_000), new Y.Doc());
// throws Error, a name is at most 65,535 UTF-8 bytes
const n = "x".repeat(9000);
await new KvPersistence(db, n, new Y.Doc()).whenSynced;
// throws ConstraintError, a key is at most 8 KiB in kv
doc.getText("t").insert(0, "x".repeat(9 << 20));
await persistence.flush();
// throws ConstraintError, an update is at most 8 MiB
```

## Closing

No persistence closes the db. Close it after you destroy every persistence on it.

```ts
await persistence.destroy();
await db.close();
```

## Benchmarks

`pnpm bench yjs/` compares it with y-indexeddb. See [bench/README.md](../../bench/README.md).
