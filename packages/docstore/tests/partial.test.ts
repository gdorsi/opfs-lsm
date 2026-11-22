import type { Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCatalog, type StoredCatalog } from "../src/catalog.js";
import { collection, defineSchema, openDocStore, type CollectionDecl } from "../src/index.js";
import { CATALOG_KEY } from "../src/keys.js";
import { codeOf, docstoreKeys, freshName, keysUnder, openKv, storedCatalog, storedPrefix } from "./harness.js";

type Issue = {
  id: string;
  status?: 0 | 1 | 2 | 3 | 4 | null | undefined;
  priority?: number | undefined;
  title?: string | undefined;
  meta?: { sprint?: string | undefined } | undefined;
};

const OPEN = [0, 1, 2] as const;
const byPriority = collection<Issue>().index("openByPriority", "priority", { where: { status: OPEN } });
const schemaOf = (version: number, decl: CollectionDecl<Issue, any>) => defineSchema({ version, collections: { issues: decl } });

const issues: Issue[] = [
  { id: "a", status: 0, priority: 3 },
  { id: "b", status: 3, priority: 1 },
  { id: "c", status: 1, priority: 1 },
  { id: "d", status: 4, priority: 2 },
  { id: "e", status: 2, priority: 2 },
  { id: "f", priority: 0 },
];

const handles: Db[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((kv) => kv.close()));
});

async function open<D extends CollectionDecl<Issue, any>>(version: number, decl: D, name = freshName()) {
  const kv = await openKv(name);
  handles.push(kv);
  const store = await openDocStore(kv, defineSchema({ version, collections: { issues: decl } }));
  return { kv, name, store, issues: store.collection("issues") };
}

const entriesIn = async (kv: Db, index: string) => keysUnder(kv, await storedPrefix(kv, "issues", index));

