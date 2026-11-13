import type { Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { defineSchema, openDocStore, type Query } from "../src/index.js";
import { codeOf, freshName, openKv, recording, wrap } from "./harness.js";

type Note = {
  id: string;
  title?: string | undefined;
  createdAt?: number | undefined;
  slug?: string | null | undefined;
  tags?: string[] | undefined;
  n?: number | undefined;
  body?: string | undefined;
};

const schema = defineSchema<{ notes: Note }>()({
  version: 1,
  collections: {
    notes: {
      byCreated: { on: "createdAt" },
      bySlug: { on: "slug", unique: true },
      byTag: { on: "tags", multi: true },
      byTitle: { on: "title" },
    },
  },
});

type NoteQuery = Query<Note, (typeof schema)["collections"]["notes"]>;
const everyIndex: NoteQuery[] = [{ index: "byCreated" }, { index: "bySlug" }, { index: "byTag" }, { index: "byTitle" }];

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

async function notes(name = freshName()) {
  const kv = await openKv(name);
  open.push(kv);
  return { kv, notes: (await openDocStore(kv, schema)).collection("notes") };
}

describe("index entries come from the stored form", () => {
  it("finds a document put with createdAt -0 by eq 0, and get returns 0", async () => {
    const { notes: c } = await notes();
    await c.put({ id: "1", createdAt: -0 });
    expect((await c.query({ index: "byCreated", eq: [0] })).docs.map((d) => d.id)).toEqual(["1"]);
    expect(Object.is((await c.get("1"))!.createdAt, 0)).toBe(true);
  });

  it("finds NaN and Infinity at an indexed number path by eq null, since JSON stores null", async () => {
    const { notes: c } = await notes();
    await c.putMany([
      { id: "nan", createdAt: Number.NaN },
      { id: "inf", createdAt: Number.POSITIVE_INFINITY },
      { id: "one", createdAt: 1 },
    ]);
    expect((await c.queryIds({ index: "byCreated", eq: [null as unknown as number] })).ids).toEqual(["inf", "nan"]);
  });

  it("indexes a toJSON value and a class instance by their JSON form", async () => {
    const { notes: c } = await notes();
    class Title {
      toJSON() {
        return "from toJSON";
      }
    }
    await c.put({ id: "1", title: new Title() as unknown as string });
    expect((await c.queryIds({ index: "byTitle", eq: ["from toJSON"] })).ids).toEqual(["1"]);
    expect((await c.get("1"))!.title).toBe("from toJSON");
  });

  it("gives undefined at an indexed path no entry, while the rows still hold the document", async () => {
    const { notes: c } = await notes();
    await c.putMany([{ id: "1", createdAt: undefined }, { id: "2", createdAt: 2 }]);
    expect(await c.count({ index: "byCreated" })).toBe(1);
    expect((await c.queryIds({})).ids).toEqual(["1", "2"]);
  });

  it("keeps exactly one entry while an indexed field flips between -0 and 0", async () => {
    const { notes: c } = await notes();
    for (const createdAt of [-0, 0, -0, 0]) {
      await c.put({ id: "1", createdAt });
      expect(await c.count({ index: "byCreated" })).toBe(1);
    }
  });
});

describe("putMany", () => {
  it("is atomic: a bad id, a unique conflict, or a batch over kv's limits stores none of the batch", async () => {
    const { notes: c } = await notes();
    await c.put({ id: "owner", slug: "taken" });
    expect(await codeOf(c.putMany([{ id: "a" }, { id: "" }]))).toBe("document");
    expect(await codeOf(c.putMany([{ id: "a" }, { id: "b", slug: "taken" }]))).toBe("unique");
    const body = "x".repeat(1024 * 1024);
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `big${i}`, body }));
    expect(await codeOf(c.putMany(many))).toBe("constraint");
    expect(await c.getMany(["a", "b", "big0"])).toEqual([undefined, undefined, undefined]);
    expect(await c.count({})).toBe(1);
  });

  it("stores a batch of more than 10,000 kv ops", async () => {
    const { notes: c } = await notes();
    const many = Array.from({ length: 4_000 }, (_, i) => ({ id: `n${i}`, createdAt: i, slug: `s${i}`, title: "t" }));
    await c.putMany(many);
    expect(await c.count({})).toBe(4_000);
    expect(await c.count({ index: "bySlug" })).toBe(4_000);
  });

  it("throws document for one id given twice and writes nothing", async () => {
    const { notes: c } = await notes();
    expect(await codeOf(c.putMany([{ id: "a", n: 1 }, { id: "a", n: 2 }]))).toBe("document");
    expect(await c.get("a")).toBeUndefined();
  });

  it("writes no kv op when the stored bytes would not change, reading only the catalog, the row and its unique keys", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    const { db, updates } = recording(kv);
    const c = (await openDocStore(db, schema)).collection("notes");
    await c.putMany([
      { id: "1", title: "a", createdAt: 1, tags: ["x"] },
      { id: "2", title: "b", slug: "s" },
    ]);
    updates.length = 0;
    await c.put({ id: "1", title: "a", createdAt: 1, tags: ["x"] });
    await c.put({ id: "2", title: "b", slug: "s" });
    expect(updates).toEqual([
      { reads: 2, puts: 0, deletes: 0 },
      { reads: 3, puts: 0, deletes: 0 },
    ]);
  });

  it("puts into a collection with no index reading only the catalog, unchanged documents included", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    const { db, updates } = recording(kv);
    const bare = defineSchema<{ notes: Note }>()({ version: 1, collections: { notes: {} } });
    const c = (await openDocStore(db, bare)).collection("notes");
    await c.putMany([
      { id: "1", title: "a" },
      { id: "2", title: "b" },
    ]);
    await c.putMany([
      { id: "1", title: "a" },
      { id: "2", title: "c" },
    ]);
    expect(updates.slice(-2)).toEqual([
      { reads: 1, puts: 2, deletes: 0 },
      { reads: 1, puts: 2, deletes: 0 },
    ]);
    expect(await c.getMany(["1", "2"])).toEqual([
      { id: "1", title: "a" },
      { id: "2", title: "c" },
    ]);
  });

  it("leaves every index unchanged when no indexed field changes", async () => {
    const { notes: c } = await notes();
    await c.putMany([
      { id: "1", title: "a", createdAt: 1, slug: "one", tags: ["x"], body: "old" },
      { id: "2", title: "b", createdAt: 2, slug: "two", tags: ["y"], body: "old" },
    ]);
    const snapshot = () =>
      Promise.all(everyIndex.map((q) => c.queryIds(q)));
    const before = await snapshot();
    await c.put({ id: "1", title: "a", createdAt: 1, slug: "one", tags: ["x"], body: "new" });
    expect(await snapshot()).toEqual(before);
    expect((await c.get("1"))!.body).toBe("new");
  });
});

