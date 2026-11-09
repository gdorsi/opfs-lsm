# @opfs-lsm/yjs

`KvPersistence` is a Yjs provider on `@opfs-lsm/kv` with the shape of y-indexeddb's `IndexeddbPersistence`.

```ts
import { openDb } from "@opfs-lsm/kv";
import { KvPersistence } from "@opfs-lsm/yjs";
import * as Y from "yjs";

const db = await openDb({ name: "notes" });
const doc = new Y.Doc();
const persistence = new KvPersistence(db, "note-1", doc);
await persistence.whenSynced;
```

Many documents share one kv db, and the caller owns it and closes it. Each local update is one `put`, a load is one range scan, and a load that finds 500 updates or more (the fourth constructor argument) merges them into one. `flush()` resolves once every update written so far is acked; `destroy()` detaches from the doc and flushes.

`pnpm bench yjs/` compares it with y-indexeddb. See [bench/README.md](../../bench/README.md).