describe("a partial index", () => {
  it("holds only the documents inside its condition, in index order, and count agrees", async () => {
    const { kv, issues: c } = await open(1, byPriority);
    await c.putMany(issues);
    const held = await c.queryEntries({ index: "openByPriority" });
    expect(held.entries).toEqual([
      { id: "c", values: [1] },
      { id: "e", values: [2] },
      { id: "a", values: [3] },
    ]);
    expect((await c.query({ index: "openByPriority", reverse: true })).docs.map((d) => d.id)).toEqual(["a", "e", "c"]);
    expect((await c.queryIds({ index: "openByPriority", gte: 2 })).ids).toEqual(["e", "a"]);
    expect((await c.queryIds({ index: "openByPriority", eq: [[1, 2]] })).ids).toEqual(["c", "e"]);
    expect(await c.count({ index: "openByPriority" })).toBe(3);
    expect(await c.count({ index: "openByPriority", eq: [1] })).toBe(1);
    expect(await entriesIn(kv, "openByPriority")).toBe(3);
  });

  it("adds and removes entries as writes move a document into and out of the condition", async () => {
    const { kv, issues: c } = await open(1, byPriority);
    const inIndex = async () => (await c.queryIds({ index: "openByPriority" })).ids;
    await c.put({ id: "x", status: 3, priority: 5 });
    expect(await inIndex()).toEqual([]);
    expect(await entriesIn(kv, "openByPriority")).toBe(0);

    await c.put({ id: "x", status: 1, priority: 5 });
    expect(await inIndex()).toEqual(["x"]);
    await c.put({ id: "x", status: 4, priority: 5 });
    expect(await inIndex()).toEqual([]);

    await c.modify("x", (d) => ({ ...d, status: 0 }));
    expect(await inIndex()).toEqual(["x"]);
    await c.modify("x", (d) => ({ ...d, status: 3 }));
    expect(await inIndex()).toEqual([]);

    await c.putMany([{ id: "y", status: 3, priority: 1 }, { id: "z", status: 0, priority: 2 }]);
    await c.modifyMany(["y", "z"], ([y, z]) => [{ ...y!, status: 2 }, { ...z!, status: 4 }]);
    expect(await inIndex()).toEqual(["y"]);

    await c.modify("y", (d) => ({ ...d, priority: 9 }));
    expect(await c.queryEntries({ index: "openByPriority" })).toEqual({ entries: [{ id: "y", values: [9] }] });

    expect(await c.deleteMany(["y", "z"])).toBe(2);
    expect(await inIndex()).toEqual([]);
    expect(await entriesIn(kv, "openByPriority")).toBe(0);
  });

  it("clears and reopens like any index", async () => {
    const { name, issues: c } = await open(1, byPriority);
    await c.putMany(issues);
    await c.clear();
    expect(await c.queryIds({ index: "openByPriority" })).toEqual({ ids: [] });
    await c.putMany(issues);
    const again = await open(1, byPriority, name);
    expect((await again.issues.queryIds({ index: "openByPriority" })).ids).toEqual(["c", "e", "a"]);
  });

  describe("tests each document's value at the path with strict equality", () => {
    const notListed = collection<Issue>().index("byPriority", "priority", { where: { status: [0, 1] } });
    const listed = collection<Issue>().index("byPriority", "priority", { where: { status: [null, 0] } });

    it.each<[string, unknown, boolean, boolean]>([
      ["missing", undefined, false, false],
      ["null", null, false, true],
      ["a listed number", 0, true, true],
      ["a number listed only without null", 1, true, false],
      ["a string that looks like a listed number", "0", false, false],
      ["false", false, false, false],
      ["an array holding a listed value", [0], false, false],
      ["an array holding null", [null], false, false],
      ["an object", { 0: 0 }, false, false],
    ])("%s", async (_, status, inWithoutNull, inWithNull) => {
      for (const [decl, expected] of [[notListed, inWithoutNull], [listed, inWithNull]] as const) {
        const { issues: c } = await open(1, decl);
        await c.put({ id: "x", priority: 1, ...(status === undefined ? {} : { status }) } as Issue);
        expect((await c.queryIds({ index: "byPriority" })).ids).toEqual(expected ? ["x"] : []);
      }
    });

    it("reads a nested path, and a parent that is not an object is outside", async () => {
      const { issues: c } = await open(1, collection<Issue>().index("bySprint", "priority", { where: { "meta.sprint": ["s1", "s2"] } }));
      await c.putMany([
        { id: "in1", priority: 1, meta: { sprint: "s1" } },
        { id: "in2", priority: 2, meta: { sprint: "s2" } },
        { id: "other", priority: 3, meta: { sprint: "s3" } },
        { id: "nometa", priority: 4 },
        { id: "nosprint", priority: 5, meta: {} },
        { id: "string", priority: 6, meta: "s1" as never },
        { id: "list", priority: 7, meta: { sprint: ["s1"] as never } },
      ]);
      expect((await c.queryIds({ index: "bySprint" })).ids).toEqual(["in1", "in2"]);
    });

    it("reads -0 and 0 as one value", async () => {
      const { issues: c } = await open(1, collection<Issue>().index("byStatus", "priority", { where: { status: 0 } }));
      await c.put({ id: "x", priority: 1, status: -0 as 0 });
      expect((await c.queryIds({ index: "byStatus" })).ids).toEqual(["x"]);
    });
  });

  describe("tests the condition before it reads any other value", () => {
    it("writes a document outside it whose indexed value the index cannot hold", async () => {
      const { issues: c } = await open(1, byPriority);
      const unholdable = [{ a: 1 }, [1], "n".repeat(9_000), "\ud800"];
      await c.putMany(unholdable.map((priority, i) => ({ id: `out${i}`, status: 3, priority }) as unknown as Issue));
      await c.put({ id: "ok", status: 1, priority: 1 });
      expect((await c.queryIds({ index: "openByPriority" })).ids).toEqual(["ok"]);
      expect(await c.get("out1")).toEqual({ id: "out1", status: 3, priority: [1] });
    });

    it("refuses the same value in a document inside it, and stores nothing", async () => {
      const { issues: c } = await open(1, byPriority);
      for (const priority of [{ a: 1 }, "n".repeat(9_000), "\ud800"]) {
        expect(await codeOf(c.put({ id: "in", status: 1, priority } as unknown as Issue))).toBe("document");
      }
      expect(await c.get("in")).toBeUndefined();
    });

    it("lets a document leave the condition with a value the index cannot hold", async () => {
      const { issues: c } = await open(1, byPriority);
      await c.put({ id: "x", status: 1, priority: 1 });
      await c.put({ id: "x", status: 3, priority: { a: 1 } } as unknown as Issue);
      expect((await c.queryIds({ index: "openByPriority" })).ids).toEqual([]);
    });
  });

  describe("on a unique index", () => {
    type User = { id: string; email?: string | undefined; active?: boolean | undefined };
    const users = defineSchema({
      version: 1,
      collections: { users: collection<User>().unique("activeEmail", "email", { where: { active: true } }) },
    });
    const emails = async () => {
      const kv = await openKv(freshName());
      handles.push(kv);
      return (await openDocStore(kv, users)).collection("users");
    };

    it("lets documents share a value when at most one is inside the condition", async () => {
      const c = await emails();
      await c.putMany([
        { id: "u1", email: "ada@x", active: true },
        { id: "u2", email: "ada@x", active: false },
        { id: "u3", email: "ada@x" },
        { id: "u4", email: "ada@x", active: false },
      ]);
      expect((await c.queryIds({ index: "activeEmail", eq: ["ada@x"] })).ids).toEqual(["u1"]);
    });

    it("refuses a second document that enters the condition with a taken value, naming the incoming one first", async () => {
      const c = await emails();
      await c.putMany([
        { id: "u1", email: "ada@x", active: true },
        { id: "u2", email: "ada@x", active: false },
      ]);
      await expect(c.modify("u2", (d) => ({ ...d, active: true }))).rejects.toMatchObject({ code: "unique", ids: ["u2", "u1"] });
      expect(await codeOf(c.put({ id: "u5", email: "ada@x", active: true }))).toBe("unique");
      expect(await codeOf(c.putMany([{ id: "u6", email: "b@x", active: true }, { id: "u7", email: "b@x", active: true }]))).toBe("unique");
      expect((await c.get("u2"))!.active).toBe(false);
    });

    it("frees the value when its owner leaves the condition or is deleted", async () => {
      const c = await emails();
      await c.putMany([
        { id: "u1", email: "ada@x", active: true },
        { id: "u2", email: "ada@x", active: false },
      ]);
      await c.modifyMany(["u1", "u2"], ([a, b]) => [{ ...a!, active: false }, { ...b!, active: true }]);
      expect((await c.queryIds({ index: "activeEmail", eq: ["ada@x"] })).ids).toEqual(["u2"]);
      await c.delete("u2");
      await c.put({ id: "u1", email: "ada@x", active: true });
      expect((await c.queryIds({ index: "activeEmail", eq: ["ada@x"] })).ids).toEqual(["u1"]);
    });
  });

  it("serves a text index only the documents inside the condition", async () => {
    const { issues: c } = await open(1, collection<Issue>().text("openSearch", "priority", "title", { where: { status: OPEN } }));
    await c.putMany([
      { id: "a", status: 0, priority: 1, title: "Fix the window" },
      { id: "b", status: 3, priority: 2, title: "Fix the door" },
      { id: "c", status: 2, priority: 3, title: "Paint the window" },
      { id: "d", status: 4, priority: 4, title: 5 as never },
    ]);
    expect((await c.queryIds({ index: "openSearch", match: "fix" })).ids).toEqual(["a"]);
    expect((await c.queryIds({ index: "openSearch", match: "win" })).ids).toEqual(["a", "c"]);
    expect(await codeOf(c.put({ id: "e", status: 1, priority: 5, title: 5 as never }))).toBe("document");
  });

  it("serves an index with included fields only the documents inside the condition", async () => {
    const { issues: c } = await open(1, collection<Issue>().index("openList", "priority", { include: ["title"], where: { status: OPEN } }));
    await c.putMany([
      { id: "a", status: 0, priority: 2, title: "Fix" },
      { id: "b", status: 3, priority: 1, title: "Closed" },
      { id: "c", status: 1, priority: 1 },
    ]);
    expect((await c.queryEntries({ index: "openList" })).entries).toEqual([
      { id: "c", values: [1], fields: {} },
      { id: "a", values: [2], fields: { title: "Fix" } },
    ]);
    await c.modify("a", (d) => ({ ...d, title: "Fixed" }));
    await c.modify("b", (d) => ({ ...d, title: "Reopened" }));
    expect((await c.queryEntries({ index: "openList" })).entries.map((e) => e.fields)).toEqual([{}, { title: "Fixed" }]);
  });

  it("reports its condition in collection.indexes, canonical, and none on an index without one", async () => {
    const decl = collection<Issue>()
      .index("openByPriority", "priority", { where: { status: [2, 0, 1], title: "x" } })
      .index("all", "priority");
    const { issues: c } = await open(1, decl);
    expect([...c.indexes]).toStrictEqual([
      ["openByPriority", { kind: "sorted", by: ["priority"], unique: false, where: [["status", [0, 1, 2]], ["title", ["x"]]] }],
      ["all", { kind: "sorted", by: ["priority"], unique: false }],
    ]);
  });
});

