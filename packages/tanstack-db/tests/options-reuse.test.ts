import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { collection, defineSchema, openDocStore } from "@opfs-lsm/docstore";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { createCollection, createTransaction } from "@tanstack/db";
import { docstoreCollectionOptions } from "../src/index.ts";

type Todo = { id: string; title: string };

const schema = defineSchema({ version: 1, collections: { todos: collection<Todo>() } });

for (const syncMode of ["eager", "on-demand"] as const) {
  test(`two ${syncMode} collections created from one options object each store their own writes`, async () => {
    const kv = await openHarnessDb({ name: `tsdb${randomUUID().slice(0, 8)}`, forceMemory: true, maxWalBytes: 1 << 30 });
    try {
      const todos = (await openDocStore(kv, schema)).collection("todos");
      const options = docstoreCollectionOptions({ collection: todos, syncMode });
      const first = createCollection(options);
      const second = createCollection(options);
      if (syncMode === "eager") await Promise.all([first.preload(), second.preload()]);
      else for (const c of [first, second]) c.startSyncImmediate();

      await first.insert({ id: "a", title: "from first" }).when("settled");
      await second.insert({ id: "b", title: "from second" }).when("settled");
      const tx = createTransaction({ mutationFn: ({ transaction }) => first.utils.acceptMutations(transaction) });
      tx.mutate(() => first.insert({ id: "c", title: "manual" }));
      await tx.when("settled");

      assert.deepEqual(await todos.getMany(["a", "b", "c"]), [
        { id: "a", title: "from first" },
        { id: "b", title: "from second" },
        { id: "c", title: "manual" },
      ]);
      await Promise.all([first.cleanup(), second.cleanup()]);
    } finally {
      await kv.close();
    }
  });
}
