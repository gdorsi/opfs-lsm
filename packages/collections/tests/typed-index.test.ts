import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetMemoryFsForTests } from "@opfs-lsm/kv";
import {
  decodeOrderFloat64,
  encodeOrderFloat64,
  extractIndexRowId,
  indexKey,
  openCollectionDb,
  type CollectionDb,
} from "../src/index.js";

const NAME = "typed-index-test";
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

describe("order-preserving float64", () => {
  it("sorts like numeric order", () => {
    const nums = [-100, -0.5, 0, 0.5, 1, 100, Number.MAX_SAFE_INTEGER];
    const encoded = nums.map((n) => ({ n, b: encodeOrderFloat64(n) }));
    encoded.sort((a, b) => {
      for (let i = 0; i < 8; i++) {
        const d = (a.b[i] ?? 0) - (b.b[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    });
    expect(encoded.map((e) => e.n)).toEqual(nums);
    for (const e of encoded) {
      expect(decodeOrderFloat64(e.b)).toBe(e.n);
    }
  });
});

describe("typed + compound indexes", () => {
  it("indexes numbers and booleans", async () => {
    type Row = { id: string; age: number; active: boolean };
    open = await openCollectionDb({
      name: NAME,
      forceMemory: true,
      schema: {
        tables: [
          {
            name: "people",
            indexes: [
              { name: "age", path: "age" },
              { name: "active", path: "active" },
            ],
          },
        ],
      },
    });
    const people = open.table<Row>("people");
    await people.put({ id: "a", age: 30, active: true });
    await people.put({ id: "b", age: 20, active: false });
    await people.put({ id: "c", age: 30, active: true });

    expect((await people.where("age", 30)).map((r) => r.id).sort()).toEqual([
      "a",
      "c",
    ]);
    expect((await people.where("active", false)).map((r) => r.id)).toEqual([
      "b",
    ]);
  });

  it("supports compound indexes and prefix where", async () => {
    type Note = { id: string; orgId: string; createdAt: number; title: string };
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
    await notes.put({
      id: "1",
      orgId: "acme",
      createdAt: 100,
      title: "a",
    });
    await notes.put({
      id: "2",
      orgId: "acme",
      createdAt: 200,
      title: "b",
    });
    await notes.put({
      id: "3",
      orgId: "other",
      createdAt: 100,
      title: "c",
    });

    const acme = await notes.where("byOrgCreated", "acme");
    expect(acme.map((n) => n.id).sort()).toEqual(["1", "2"]);

    const exact = await notes.where("byOrgCreated", ["acme", 200]);
    expect(exact.map((n) => n.id)).toEqual(["2"]);
  });

  it("extractIndexRowId walks typed arity", () => {
    const key = indexKey("notes", "byOrgCreated", ["acme", 200], "42");
    expect(extractIndexRowId(key, 2)).toBe("42");
  });
});
