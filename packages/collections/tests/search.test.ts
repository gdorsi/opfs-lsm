import { openHarnessCollectionDb } from "../src/testing.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prefixBound } from "@opfs-lsm/kv";
import { __resetMemoryFsForTests } from "@opfs-lsm/kv/testing";
import { searchPrefix, type CollectionDb } from "../src/index.js";

const NAME = "search-test";
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
  __resetMemoryFsForTests(NAME);
  await wipe();
});

afterEach(async () => {
  await open?.close().catch(() => undefined);
  open = undefined;
  __resetMemoryFsForTests(NAME);
});

type Note = { id: string; title?: string; rank?: number; done?: boolean };

async function notes() {
  open = await openHarnessCollectionDb({
    name: NAME,
    forceMemory: true,
    schema: {
      tables: [
        {
          name: "notes",
          indexes: [{ name: "byRank", path: "rank" }],
          search: { path: "title", sortBy: "rank" },
        },
        { name: "plain" },
      ],
    },
  });
  return open.table<Note>("notes");
}

/** How many search-document keys the table holds, read straight from kv. */
async function searchRows(): Promise<number> {
  const bound = prefixBound(searchPrefix("notes"));
  let n = 0;
  for await (const _ of open!.kv.range({ start: bound.start, ...(bound.endExclusive ? { endExclusive: bound.endExclusive } : {}) })) n += 1;
  return n;
}

const ids = (docs: readonly Note[]) => docs.map((d) => d.id);

describe("table search", () => {
  it("matches a word that starts with the text, in sortBy order", async () => {
    const t = await notes();
    await t.putMany([
      { id: "a", title: "Buy milk and bread", rank: 3 },
      { id: "b", title: "Milkshake recipe", rank: 1 },
      { id: "c", title: "Call mom", rank: 2 },
      { id: "d", title: "Almond milk", rank: 4 },
    ]);
    expect(ids((await t.search("mil", { limit: 10 })).docs)).toEqual(["b", "a", "d"]);
    // a prefix must start a word: "ilk" is inside "milk", not a word start
    expect((await t.search("ilk", { limit: 10 })).docs).toEqual([]);
  });

  it("ignores case and punctuation", async () => {
    const t = await notes();
    await t.putMany([
      { id: "a", title: "Don't FORGET: pay-rent!", rank: 1 },
      { id: "b", title: "forgetful umbrella", rank: 2 },
    ]);
    expect(ids((await t.search("FORGET", { limit: 10 })).docs)).toEqual(["a", "b"]);
    expect(ids((await t.search("pay rent", { limit: 10 })).docs)).toEqual(["a"]);
    expect(ids((await t.search("  pay,rent ", { limit: 10 })).docs)).toEqual(["a"]);
  });

  it("requires every word of the text (AND)", async () => {
    const t = await notes();
    await t.putMany([
      { id: "a", title: "red apple pie", rank: 1 },
      { id: "b", title: "green apple", rank: 2 },
      { id: "c", title: "red pepper", rank: 3 },
    ]);
    expect(ids((await t.search("red app", { limit: 10 })).docs)).toEqual(["a"]);
    expect(ids((await t.search("app", { limit: 10 })).docs)).toEqual(["a", "b"]);
    expect((await t.search("red apple banana", { limit: 10 })).docs).toEqual([]);
  });

  it("pages with next and after", async () => {
    const t = await notes();
    await t.putMany(Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, title: i % 3 === 0 ? "other" : "milk", rank: i })));
    const seen: string[] = [];
    let after: Uint8Array | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await t.search("milk", { limit: 4, ...(after ? { after } : {}) });
      seen.push(...ids(page.docs));
      if (page.next === undefined) break;
      after = page.next;
    }
    expect(seen).toEqual(["n1", "n2", "n4", "n5", "n7", "n8"]);
    const first = await t.search("milk", { limit: 4 });
    expect(first.docs).toHaveLength(4);
    expect(first.next).toBeDefined();
    expect((await t.search("milk", { limit: 6 })).next).toBeUndefined();
  });

  it("follows an update of the text and of the sort field", async () => {
    const t = await notes();
    await t.put({ id: "a", title: "milk", rank: 5 });
    await t.put({ id: "b", title: "milk", rank: 6 });
    await t.update("a", (d) => ({ ...d, title: "bread" }));
    expect(ids((await t.search("milk", { limit: 10 })).docs)).toEqual(["b"]);
    expect(ids((await t.search("bread", { limit: 10 })).docs)).toEqual(["a"]);
    await t.update("b", (d) => ({ ...d, rank: 1 }));
    await t.put({ id: "c", title: "milk", rank: 3 });
    expect(ids((await t.search("milk", { limit: 10 })).docs)).toEqual(["b", "c"]);
    expect(await searchRows()).toBe(3); // the move left no stale key
    await t.update("c", (d) => ({ ...d, done: true }));
    expect(await searchRows()).toBe(3);
    expect((await t.search("milk", { limit: 10 })).docs.map((d) => d.done)).toEqual([undefined, true]);
  });

  it("follows an overwrite through put", async () => {
    const t = await notes();
    await t.put({ id: "a", title: "milk", rank: 1 });
    await t.put({ id: "a", title: "bread", rank: 2 });
    expect((await t.search("milk", { limit: 10 })).docs).toEqual([]);
    expect(ids((await t.search("bread", { limit: 10 })).docs)).toEqual(["a"]);
    expect(await searchRows()).toBe(1);
  });

  it("drops the key on delete and clear", async () => {
    const t = await notes();
    await t.putMany([
      { id: "a", title: "milk", rank: 1 },
      { id: "b", title: "milk", rank: 2 },
      { id: "c", title: "milk", rank: 3 },
    ]);
    await t.delete("a");
    expect(ids((await t.search("milk", { limit: 10 })).docs)).toEqual(["b", "c"]);
    expect(await searchRows()).toBe(2);
    expect(await t.clear()).toBe(2);
    expect(await searchRows()).toBe(0);
    expect((await t.search("milk", { limit: 10 })).docs).toEqual([]);
  });

  it("writes one search key per row and none when a field is missing", async () => {
    const t = await notes();
    await t.putMany([
      { id: "a", title: "milk", rank: 1 },
      { id: "b", rank: 2 },
      { id: "c", title: "no rank" },
    ]);
    expect(await searchRows()).toBe(1);
    expect(ids((await t.search("no", { limit: 10 })).docs)).toEqual([]);
  });

  it("sees rows before and after ingest, and rows put after it", async () => {
    const t = await notes();
    await t.putMany([
      { id: "a", title: "milk", rank: 1 },
      { id: "b", title: "milk", rank: 3 },
    ]);
    expect(ids((await t.search("milk", { limit: 10 })).docs)).toEqual(["a", "b"]);
    await open!.ingest();
    await t.put({ id: "c", title: "milk", rank: 2 });
    await t.delete("a");
    expect(ids((await t.search("milk", { limit: 10 })).docs)).toEqual(["c", "b"]);
    await open!.ingest();
    expect(ids((await t.search("milk", { limit: 10 })).docs)).toEqual(["c", "b"]);
  });

  it("needs a search spec and valid arguments", async () => {
    const t = await notes();
    await expect(open!.table("plain").search("x", { limit: 1 })).rejects.toThrow(/no search spec/);
    await expect(t.search("milk", { limit: 0 })).rejects.toThrow(RangeError);
    await expect(t.search("  !! ", { limit: 1 })).rejects.toThrow(/no words/);
  });
});
