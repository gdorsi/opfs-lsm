import { openHarnessCollectionDb } from "../src/testing.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@opfs-lsm/kv";
import { __resetMemoryFsForTests } from "@opfs-lsm/kv/testing";
import { Table, type CollectionDb, type TableSchema } from "../src/index.js";

const NAME = "index-ops-test";
let open: CollectionDb | undefined;


beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
});

afterEach(async () => {
  await open?.close().catch(() => undefined);
  open = undefined;
  __resetMemoryFsForTests(NAME);
});

type Note = { id: string; title: string; rank: number; tags: string[]; done?: boolean };

const SCHEMA: TableSchema = {
  name: "notes",
  indexes: [
    { name: "byRank", path: "rank" },
    { name: "byTag", path: "tags", multiEntry: true },
  ],
  search: { path: "title", sortBy: "rank" },
};

/** A table whose kv writes are counted, so a test can assert what a put really costs. */
async function countedNotes() {
  open = await openHarnessCollectionDb({ name: NAME, forceMemory: true, schema: { tables: [SCHEMA] } });
  const ops = { puts: 0, deletes: 0 };
  const counted = Object.create(open.kv) as Db;
  const count = (tx: Parameters<Parameters<Db["update"]>[1]>[1]) => ({
    put: (k: Uint8Array, v: Uint8Array) => {
      ops.puts += 1;
      tx.put(k, v);
    },
    delete: (k: Uint8Array) => {
      ops.deletes += 1;
      tx.delete(k);
    },
  });
  counted.update = ((keys, body) => open!.kv.update(keys, (values, tx) => body(values, count(tx)))) as Db["update"];
  const table = new Table<Note>(counted, SCHEMA);
  return {
    table,
    ops,
    reset: () => {
      ops.puts = 0;
      ops.deletes = 0;
    },
  };
}

const NOTE: Note = { id: "a", title: "buy milk", rank: 1, tags: ["x", "y", "z"] };

describe("index maintenance cost", () => {
  it("writes the row, one key per index entry and the search key for a new row", async () => {
    const { table, ops } = await countedNotes();
    await table.put(NOTE);
    expect(ops).toEqual({ puts: 1 + 1 + 3 + 1, deletes: 0 });
  });

  it("writes only the row when put again unchanged", async () => {
    const { table, ops, reset } = await countedNotes();
    await table.put(NOTE);
    reset();
    await table.put({ ...NOTE });
    expect(ops).toEqual({ puts: 1, deletes: 0 });
  });

  it("writes only the entries that changed when a row is put again", async () => {
    const { table, ops, reset } = await countedNotes();
    await table.put(NOTE);
    reset();
    await table.put({ ...NOTE, tags: ["x", "y", "w"] });
    expect(ops).toEqual({ puts: 2, deletes: 1 });
    reset();
    await table.put({ ...NOTE, tags: ["x", "y", "w"], title: "buy oat milk" });
    expect(ops).toEqual({ puts: 2, deletes: 0 });
    reset();
    await table.put({ ...NOTE, tags: ["x", "y", "w"], title: "buy oat milk", rank: 2 });
    expect(ops).toEqual({ puts: 1 + 1 + 1, deletes: 1 + 1 });
  });

  it("matches what update writes for the same change", async () => {
    const { table, ops, reset } = await countedNotes();
    await table.put(NOTE);
    reset();
    await table.update("a", (d) => ({ ...d, tags: ["x", "y", "w"] }));
    expect(ops).toEqual({ puts: 2, deletes: 1 });
    reset();
    await table.update("a", (d) => ({ ...d, done: true }));
    expect(ops).toEqual({ puts: 1, deletes: 0 });
  });

  it("deletes the row and every entry it wrote", async () => {
    const { table, ops, reset } = await countedNotes();
    await table.put(NOTE);
    reset();
    await table.delete("a");
    expect(ops).toEqual({ puts: 0, deletes: 1 + 1 + 3 + 1 });
  });

  it("keeps the entries of every row of a batch that mixes new and changed rows", async () => {
    const { table } = await countedNotes();
    await table.putMany([NOTE, { id: "b", title: "buy bread", rank: 2, tags: ["y"] }]);
    await table.putMany([
      { ...NOTE, tags: ["x"] },
      { id: "b", title: "buy bread", rank: 2, tags: ["y"] },
      { id: "c", title: "buy tea", rank: 3, tags: ["x", "y"] },
    ]);
    expect((await table.where("byTag", "x")).map((d) => d.id).sort()).toEqual(["a", "c"]);
    expect((await table.where("byTag", "y")).map((d) => d.id).sort()).toEqual(["b", "c"]);
    expect((await table.where("byTag", "z"))).toEqual([]);
    expect((await table.search("buy", { limit: 10 })).docs.map((d) => d.id)).toEqual(["a", "b", "c"]);
  });
});