describe("modify", () => {
  it("returns the stored form of the result", async () => {
    const { notes: c } = await notes();
    await c.put({ id: "1", n: 1 });
    expect(await c.modify("1", (d) => ({ ...d, n: -0, title: undefined }))).toEqual({ id: "1", n: 0 });
    expect(await c.get("1")).toEqual({ id: "1", n: 0 });
  });

  it("returns undefined for a missing id without calling fn", async () => {
    const { notes: c } = await notes();
    let calls = 0;
    expect(
      await c.modify("nope", (d) => {
        calls++;
        return d;
      }),
    ).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("throws document when fn changes the id, and stores nothing", async () => {
    const { notes: c } = await notes();
    await c.put({ id: "1", n: 1 });
    expect(await codeOf(c.modify("1", (d) => ({ ...d, id: "2", n: 2 })))).toBe("document");
    expect(await c.getMany(["1", "2"])).toEqual([{ id: "1", n: 1 }, undefined]);
  });
});

describe("modifyMany", () => {
  it("creates, replaces, deletes and leaves documents in one kv transaction, with every index in step", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    const { db, updates } = recording(kv);
    const c = (await openDocStore(db, schema)).collection("notes");
    const replaced: Note = { id: "replace", title: "old", createdAt: 1, slug: "r", tags: ["x"] };
    const deleted: Note = { id: "delete", title: "gone", createdAt: 2, slug: "d", tags: ["y"] };
    const left: Note = { id: "leave", title: "same", createdAt: 3, slug: "l" };
    await c.putMany([replaced, deleted, left]);
    updates.length = 0;

    let given: unknown;
    await c.modifyMany(["create", "replace", "delete", "leave"], (docs) => {
      given = docs;
      return [
        { id: "create", title: "new", createdAt: 4, slug: "c" },
        { id: "replace", title: "new", createdAt: 5, slug: "r2", tags: ["z"] },
        null,
        undefined,
      ];
    });

    expect(given).toEqual([undefined, replaced, deleted, left]);
    expect(updates).toHaveLength(1);
    expect(await c.getMany(["create", "replace", "delete", "leave"])).toEqual([
      { id: "create", title: "new", createdAt: 4, slug: "c" },
      { id: "replace", title: "new", createdAt: 5, slug: "r2", tags: ["z"] },
      undefined,
      left,
    ]);
    expect((await c.queryIds({ index: "byCreated" })).ids).toEqual(["leave", "create", "replace"]);
    expect((await c.queryIds({ index: "bySlug" })).ids).toEqual(["create", "leave", "replace"]);
    expect((await c.queryIds({ index: "byTag" })).ids).toEqual(["replace"]);
    expect(await c.count({ index: "byTitle" })).toBe(3);
  });

  it("writes no kv op when every slot is left as is or already holds what fn returned", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    const { db, updates } = recording(kv);
    const c = (await openDocStore(db, schema)).collection("notes");
    await c.putMany([{ id: "a", n: 1 }, { id: "b", n: 2 }]);
    updates.length = 0;
    await c.modifyMany(["a", "b", "missing"], ([a]) => [a, undefined, null]);
    expect(updates).toEqual([{ reads: 4, puts: 0, deletes: 0 }]);
  });

  it("accepts no ids", async () => {
    const { notes: c } = await notes();
    await c.modifyMany([], (docs) => docs);
    expect(await c.count({})).toBe(0);
  });

  it.each<[string, readonly string[], (docs: readonly (Note | undefined)[]) => readonly (Note | null | undefined)[]]>([
    ["a repeated id", ["a", "a"], () => [{ id: "a", n: 9 }, { id: "a", n: 9 }]],
    ["a result with too few entries", ["a", "b"], () => [{ id: "a", n: 9 }]],
    ["a result with too many entries", ["a"], () => [{ id: "a", n: 9 }, undefined]],
    ["a document under another id", ["a", "b"], () => [{ id: "a", n: 9 }, { id: "a", n: 9 }]],
    ["a bad id", ["a", ""], () => [{ id: "a", n: 9 }, null]],
    ["a result that is not an array", ["a"], () => ({ id: "a", n: 9 }) as never],
    ["a value an index cannot hold", ["a", "b"], () => [{ id: "a", n: 9 }, { id: "b", title: { x: 1 } as unknown as string }]],
  ])("throws document for %s, and stores nothing", async (_, ids, fn) => {
    const kv = await openKv(freshName());
    open.push(kv);
    const { db, updates } = recording(kv);
    const c = (await openDocStore(db, schema)).collection("notes");
    await c.putMany([{ id: "a", n: 1 }, { id: "b", n: 2 }]);
    updates.length = 0;
    expect(await codeOf(c.modifyMany(ids, fn))).toBe("document");
    expect(updates).toEqual([]);
    expect(await c.getMany(["a", "b"])).toEqual([{ id: "a", n: 1 }, { id: "b", n: 2 }]);
  });

  it("does not call fn for a repeated id, and passes on what fn throws without storing anything", async () => {
    const { notes: c } = await notes();
    await c.put({ id: "a", n: 1 });
    let calls = 0;
    await codeOf(c.modifyMany(["a", "a"], () => (calls++, [])));
    expect(calls).toBe(0);
    await expect(
      c.modifyMany(["a"], () => {
        throw new Error("from fn");
      }),
    ).rejects.toThrow("from fn");
    expect(await c.get("a")).toEqual({ id: "a", n: 1 });
  });

  it("stores nothing of a call that takes a unique value, whether its owner is outside the call or left as is in it", async () => {
    const { notes: c } = await notes();
    await c.putMany([
      { id: "a", slug: "x" },
      { id: "b", slug: "y" },
      { id: "c", slug: "z" },
    ]);
    const before = await c.getMany(["a", "b", "c"]);
    expect(await codeOf(c.modifyMany(["a", "b"], ([a, b]) => [{ ...a!, slug: "z" }, { ...b!, n: 1 }]))).toBe("unique");
    expect(await codeOf(c.modifyMany(["a", "b"], ([a, b]) => [{ ...a!, slug: "y", n: 1 }, b]))).toBe("unique");
    expect(await codeOf(c.modifyMany(["a", "b"], () => [{ id: "a", slug: "s" }, { id: "b", slug: "s" }]))).toBe("unique");
    expect(await c.getMany(["a", "b", "c"])).toEqual(before);
    expect((await c.queryIds({ index: "bySlug" })).ids).toEqual(["a", "b", "c"]);
  });

  it("lets a call swap unique values between its documents, and frees a value it deletes", async () => {
    const { notes: c } = await notes();
    await c.putMany([
      { id: "a", slug: "x" },
      { id: "b", slug: "y" },
      { id: "c", slug: "z" },
    ]);
    await c.modifyMany(["a", "b", "c"], ([a, b]) => [{ ...a!, slug: "y" }, { ...b!, slug: "x" }, null]);
    await c.put({ id: "d", slug: "z" });
    expect((await c.query({ index: "bySlug" })).docs).toEqual([
      { id: "b", slug: "x" },
      { id: "a", slug: "y" },
      { id: "d", slug: "z" },
    ]);
  });

  it("indexes the change when fn edits the document it was given in place and returns it", async () => {
    const { notes: c } = await notes();
    await c.put({ id: "a", title: "t", tags: ["x"] });
    await c.modifyMany(["a"], ([a]) => {
      a!.tags!.push("y");
      return [a];
    });
    expect((await c.queryIds({ index: "byTag", eq: ["y"] })).ids).toEqual(["a"]);
    expect(await c.count({ index: "byTag" })).toBe(2);
  });

  it("runs fn again when a document it left as is changed after fn read it", async () => {
    const name = freshName();
    const other = await notes(name);
    const kv = await openKv(name);
    open.push(kv);
    let armed = true;
    const held = wrap(kv, {
      get: async (key) => {
        const value = await kv.get(key);
        if (armed && new TextDecoder().decode(key).endsWith("limit")) {
          armed = false;
          await other.notes.put({ id: "limit", n: 5 });
          await kv.sync();
        }
        return value;
      },
    });
    const c = (await openDocStore(held, schema)).collection("notes");
    armed = false;
    await c.putMany([{ id: "limit", n: 1 }, { id: "counter", n: 0 }]);
    armed = true;
    const seen: (number | undefined)[] = [];
    await c.modifyMany(["limit", "counter"], ([limit, counter]) => {
      seen.push(limit!.n);
      return [undefined, { ...counter!, n: limit!.n! * 10 }];
    });
    expect(seen).toEqual([1, 5]);
    expect(await c.get("counter")).toEqual({ id: "counter", n: 50 });
  });
});

