import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetMemoryFsForTests } from "@opfs-lsm/kv";
import { openCollectionDb, type CollectionDb } from "../src/index.js";
import { extractIndexRowId, indexKey } from "../src/index.js";

const NAME = "collections-test";
let open: CollectionDb | undefined;

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  if (open) {
    await open.close().catch(() => undefined);
    open = undefined;
  }
  __resetMemoryFsForTests(NAME);
  await wipe();
});

afterEach(async () => {
  if (open) {
    await open.close().catch(() => undefined);
    open = undefined;
  }
  __resetMemoryFsForTests(NAME);
});

type User = { id: string; email: string; name: string };

describe("collections", () => {
  it("put/get/delete by primary key", async () => {
    open = await openCollectionDb({
      name: NAME,
      forceMemory: true,
      schema: {
        tables: [{ name: "users", indexes: [{ name: "email", path: "email" }] }],
      },
    });
    const users = open.table<User>("users");
    await users.put({ id: "1", email: "a@x.com", name: "Ada" });
    expect(await users.get("1")).toEqual({
      id: "1",
      email: "a@x.com",
      name: "Ada",
    });
    expect(await users.delete("1")).toBe(true);
    expect(await users.get("1")).toBeUndefined();
  });

  it("where equality on string index", async () => {
    open = await openCollectionDb({
      name: NAME,
      forceMemory: true,
      schema: {
        tables: [{ name: "users", indexes: [{ name: "email", path: "email" }] }],
      },
    });
    const users = open.table<User>("users");
    await users.put({ id: "1", email: "a@x.com", name: "Ada" });
    await users.put({ id: "2", email: "b@x.com", name: "Bob" });
    await users.put({ id: "3", email: "a@x.com", name: "Also Ada" });

    const hits = await users.where("email", "a@x.com");
    expect(hits.map((u) => u.id).sort()).toEqual(["1", "3"]);
  });

  it("updates index entries when email changes", async () => {
    open = await openCollectionDb({
      name: NAME,
      forceMemory: true,
      schema: {
        tables: [{ name: "users", indexes: [{ name: "email", path: "email" }] }],
      },
    });
    const users = open.table<User>("users");
    await users.put({ id: "1", email: "old@x.com", name: "Ada" });
    await users.put({ id: "1", email: "new@x.com", name: "Ada" });

    expect(await users.where("email", "old@x.com")).toEqual([]);
    expect(await users.where("email", "new@x.com")).toEqual([
      { id: "1", email: "new@x.com", name: "Ada" },
    ]);
  });

  it("extractIndexRowId reads encoded index key", () => {
    const key = indexKey("users", "email", "a@x.com", "42");
    expect(extractIndexRowId(key, 1)).toBe("42");
  });
});