describe("a partial index and the schema version", () => {
  const openIf = (where: object) => collection<Issue>().index("openByPriority", "priority", { where: where as never });

  it("backfills only the matching documents when a version bump adds it to a collection that holds documents", async () => {
    const { name, issues: before } = await open(1, collection<Issue>());
    await before.putMany([...issues, { id: "g", status: 3, priority: { a: 1 } as never }]);
    const { kv, issues: c } = await open(2, byPriority, name);
    expect((await c.queryIds({ index: "openByPriority" })).ids).toEqual(["c", "e", "a"]);
    expect(await entriesIn(kv, "openByPriority")).toBe(3);
  });

  it("keeps the index when the condition is respelled, at the same version or a higher one", async () => {
    const { kv, name, issues: c } = await open(1, openIf({ status: [2, 0, 1], title: "x" }));
    await c.putMany(issues.map((i) => ({ ...i, title: "x" })));
    const keys = await docstoreKeys(kv);
    const prefix = await storedPrefix(kv, "issues", "openByPriority");

    await open(1, openIf({ title: ["x"], status: [0, 1, 2, 1] }), name);
    expect(await docstoreKeys(kv)).toEqual(keys);
    const { issues: next } = await open(2, openIf({ status: [0, 1, 2], title: "x" }), name);
    expect(await storedPrefix(kv, "issues", "openByPriority")).toEqual(prefix);
    expect((await next.queryIds({ index: "openByPriority" })).ids).toEqual(["c", "e", "a"]);
    expect((await storedCatalog(kv)).dropped).toEqual([]);
  });

  it("refuses a changed condition at the same version, and rebuilds the index at a higher one", async () => {
    const { kv: first, name, issues: c } = await open(1, byPriority);
    await c.putMany(issues);
    const changed = openIf({ status: [0, 1] });
    await expect(openDocStore(first, schemaOf(1, changed))).rejects.toThrow(/bump the version/);
    expect(await codeOf(openDocStore(first, schemaOf(1, changed)))).toBe("schema");

    const { kv, issues: next, store } = await open(2, changed, name);
    expect((await next.queryIds({ index: "openByPriority" })).ids).toEqual(["c", "a"]);
    await store.whenIdle();
    expect(await entriesIn(kv, "openByPriority")).toBe(2);
    expect((await docstoreKeys(kv)).length).toBe(1 + issues.length + 2);
    expect((await storedCatalog(kv)).dropped).toEqual([]);
  });

  it("refuses a query of a handle on the old condition once a newer schema redefined the index", async () => {
    const { name, issues: old } = await open(1, byPriority);
    await open(2, openIf({ status: [0] }), name);
    expect(await codeOf(old.queryIds({ index: "openByPriority" }))).toBe("schema");
  });

  it("refuses a stored catalog of format 2, which indexes every document, with schema", async () => {
    const { kv, issues: c } = await open(1, byPriority);
    await c.putMany(issues);
    const catalog = await storedCatalog(kv);
    await kv.put(CATALOG_KEY, encodeCatalog({ ...catalog, format: 2 } as unknown as StoredCatalog));
    expect(await codeOf(openDocStore(kv, schemaOf(1, byPriority)))).toBe("schema");
  });

  it.each<[string, object]>([
    ["no field", {}],
    ["a field with no value", { status: [] }],
  ])("refuses a where with %s when the store opens", async (_, where) => {
    const kv = await openKv(freshName());
    handles.push(kv);
    expect(await codeOf(openDocStore(kv, schemaOf(1, collection<Issue>().index("x", "priority", { where }))))).toBe("schema");
  });
});