describe("delete", () => {
  it("returns true once, then false, and removes the document's entries", async () => {
    const { notes: c } = await notes();
    await c.put({ id: "1", createdAt: 1, slug: "s", tags: ["a"] });
    expect(await c.delete("1")).toBe(true);
    expect(await c.delete("1")).toBe(false);
    for (const q of everyIndex) expect(await c.count(q)).toBe(0);
  });

  it("deleteMany returns how many of the distinct ids existed", async () => {
    const { notes: c } = await notes();
    await c.putMany([{ id: "1" }, { id: "2" }]);
    expect(await c.deleteMany(["1", "1", "2", "3"])).toBe(2);
    expect(await c.count({})).toBe(0);
  });
});

describe("ids", () => {
  it("sorts rows by id content, forward and reverse", async () => {
    const { notes: c } = await notes();
    await c.putMany(["b", "aa", "ab", "a"].map((id) => ({ id })));
    expect((await c.queryIds({})).ids).toEqual(["a", "aa", "ab", "b"]);
    expect((await c.queryIds({ reverse: true })).ids).toEqual(["b", "ab", "aa", "a"]);
    expect((await c.queryIds({ startsWith: "a" })).ids).toEqual(["a", "aa", "ab"]);
    expect((await c.queryIds({ gt: "a" })).ids).toEqual(["aa", "ab", "b"]);
  });

  it("round-trips ids holding U+0000, characters outside the BMP, and 1,024 UTF-8 bytes", async () => {
    const { notes: c } = await notes();
    const ids = ["a\u0000b", "😀", "é".repeat(512)];
    await c.putMany(ids.map((id) => ({ id })));
    for (const id of ids) expect((await c.get(id))!.id).toBe(id);
    expect((await c.queryIds({})).ids.sort()).toEqual([...ids].sort());
  });

  it.each([
    ["a lone surrogate", "a\ud800"],
    ["an empty id", ""],
    ["a non-string id", 7],
    ["1,025 UTF-8 bytes", `${"é".repeat(512)}x`],
  ])("throws document for %s and writes nothing", async (_, id) => {
    const { notes: c } = await notes();
    expect(await codeOf(c.put({ id } as unknown as Note))).toBe("document");
    expect(await c.count({})).toBe(0);
  });
});

