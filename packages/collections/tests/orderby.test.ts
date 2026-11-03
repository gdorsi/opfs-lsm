import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetMemoryFsForTests } from "@opfs-lsm/kv";
import { openCollectionDb, type CollectionDb } from "../src/index.js";

const NAME = "orderby-test";
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

type Note = { id: string; orgId: string; createdAt: number; title: string };

describe("orderBy", () => {
  it("returns index order and supports range + limit", async () => {
    open = await openCollectionDb({
      name: NAME,
      forceMemory: true,
      schema: {
        tables: [
          {
            name: "notes",
            indexes: [{ name: "byCreated", path: "createdAt" }],
          },
        ],
      },
    });
    const notes = open.table<Note>("notes");
    await notes.put({ id: "a", orgId: "x", createdAt: 30, title: "c" });
    await notes.put({ id: "b", orgId: "x", createdAt: 10, title: "a" });
    await notes.put({ id: "c", orgId: "x", createdAt: 20, title: "b" });

    expect((await notes.orderBy("byCreated")).map((n) => n.id)).toEqual([
      "b",
      "c",
      "a",
    ]);

    expect(
      (
        await notes.orderBy("byCreated", { from: 20, toExclusive: 30 })
      ).map((n) => n.id),
    ).toEqual(["c"]);

    expect(
      (await notes.orderBy("byCreated", { limit: 2 })).map((n) => n.id),
    ).toEqual(["b", "c"]);
  });

  it("orders compound indexes", async () => {
    open = await openCollectionDb({
      name: NAME,
      forceMemory: true,
      schema: {
        tables: [
          {
            name: "notes",
            indexes: [
              { name: "byOrgCreated", path: ["orgId", "createdAt"] },
            ],
          },
        ],
      },
    });
    const notes = open.table<Note>("notes");
    await notes.put({ id: "1", orgId: "acme", createdAt: 200, title: "a" });
    await notes.put({ id: "2", orgId: "acme", createdAt: 100, title: "b" });
    await notes.put({ id: "3", orgId: "other", createdAt: 50, title: "c" });

    expect(
      (await notes.orderBy("byOrgCreated", { from: "acme" })).map((n) => n.id),
    ).toEqual(["2", "1"]);
  });
});
