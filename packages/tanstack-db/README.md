# @opfs-lsm/tanstack-db

`kvCollectionOptions` keeps a TanStack DB collection in `@opfs-lsm/kv`, and every tab that opens the same db sees the others' writes live.

```ts
import { openDb } from "@opfs-lsm/kv";
import { kvCollectionOptions } from "@opfs-lsm/tanstack-db";
import { createCollection } from "@tanstack/db";

type Todo = { id: string; title: string; done: boolean };

const db = await openDb({ name: "app" });
const todos = createCollection(kvCollectionOptions({ db, name: "todos", getKey: (t: Todo) => t.id }));

todos.insert({ id: "1", title: "milk", done: false });
```

Many collections share one kv db under their `name`, and the caller owns the db and closes it. Closing it stops every collection on it: their rows stay, `collection.health.error` holds the cause, and later writes reject and roll back.

The adapter persists every insert, update and delete itself, so the config takes no `onInsert`, `onUpdate` or `onDelete`. A collection's mutations in one TanStack transaction are one kv batch, and other tabs receive them as one change. For a manual transaction, call `utils.acceptMutations` from each collection it touches:

```ts
import { createTransaction } from "@tanstack/db";

const tx = createTransaction({ mutationFn: ({ transaction }) => todos.utils.acceptMutations(transaction) });
tx.mutate(() => {
  todos.insert({ id: "2", title: "eggs", done: false });
  todos.update("1", (draft) => {
    draft.done = true;
  });
});
await tx.when("settled");
```

The collection loads every row on start (eager sync). A load is one range scan of the collection's keys. After that, kv's change feed carries other tabs' writes with their values, so the adapter reads nothing to apply them. A tab that fell behind a flush reads the collection again.

Rows are stored as JSON. Pass `codec` with `encode(row): Uint8Array` and `decode(bytes)` to store what JSON drops, such as `Date` or `Map`. Keys are strings or numbers, and the number `1` and the string `"1"` are different keys.