describe("values an index cannot hold", () => {
  it.each<[string, Partial<Note>]>([
    ["an object", { title: { a: 1 } as unknown as string }],
    ["an array on a non-multi index", { title: ["a"] as unknown as string }],
    ["a string past kv's key limit", { title: "x".repeat(9_000) }],
    ["a Uint8Array", { title: new Uint8Array(2) as unknown as string }],
    ["a string with a lone surrogate", { title: "x\ud800" }],
    ["a non-scalar element of a multi index", { tags: ["a", { b: 1 }] as unknown as string[] }],
    ["more than 1,000 distinct elements", { tags: Array.from({ length: 1_001 }, (_, i) => `t${i}`) }],
  ])("throws document for %s, and get returns what was stored before", async (_, change) => {
    const { notes: c } = await notes();
    await c.put({ id: "1", title: "ok", tags: ["ok"] });
    expect(await codeOf(c.put({ id: "1", title: "ok", tags: ["ok"], ...change }))).toBe("document");
    expect(await c.get("1")).toEqual({ id: "1", title: "ok", tags: ["ok"] });
  });
});

describe("unique", () => {
  it("refuses a second document with a taken value, naming [incoming, owner], and changes neither", async () => {
    const { notes: c } = await notes();
    await c.put({ id: "a", slug: "s", n: 1 });
    await c.put({ id: "b", n: 1 });
    const err = await c.put({ id: "b", slug: "s", n: 2 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unique", ids: ["b", "a"] });
    expect(await c.getMany(["a", "b"])).toEqual([{ id: "a", slug: "s", n: 1 }, { id: "b", n: 1 }]);
  });

  it("lets one putMany swap two documents' values, and refuses one that gives two documents one value", async () => {
    const { notes: c } = await notes();
    await c.putMany([{ id: "a", slug: "x" }, { id: "b", slug: "y" }]);
    await c.putMany([{ id: "a", slug: "y" }, { id: "b", slug: "x" }]);
    expect((await c.queryIds({ index: "bySlug" })).ids).toEqual(["b", "a"]);
    expect(await codeOf(c.putMany([{ id: "c", slug: "z" }, { id: "d", slug: "z" }]))).toBe("unique");
    expect(await c.getMany(["c", "d"])).toEqual([undefined, undefined]);
  });

  it("frees a value when its document changes it or is deleted", async () => {
    const { notes: c } = await notes();
    await c.putMany([{ id: "a", slug: "x" }, { id: "b", slug: "y" }]);
    await c.put({ id: "a", slug: "x2" });
    await c.put({ id: "c", slug: "x" });
    await c.delete("b");
    await c.put({ id: "d", slug: "y" });
    expect((await c.query({ index: "bySlug" })).docs).toEqual([
      { id: "c", slug: "x" },
      { id: "a", slug: "x2" },
      { id: "d", slug: "y" },
    ]);
  });

  it("refuses a modify that would take another document's value, and leaves both unchanged", async () => {
    const { notes: c } = await notes();
    await c.putMany([{ id: "a", slug: "x" }, { id: "b", slug: "y" }]);
    expect(await codeOf(c.modify("b", (d) => ({ ...d, slug: "x" })))).toBe("unique");
    expect(await c.getMany(["a", "b"])).toEqual([{ id: "a", slug: "x" }, { id: "b", slug: "y" }]);
  });

  it("treats null as a value, and a missing path as no value", async () => {
    const { notes: c } = await notes();
    await c.putMany([{ id: "a", slug: null }, { id: "b" }, { id: "c" }]);
    expect(await codeOf(c.put({ id: "d", slug: null }))).toBe("unique");
  });
});

describe("multi index", () => {
  it("has one entry per distinct tag, and eq on a tag returns the document once", async () => {
    const { notes: c } = await notes();
    await c.put({ id: "1", tags: ["a", "b", "a"] });
    expect(await c.count({ index: "byTag" })).toBe(2);
    expect((await c.queryIds({ index: "byTag", eq: ["a"] })).ids).toEqual(["1"]);
    expect((await c.queryIds({ index: "byTag", eq: ["b"] })).ids).toEqual(["1"]);
  });

  it("gives an empty array no entry and a scalar one entry", async () => {
    const { notes: c } = await notes();
    await c.putMany([{ id: "1", tags: [] }, { id: "2", tags: "a" as unknown as string[] }]);
    expect((await c.queryIds({ index: "byTag" })).ids).toEqual(["2"]);
  });

  it("removes only the entry of a removed tag", async () => {
    const { notes: c } = await notes();
    await c.put({ id: "1", tags: ["a", "b", "c"] });
    await c.put({ id: "1", tags: ["a", "c"] });
    expect((await c.query({ index: "byTag" })).docs.map((d) => d.id)).toEqual(["1", "1"]);
    expect(await c.count({ index: "byTag", eq: ["b"] })).toBe(0);
  });
});

describe("two handles on one database", () => {
  async function pair() {
    const name = freshName();
    const a = await notes(name);
    const b = await notes(name);
    return { a, b };
  }

  it("racing puts of one document leave exactly the final document's entries in every index", async () => {
    const { a, b } = await pair();
    const docA: Note = { id: "1", title: "a", createdAt: 1, slug: "sa", tags: ["x", "y"] };
    const docB: Note = { id: "1", title: "b", createdAt: 2, slug: "sb", tags: ["y", "z"] };
    for (let round = 0; round < 20; round++) {
      await Promise.all([a.notes.put(round % 2 ? docA : docB), b.notes.put(round % 2 ? docB : docA)]);
    }
    await a.kv.sync();
    const final = (await a.notes.get("1"))!;
    expect([docA, docB]).toContainEqual(final);
    for (const q of everyIndex) {
      const expected = q.index === "byTag" ? final.tags!.length : 1;
      expect(await a.notes.count(q)).toBe(expected);
    }
    expect((await a.notes.queryIds({ index: "bySlug", eq: [final.slug!] })).ids).toEqual(["1"]);
  });

  it("lets exactly one of two racing puts take a unique value", async () => {
    const { a, b } = await pair();
    const results = await Promise.allSettled([a.notes.put({ id: "a", slug: "s" }), b.notes.put({ id: "b", slug: "s" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "unique" });
    await a.kv.sync();
    expect((await a.notes.queryIds({ index: "bySlug" })).ids).toHaveLength(1);
  });

  it("loses no update when both handles change the same two documents at once, 50 times each", async () => {
    const { a, b } = await pair();
    await a.notes.putMany([{ id: "x", n: 0 }, { id: "y", n: 0 }]);
    await b.kv.sync();
    const bump = async (c: typeof a.notes) => {
      for (let i = 0; i < 50; i++) {
        await c.modifyMany(["x", "y"], ([x, y]) => [{ ...x!, n: x!.n! + 1 }, { ...y!, n: y!.n! + 2 }]);
      }
    };
    await Promise.all([bump(a.notes), bump(b.notes)]);
    await a.kv.sync();
    expect(await a.notes.getMany(["x", "y"])).toEqual([{ id: "x", n: 100 }, { id: "y", n: 200 }]);
  });

  it("applies 50 increments from each handle through modify", async () => {
    const { a, b } = await pair();
    await a.notes.put({ id: "counter", n: 0 });
    await b.kv.sync();
    const bump = async (c: typeof a.notes) => {
      for (let i = 0; i < 50; i++) await c.modify("counter", (d) => ({ ...d, n: d.n! + 1 }));
    };
    await Promise.all([bump(a.notes), bump(b.notes)]);
    await a.kv.sync();
    expect((await a.notes.get("counter"))!.n).toBe(100);
  });
});

describe("modifyMany on a collection without a unique index", () => {
  const plain = defineSchema<{ notes: Note }>()({
    version: 1,
    collections: { notes: { byCreated: { on: "createdAt" }, byTag: { on: "tags", multi: true } } },
  });

  async function plainNotes(name = freshName()) {
    const kv = await openKv(name);
    open.push(kv);
    let gets = 0;
    const counted = wrap(kv, { get: (key) => (gets++, kv.get(key)) });
    const { db, updates } = recording(counted);
    const c = (await openDocStore(db, plain)).collection("notes");
    return { kv, c, updates, gets: () => gets };
  }

  it("reads each row once, in the kv transaction that writes it, with every index in step", async () => {
    const { c, updates, gets } = await plainNotes();
    await c.putMany([
      { id: "replace", createdAt: 1, tags: ["x"] },
      { id: "delete", createdAt: 2, tags: ["y"] },
      { id: "leave", createdAt: 3 },
    ]);
    updates.length = 0;
    const before = gets();
    let given: unknown;
    await c.modifyMany(["create", "replace", "delete", "leave"], (docs) => {
      given = structuredClone(docs);
      return [{ id: "create", createdAt: 4 }, { id: "replace", createdAt: 5, tags: ["z"] }, null, undefined];
    });
    expect(gets() - before).toBe(0);
    expect(updates).toEqual([{ reads: 5, puts: 5, deletes: 5 }]);
    expect(given).toEqual([undefined, { id: "replace", createdAt: 1, tags: ["x"] }, { id: "delete", createdAt: 2, tags: ["y"] }, { id: "leave", createdAt: 3 }]);
    expect((await c.queryIds({ index: "byCreated" })).ids).toEqual(["leave", "create", "replace"]);
    expect((await c.queryIds({ index: "byTag" })).ids).toEqual(["replace"]);
  });

  it("throws document for a result under another id, passes on what fn throws, and stores nothing", async () => {
    const { c } = await plainNotes();
    await c.put({ id: "a", n: 1 });
    expect(await codeOf(c.modifyMany(["a"], () => [{ id: "b", n: 2 }]))).toBe("document");
    await expect(
      c.modifyMany(["a"], () => {
        throw new Error("from fn");
      }),
    ).rejects.toThrow("from fn");
    expect(await c.getMany(["a", "b"])).toEqual([{ id: "a", n: 1 }, undefined]);
  });

  it("loses no update when two handles change the same two documents at once, 50 times each", async () => {
    const name = freshName();
    const a = await plainNotes(name);
    const b = await plainNotes(name);
    await a.c.putMany([{ id: "x", n: 0, createdAt: 0 }, { id: "y", n: 0 }]);
    await b.kv.sync();
    const bump = async (c: typeof a.c) => {
      for (let i = 0; i < 50; i++) {
        await c.modifyMany(["x", "y"], ([x, y]) => [{ ...x!, n: x!.n! + 1, createdAt: x!.n! + 1 }, { ...y!, n: y!.n! + 2 }]);
      }
    };
    await Promise.all([bump(a.c), bump(b.c)]);
    await a.kv.sync();
    expect(await a.c.getMany(["x", "y"])).toEqual([{ id: "x", n: 100, createdAt: 100 }, { id: "y", n: 200 }]);
    expect((await a.c.query({ index: "byCreated", eq: [100] })).docs.map((d) => d.id)).toEqual(["x"]);
    expect(await a.c.count({ index: "byCreated" })).toBe(1);
  });
});
