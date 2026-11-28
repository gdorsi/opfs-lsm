import { describe, expect, it } from "vitest";
import { collection, query } from "../src/index.js";
import { openMemoryDatabase } from "../src/testing.js";
import { freshName, until, watch } from "./harness.js";

type Todo = { id: string; title: string };

describe("openMemoryDatabase", () => {
  it("opens a database without a browser, and two opens of one name share the data as two tabs do", async () => {
    const options = { name: freshName(), version: 1, collections: { todos: collection<Todo>() } };
    const here = await openMemoryDatabase(options);
    const there = await openMemoryDatabase(options);
    const seen = watch(query((q) => q.from({ t: here.collections.todos })));
    await until(() => seen.values.length === 1);

    await there.collections.todos.insert({ id: "t1", title: "Buy milk" });
    await until(() => seen.values.length === 2);
    expect(seen.values[1]).toEqual([{ id: "t1", title: "Buy milk" }]);

    await here.close();
    await there.close();
    const other = await openMemoryDatabase({ ...options, name: freshName() });
    expect(await other.collections.todos.get("t1")).toBeUndefined();
    await other.close();
  });

  it("rejects with a StorageError for a name the storage refuses", async () => {
    const options = { version: 1, collections: { todos: collection<Todo>() } };
    await expect(openMemoryDatabase({ ...options, name: "not a name" })).rejects.toMatchObject({ _tag: "StorageError", code: "limit" });
  });
});
