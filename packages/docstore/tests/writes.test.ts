import type { Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { defineSchema, openDocStore, type Query } from "../src/index.js";
import { codeOf, freshName, openKv, recording } from "./harness.js";

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
    const many = Array.from({ length: 2_600 }, (_, i) => ({ id: `big${i}`, createdAt: i, slug: `s${i}`, title: "t" }));
    expect(await codeOf(c.putMany(many))).toBe("constraint");
    expect(await c.getMany(["a", "b", "big0"])).toEqual([undefined, undefined, undefined]);
    expect(await c.count({})).toBe(1);
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
