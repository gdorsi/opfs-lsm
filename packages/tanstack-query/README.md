# @opfs-lsm/tanstack-query

Persists the [TanStack Query](https://tanstack.com/query) cache in [`@opfs-lsm/kv`](../kv/README.md), one kv entry per query. `createQueryPersister(db)` returns TanStack's per-query persister, built by `experimental_createQueryPersister` with kv as its storage.

```sh
pnpm add @opfs-lsm/tanstack-query @opfs-lsm/kv @tanstack/query-persist-client-core
```

Pass `persisterFn` as the default `persister` of your queries. A query with no data in memory reads its entry from kv before it calls `queryFn`, and writes its result back after.

```ts
import { QueryClient } from "@tanstack/query-core";
import { openDb } from "@opfs-lsm/kv";
import { createQueryPersister } from "@opfs-lsm/tanstack-query";

const db = await openDb({ name: "app" });
const persister = createQueryPersister(db);
const queryClient = new QueryClient({
  defaultOptions: { queries: { persister: persister.persisterFn } },
});
```

The persister also has `restoreQueries` to load the persisted queries into a client at startup, `removeQueries` to delete them, and `persisterGc` to delete expired or busted entries. The options are those of `experimental_createQueryPersister` without `storage`, such as `buster`, `maxAge`, `prefix` and `filters`.

The whole-client persister, `createAsyncStoragePersister`, is not supported. It saves the whole cache as one value, and kv rejects a value over 8 MiB. `createAsyncStoragePersister` drops that error unless the app passes `retry`, so a cache that grows past the limit stops being saved and nothing reports it.

## Limits

- A query whose storage key, `prefix` plus query hash, is over about 8 KiB, or whose serialized entry is over about 8 MiB, rejects with `ConstraintError`. `persistQuery` and `persistQueryByKey` reject to the caller. `persisterFn` writes in the background, so there the error is an unhandled rejection and the query still resolves with its data. A key over 8 KiB is never found, so `persisterFn` calls `queryFn` every time.
- A storage key or serialized entry with a lone surrogate rejects, because it cannot round-trip through UTF-8. The default `JSON.stringify` escapes lone surrogates, so only a custom `serialize` or `prefix` can produce one.
