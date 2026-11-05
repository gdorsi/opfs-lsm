import { openHarnessCollectionDb } from "../src/testing.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetMemoryFsForTests } from "@opfs-lsm/kv/testing";
import { type CollectionDb } from "../src/index.js";

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
    open = await openHarnessCollectionDb({
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
    open = await openHarnessCollectionDb({
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

  it("orders strings lexicographically, not by length", async () => {
    open = await openHarnessCollectionDb({
      name: NAME,
      forceMemory: true,
      schema: {
        tables: [
          {
            name: "notes",
            indexes: [{ name: "byTitle", path: "title" }],
          },
        ],
      },
    });
    const notes = open.table<Note>("notes");
    for (const [id, title] of [
      ["1", "b"],
      ["2", "aa"],
      ["3", "a"],
      ["4", "ab"],
      ["5", "a/b"],
      ["6", "a\u0000b"],
    ] as const) {
      await notes.put({ id, orgId: "x", createdAt: 0, title });
    }

    expect((await notes.orderBy("byTitle")).map((n) => n.title)).toEqual([
      "a",
      "a\u0000b",
      "a/b",
      "aa",
      "ab",
      "b",
    ]);
    expect(
      (await notes.orderBy("byTitle", { from: "a/b" })).map((n) => n.title),
    ).toEqual(["a/b", "aa", "ab", "b"]);

    const first = await notes.page("byTitle", { limit: 3 });
    expect(first.docs.map((n) => n.title)).toEqual(["a", "a\u0000b", "a/b"]);
    expect(first.next).toBeDefined();
    const second = await notes.page("byTitle", {
      after: first.next,
      limit: 3,
    });
    expect(second.docs.map((n) => n.title)).toEqual(["aa", "ab", "b"]);
    expect(second.next).toBeUndefined();
  });

  it("pages an index with an opaque cursor", async () => {
    open = await openHarnessCollectionDb({
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
    await notes.putMany([
      { id: "a", orgId: "x", createdAt: 30, title: "c" },
      { id: "b", orgId: "x", createdAt: 10, title: "a" },
      { id: "c", orgId: "x", createdAt: 20, title: "b" },
      { id: "d", orgId: "x", createdAt: 40, title: "d" },
    ]);

    const first = await notes.page("byCreated", { limit: 2 });
    expect(first.docs.map((n) => n.id)).toEqual(["b", "c"]);
    expect(first.next).toBeDefined();

    const second = await notes.page("byCreated", {
      after: first.next,
      limit: 2,
    });
    expect(second.docs.map((n) => n.id)).toEqual(["a", "d"]);
    expect(second.next).toBeUndefined();
  });
});
