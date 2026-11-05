import { openHarnessCollectionDb } from "../src/testing.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prefixBound } from "@opfs-lsm/kv";
import { __resetMemoryFsForTests } from "@opfs-lsm/kv/testing";
import { indexPrefix, MAX_INDEX_KEYS_PER_ROW, type CollectionDb } from "../src/index.js";

const NAME = "multi-entry-test";
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

type Note = { id: string; terms: string[]; createdAt: number; title?: string };

async function notes() {
  open = await openHarnessCollectionDb({
    name: NAME,
    forceMemory: true,
    schema: {
      tables: [
        {
          name: "notes",
          indexes: [
            { name: "byTerm", path: "terms", multiEntry: true },
            { name: "byTermNewest", path: ["terms", "createdAt"], multiEntry: true },
            { name: "byTitle", path: "title" },
          ],
        },
      ],
    },
  });
  return open.table<Note>("notes");
}

/** Every index key the table holds for `index`, read straight from kv. */
async function indexRows(index: string): Promise<number> {
  const bound = prefixBound(indexPrefix("notes", index));
  let n = 0;
  for await (const _ of open!.kv.range({ start: bound.start, ...(bound.endExclusive ? { endExclusive: bound.endExclusive } : {}) })) n += 1;
  return n;
}

const ids = (docs: readonly Note[]) => docs.map((d) => d.id).sort();

describe("multi-entry index", () => {
  it("keys a row once per distinct element", async () => {
    const t = await notes();
    await t.putMany([
      { id: "a", terms: ["milk", "eggs", "milk"], createdAt: 1 },
      { id: "b", terms: ["eggs"], createdAt: 2 },
      { id: "c", terms: [], createdAt: 3 },
    ]);
    expect(ids(await t.where("byTerm", "milk"))).toEqual(["a"]);
    expect(ids(await t.where("byTerm", "eggs"))).toEqual(["a", "b"]);
    expect(await t.where("byTerm", "bread")).toEqual([]);
    expect(await indexRows("byTerm")).toBe(3);
  });

  it("pages one element's rows in the next path's order", async () => {
    const t = await notes();
    const docs = Array.from({ length: 25 }, (_, i): Note => ({
      id: `n${i}`,
      terms: i % 2 === 0 ? ["milk", `w${i}`] : ["eggs"],
      createdAt: 100 - i,
    }));
    await t.putMany(docs);
    const seen: string[] = [];
    let after: Uint8Array | undefined;
    do {
      const page = await t.page("byTermNewest", { value: "milk", limit: 4, ...(after ? { after } : {}) });
      seen.push(...page.docs.map((d) => d.id));
      after = page.next;
    } while (after);
    const want = docs.filter((d) => d.terms.includes("milk")).sort((a, b) => a.createdAt - b.createdAt);
    expect(seen).toEqual(want.map((d) => d.id));
    expect((await t.page("byTermNewest", { value: "bread", limit: 4 })).docs).toEqual([]);
  });

  it("rewrites only the keys an update changes, and delete removes them all", async () => {
    const t = await notes();
    await t.put({ id: "a", terms: ["milk", "eggs"], createdAt: 1 });
    await t.update("a", (d) => ({ ...d, terms: ["eggs", "bread"] }));
    expect(await t.where("byTerm", "milk")).toEqual([]);
    expect(ids(await t.where("byTerm", "bread"))).toEqual(["a"]);
    expect(ids(await t.where("byTerm", "eggs"))).toEqual(["a"]);
    await t.put({ id: "a", terms: ["jam"], createdAt: 1 });
    expect(await t.where("byTerm", "eggs")).toEqual([]);
    expect(await indexRows("byTerm")).toBe(1);
    await t.delete("a");
    expect(await indexRows("byTerm")).toBe(0);
    expect(await indexRows("byTermNewest")).toBe(0);
  });

  it("counts distinct elements toward the key limit", async () => {
    const t = await notes();
    await t.put({ id: "a", terms: Array.from({ length: MAX_INDEX_KEYS_PER_ROW + 1 }, () => "milk"), createdAt: 1 });
    expect(ids(await t.where("byTerm", "milk"))).toEqual(["a"]);
  });

  it("skips an index whose other path is missing", async () => {
    const t = await notes();
    await t.put({ id: "a", terms: ["milk"] } as unknown as Note);
    expect(ids(await t.where("byTerm", "milk"))).toEqual(["a"]);
    expect(await indexRows("byTermNewest")).toBe(0);
  });

  it("rejects an array on an index that isn't multi-entry", async () => {
    const t = await notes();
    await expect(t.put({ id: "a", terms: [], createdAt: 1, title: ["x"] as unknown as string })).rejects.toThrow(TypeError);
  });

  it("rejects a row that would produce too many keys", async () => {
    const t = await notes();
    const terms = Array.from({ length: MAX_INDEX_KEYS_PER_ROW + 1 }, (_, i) => `t${i}`);
    await expect(t.put({ id: "a", terms, createdAt: 1 })).rejects.toThrow(RangeError);
    expect(await t.get("a")).toBeUndefined();
  });
});
