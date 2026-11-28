import { describe, expect, it, vi } from "vitest";
import { collection, deleteDatabase, openDatabase, query } from "../src/index.js";
import { freshName, until, watch } from "./harness.js";

// Node has no OPFS, so the storage of every name lives on kv's memory file system.
vi.mock("@opfs-lsm/kv", async (importOriginal) => {
  const kv = await importOriginal<typeof import("@opfs-lsm/kv")>();
  const { destroyHarnessDb, openHarnessDb } = await import("@opfs-lsm/kv/testing");
  return {
    ...kv,
    openDb: ({ name }: { name: string }) => openHarnessDb({ name, forceMemory: true }),
    destroyDb: (name: string) => destroyHarnessDb({ name, forceMemory: true }),
  };
});

type Task = { id: string; title: string };
const options = (name: string) => ({ name, version: 1, collections: { tasks: collection<Task>() } });

describe("deleteDatabase", () => {
  it("removes every document, and ends the subscriptions of each open handle with destroyed", async () => {
    const name = freshName();
    const here = await openDatabase(options(name));
    const there = await openDatabase(options(name));
    await here.collections.tasks.insert({ id: "t1", title: "Write" });
    const seen = [here, there].map((db) => watch(query((q) => q.from({ t: db.collections.tasks }))));
    await until(() => seen.every((s) => s.values.length === 1));

    await deleteDatabase(name);
    await until(() => seen.every((s) => s.errors.length === 1));
    for (const s of seen) expect(s.errors[0]).toMatchObject({ _tag: "ClosedError", code: "destroyed" });
    await expect(here.collections.tasks.get("t1")).rejects.toMatchObject({ _tag: "ClosedError" });

    const reopened = await openDatabase(options(name));
    expect(await reopened.collections.tasks.get("t1")).toBeUndefined();
    await Promise.all([here, there, reopened].map((db) => db.close()));
  });

  it("is no error on a name with nothing stored", async () => {
    await expect(deleteDatabase(freshName())).resolves.toBeUndefined();
  });
});
