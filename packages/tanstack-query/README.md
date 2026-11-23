# @opfs-lsm/tanstack-query

Persister storage for [TanStack Query](https://tanstack.com/query) on [`@opfs-lsm/kv`](../kv/README.md). `kvStorage(db)` goes where TanStack's docs put `idb-keyval` or `localStorage`.

```sh
pnpm add @opfs-lsm/tanstack-query @opfs-lsm/kv @tanstack/query-async-storage-persister
```

To persist the whole client, pass it to `createAsyncStoragePersister` and use the persister with `PersistQueryClientProvider` or `persistQueryClient`.

```ts
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { openDb } from "@opfs-lsm/kv";
import { kvStorage } from "@opfs-lsm/tanstack-query";

const db = await openDb({ name: "app" });
const persister = createAsyncStoragePersister({ storage: kvStorage(db) });
```

To persist each query in its own entry, pass it to `experimental_createQueryPersister`. `kvStorage` lists its entries, so `persisterGc`, `restoreQueries` and `removeQueries` work.

```ts
import { QueryClient } from "@tanstack/query-core";
import { experimental_createQueryPersister } from "@tanstack/query-persist-client-core";

const persister = experimental_createQueryPersister({ storage: kvStorage(db) });
const queryClient = new QueryClient({
  defaultOptions: { queries: { persister: persister.persisterFn } },
});
```

## Limits

- A key is at most 8 KiB, and a key and its value together just under 8 MiB. A larger write rejects with `ConstraintError`. `createAsyncStoragePersister` hands that error to its `retry` option, such as `removeOldestQuery`.
- A key or value with a lone surrogate rejects, because it cannot round-trip through UTF-8.
