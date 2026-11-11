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

To read rows and write the result with nothing landing in between, from this tab or another, use `utils.transact`. `merge` gets the stored rows in the order of the keys, `undefined` for a missing one, and returns one entry per key: a row to put, `null` to delete, or `undefined` to leave it. It is one kv `update`, and the promise resolves once the collection shows the write. An eager collection always shows it. An on-demand collection shows it only for keys a loaded plan covers; a write to any other key persists but stays out of memory. A `merge` that throws, returns the wrong number of entries, or returns a row under another key writes nothing.

```ts
await todos.utils.transact(["1"], ([todo]) => [todo ? { ...todo, done: !todo.done } : undefined]);
```

The collection loads every row on start (eager sync). A load is one range scan of the collection's keys. After that, kv's change feed carries other tabs' writes with their values, so the adapter reads nothing to apply them. A tab that fell behind a flush reads the collection again.

Rows a screen needs only now and then can stay out of memory. With `onDemand`, the collection holds only what live queries ask for. `plan` turns a query's subset into the rows to read, some keys or every string key with a prefix, and the adapter reads them in one kv view:

```ts
import { createLiveQueryCollection, eq, parseLoadSubsetOptions } from "@tanstack/db";

type Comment = { key: string; issueId: string; body: string }; // key is `${issueId}/${id}`

const comments = createCollection(
  kvCollectionOptions({
    db,
    name: "comments",
    getKey: (c: Comment) => c.key,
    onDemand: {
      plan(options) {
        const issue = parseLoadSubsetOptions(options).filters.find((f) => f.field[0] === "issueId" && f.operator === "eq");
        if (!issue) throw new Error("load comments by issueId");
        return { prefix: `${issue.value}/` };
      },
    },
  }),
);

const thread = createLiveQueryCollection((q) => q.from({ c: comments }).where(({ c }) => eq(c.issueId, "42")));
```

A row stays in memory while some loaded plan covers it and follows other tabs' writes; writes to rows no plan covers are skipped. When the last live query on a plan goes away, its rows leave memory. A plan that throws loads nothing, and the live query stays `loading`.

Rows are stored as JSON. Pass `codec` with `encode(row): Uint8Array` and `decode(bytes)` to store what JSON drops, such as `Date` or `Map`. Keys are strings or numbers, and the number `1` and the string `"1"` are different keys.
