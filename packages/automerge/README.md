# @opfs-lsm/automerge

`kvStorage(db)` is an automerge-repo `StorageAdapterInterface` on `@opfs-lsm/kv`.

```ts
import { Repo } from "@automerge/automerge-repo";
import { kvStorage } from "@opfs-lsm/automerge";
import { openDb } from "@opfs-lsm/kv";

const db = await openDb({ name: "automerge" });
const repo = new Repo({ storage: kvStorage(db) });
```

Pass a db whose `openDb` has resolved. The adapter owns it afterwards, and its `close` closes the db. Each storage key segment is framed as a u16 length and its UTF-8 bytes, so `loadRange` and `removeRange` are one prefix scan. `encodeKey` and `decodeKey` are exported for tools that read the keys directly.

`pnpm bench automerge/` compares it with automerge-repo's `IndexedDBStorageAdapter`. See [bench/README.md](../../bench/README.md).
