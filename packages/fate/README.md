# @opfs-lsm/fate

`kvStorage` is persistence storage for the fate data client (`@nkzw/fate`) on `@opfs-lsm/kv`. It takes the place of the storage in `@nkzw/fate-indexeddb`.

```ts
import { createClient } from "@nkzw/fate";
import { createPersistence } from "@nkzw/fate/persistence";
import { openDb } from "@opfs-lsm/kv";
import { kvStorage } from "@opfs-lsm/fate";

const db = await openDb({ name: "app" });
const persistence = createPersistence({ key: "account:1", storage: kvStorage(db) });
const client = createClient({ persistence, roots, transport, types });
```

The caller owns the db and closes it. Many apps and adapters can share one kv db, because every key this adapter writes starts with the byte `f`. One fate entry is one kv entry, and its value is the JSON text of the fate value. A `writeBatch` is one atomic kv write, so a journal or client-state batch lands whole or not at all. fate's `exclusive` sections use Web Locks, and each lock grant first catches the handle up with writes other tabs have acked, so a read inside the section sees what the previous holder committed. `subscribe` fires on writes to that key from this tab and from other tabs.

A key over 8 KiB, or a batch over 8 MiB, is rejected with kv's `ConstraintError`, which fate reports as a storage error. A key with a lone surrogate is rejected, because it cannot round-trip through UTF-8.

Two things differ from `@nkzw/fate-indexeddb`, and fate relies on neither. `scan` returns keys in UTF-8 byte order, where IndexedDB uses UTF-16 code unit order, so a character outside the BMP sorts after U+E000 to U+FFFF here and before them there. Values go through JSON, not structured clone, so `NaN` becomes `null`, a `Date` becomes a string, and a property set to `undefined` is dropped.

`pnpm bench fate/` compares it with `@nkzw/fate-indexeddb` under one fate client. See [bench/README.md](../../bench/README.md).
