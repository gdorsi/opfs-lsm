import { CorruptDatabaseError } from "@opfs-lsm/kv";
import { describe, expect, it } from "vitest";
import {
  bind,
  clearCollection,
  encodeCatalog,
  markFailed,
  markReady,
  normalizeSchema,
  parseCatalog,
  reconcile,
  removeDropped,
  type StoredCatalog,
} from "../src/catalog.js";
import { DocStoreError } from "../src/errors.js";
import type { IndexId } from "../src/keys.js";

type Collections = Record<string, Record<string, object>>;
const declare = (version: number, collections: Collections, drop?: string[]) =>
  normalizeSchema(drop ? { version, collections, drop } : { version, collections });

function open(stored: StoredCatalog | undefined, version: number, collections: Collections, drop?: string[]): StoredCatalog {
  const r = reconcile(stored, declare(version, collections, drop));
  if (r.kind === "error") throw r.error;
  return r.kind === "write" ? r.catalog : stored!;
}

function codeOf(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    if (err instanceof DocStoreError) return err.code;
    throw err;
  }
  return "no error";
}

const idOf = (c: StoredCatalog, coll: string, index: string) => c.collections[coll]!.indexes[index]!.id as IndexId;

const v1: Collections = { todos: { byA: { on: "a" }, byB: { on: "b" } }, notes: { byC: { on: "c" } } };

describe("reconcile", () => {
  it("gives a fresh catalog's collections distinct ids and its indexes distinct ids, all ready", () => {
    const c = open(undefined, 1, v1);
    expect(c.version).toBe(1);
    expect(new Set([c.collections["todos"]!.id, c.collections["notes"]!.id]).size).toBe(2);
    expect(idOf(c, "todos", "byA")).not.toBe(idOf(c, "todos", "byB"));
    for (const coll of Object.values(c.collections)) {
      for (const i of Object.values(coll.indexes)) expect(i.state).toEqual({ kind: "ready" });
    }
    expect(c.dropped).toEqual([]);
  });

  it("writes nothing when the same schema opens again, at its version or a lower one", () => {
    const c = open(undefined, 2, v1);
    expect(reconcile(c, declare(2, v1))).toEqual({ kind: "keep" });
    expect(reconcile(c, declare(1, { other: {} }))).toEqual({ kind: "keep" });
  });

  it("refuses another schema at the stored version", () => {
    const c = open(undefined, 1, v1);
    const changed = { ...v1, todos: { byA: { on: "a" }, byB: { on: "x" } } };
    const r = reconcile(c, declare(1, changed));
    expect(r.kind === "error" && r.error.code).toBe("schema");
    expect(reconcile(c, declare(1, { ...v1, more: {} })).kind).toBe("error");
    expect(reconcile(c, declare(1, { ...v1, todos: { byA: { on: "a" } } })).kind).toBe("error");
  });

  it("at a higher version keeps unchanged indexes, builds new and redefined ones under new ids, and drops the old ones", () => {
    const c1 = open(undefined, 1, v1);
    const c2 = open(c1, 2, { todos: { byA: { on: "a" }, byB: { on: "x" }, byD: { on: "d" } }, notes: {} });
    const todos = c1.collections["todos"]!;
    expect(c2.collections["todos"]!.id).toBe(todos.id);
    expect(c2.collections["todos"]!.indexes["byA"]).toEqual(todos.indexes["byA"]);
    const byB = c2.collections["todos"]!.indexes["byB"]!;
    expect(byB.state).toEqual({ kind: "building" });
    expect(byB.id).not.toBe(todos.indexes["byB"]!.id);
    expect(c2.collections["todos"]!.indexes["byD"]!.state).toEqual({ kind: "building" });
    const ids = Object.values(c2.collections["todos"]!.indexes).map((i) => i.id);
    expect(new Set([...ids, todos.indexes["byB"]!.id]).size).toBe(4);
    expect(c2.dropped).toEqual([
      { collection: todos.id, index: todos.indexes["byB"]!.id },
      { collection: c1.collections["notes"]!.id, index: idOf(c1, "notes", "byC") },
    ]);
    expect(reconcile(c2, declare(2, { todos: { byA: { on: "a" }, byB: { on: "x" }, byD: { on: "d" } }, notes: {} }))).toEqual({
      kind: "keep",
    });
  });

  it("at a higher version keeps a collection it leaves out, untouched", () => {
    const c1 = open(undefined, 1, v1);
    const c2 = open(c1, 2, { todos: v1["todos"]! });
    expect(c2.collections["notes"]).toEqual(c1.collections["notes"]);
    expect(c2.dropped).toEqual([]);
    const c3 = open(c2, 3, v1);
    expect(c3.collections["notes"]).toEqual(c1.collections["notes"]);
  });

  it("at a higher version drops a collection it lists in drop, replacing its index prefixes with its collection prefix", () => {
    const c1 = open(undefined, 1, v1);
    const notes = c1.collections["notes"]!.id;
    const c2 = open(c1, 2, { todos: v1["todos"]!, notes: {} });
    expect(c2.dropped).toEqual([{ collection: notes, index: idOf(c1, "notes", "byC") }]);
    const c3 = open(c2, 3, { todos: v1["todos"]! }, ["notes", "never"]);
    expect(c3.collections["notes"]).toBeUndefined();
    expect(c3.collections["todos"]).toEqual(c1.collections["todos"]);
    expect(c3.dropped).toEqual([{ collection: notes }]);
    expect(reconcile(c3, declare(3, { todos: v1["todos"]! }, ["notes"]))).toEqual({ kind: "keep" });
    const c4 = open(c3, 4, v1);
    expect(c4.collections["notes"]!.id).not.toBe(notes);
    expect(c4.collections["notes"]!.indexes["byC"]!.state).toEqual({ kind: "ready" });
  });

  it("refuses a drop at the stored version while the collection is stored", () => {
    const c = open(undefined, 1, v1);
    const r = reconcile(c, declare(1, { todos: v1["todos"]! }, ["notes"]));
    expect(r.kind === "error" && r.error.code).toBe("schema");
  });

  it("makes a collection new at a higher version ready at once", () => {
    const c = open(open(undefined, 1, v1), 2, { ...v1, tags: { byName: { on: "name" } } });
    expect(c.collections["tags"]!.indexes["byName"]!.state).toEqual({ kind: "ready" });
    expect(new Set(Object.values(c.collections).map((x) => x.id)).size).toBe(3);
  });

  it("rebuilds a failed index under a new id at the next version, without dropping its prefix twice", () => {
    const c1 = open(open(undefined, 1, v1), 2, { ...v1, todos: { ...v1["todos"], u: { on: "u", unique: true } } });
    const failed = markFailed(c1, "todos", idOf(c1, "todos", "u"), "unique", ["1", "2"])!;
    const c3 = open(failed, 3, { ...v1, todos: { ...v1["todos"], u: { on: "u", unique: true } } });
    expect(c3.collections["todos"]!.indexes["u"]!.state).toEqual({ kind: "building" });
    expect(idOf(c3, "todos", "u")).not.toBe(idOf(c1, "todos", "u"));
    expect(c3.dropped).toEqual(failed.dropped);
  });

  it("refuses a schema that needs an index id above 255", () => {
    const many = (path: string) => Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`i${i}`, { on: `${path}${i}` }]));
    const c1 = open(undefined, 1, { big: many("a") });
    const r = reconcile(c1, declare(2, { big: many("b") }));
    expect(r.kind === "error" && r.error.code).toBe("schema");
  });
});

describe("stored bytes", () => {
  it("round-trips a catalog", () => {
    const c = open(undefined, 1, v1);
    expect(parseCatalog(encodeCatalog(c))).toEqual(c);
  });

  it("refuses a catalog of another format with schema, and a wrong shape as corrupt", () => {
    const c = open(undefined, 1, v1);
    expect(codeOf(() => parseCatalog(encodeCatalog({ ...c, format: 2 } as unknown as StoredCatalog)))).toBe("schema");
    expect(() => parseCatalog(new TextEncoder().encode('{"format":1}'))).toThrow(CorruptDatabaseError);
    expect(() => parseCatalog(new TextEncoder().encode("not json"))).toThrow(CorruptDatabaseError);
  });
});

describe("transitions", () => {
  const c1 = open(undefined, 1, v1);
  const c2 = open(c1, 2, { ...v1, todos: { ...v1["todos"], byD: { on: "d" } } });
  const byD = idOf(c2, "todos", "byD");

  it("marks a building index ready once", () => {
    const ready = markReady(c2, "todos", byD)!;
    expect(ready.collections["todos"]!.indexes["byD"]!.state).toEqual({ kind: "ready" });
    expect(markReady(ready, "todos", byD)).toBeUndefined();
    expect(markReady(c2, "todos", idOf(c2, "todos", "byA"))).toBeUndefined();
    expect(markReady(c2, "nope", byD)).toBeUndefined();
  });

  it("marks a building index failed once, with its reason and ids, and drops its prefix", () => {
    const failed = markFailed(c2, "todos", byD, "value", ["7"])!;
    expect(failed.collections["todos"]!.indexes["byD"]!.state).toEqual({ kind: "failed", reason: "value", ids: ["7"] });
    expect(failed.dropped).toEqual([{ collection: c2.collections["todos"]!.id, index: byD }]);
    expect(markFailed(failed, "todos", byD, "value", ["7"])).toBeUndefined();
    expect(markReady(failed, "todos", byD)).toBeUndefined();
  });

  it("clears a collection under a new id with its indexes ready, failed ones kept, and drops the old prefix", () => {
    const c3 = open(c2, 3, { ...v1, todos: { ...v1["todos"], byD: { on: "d" }, u: { on: "u", unique: true } } });
    const withFailed = markFailed(c3, "todos", idOf(c3, "todos", "u"), "unique", ["1", "2"])!;
    const old = withFailed.collections["todos"]!;
    const cleared = clearCollection(withFailed, "todos");
    const todos = cleared.collections["todos"]!;
    expect(todos.id).not.toBe(old.id);
    expect(todos.indexes["byD"]).toEqual({ ...old.indexes["byD"], state: { kind: "ready" } });
    expect(todos.indexes["u"]).toEqual(old.indexes["u"]);
    expect(cleared.dropped.at(-1)).toEqual({ collection: old.id });
    expect(clearCollection(cleared, "todos").collections["todos"]!.id).not.toBe(todos.id);
    expect(codeOf(() => clearCollection(cleared, "nope"))).toBe("schema");
  });

  it("removes a swept prefix once, telling a collection prefix from its index prefixes", () => {
    const cleared = clearCollection(markFailed(c2, "todos", byD, "value", ["7"])!, "todos");
    const coll = c2.collections["todos"]!.id;
    const once = removeDropped(cleared, { collection: coll })!;
    expect(once.dropped).toEqual([{ collection: coll, index: byD }]);
    expect(removeDropped(once, { collection: coll })).toBeUndefined();
    expect(removeDropped(once, { collection: coll, index: byD })!.dropped).toEqual([]);
  });
});

describe("bind", () => {
  it("lets a handle read only the ready indexes whose stored definition equals its own, and write every live one", () => {
    const c1 = open(undefined, 1, v1);
    const c2 = open(c1, 2, { todos: { byA: { on: "a" }, byB: { on: "x" }, byD: { on: "d" } } });
    const failed = markFailed(c2, "todos", idOf(c2, "todos", "byD"), "value", ["9"])!;
    const old = bind(encodeCatalog(failed), failed, declare(1, { ...v1, todos: { ...v1["todos"], byD: { on: "d" }, byE: { on: "e" } } }));
    const todos = old.collections.get("todos")!;
    expect(todos.readable.get("byA")).toMatchObject({ name: "byA", state: { kind: "ready" } });
    expect(todos.readable.get("byB")).toEqual({ kind: "spec-changed" });
    expect(todos.readable.get("byD")).toEqual({ kind: "failed", reason: "value", ids: ["9"] });
    expect(todos.readable.get("byE")).toEqual({ kind: "missing" });
    expect(todos.maintained.map((p) => p.name).sort()).toEqual(["byA", "byB"]);

    const building = bind(encodeCatalog(c2), c2, declare(2, { todos: { byD: { on: "d" } } }));
    expect(building.collections.get("todos")!.readable.get("byD")).toEqual({ kind: "building" });
    expect(building.collections.get("todos")!.maintained.map((p) => p.name).sort()).toEqual(["byA", "byB", "byD"]);
    expect(bind(encodeCatalog(c2), c2, declare(1, { gone: {} })).collections.has("gone")).toBe(false);
  });
});

describe("normalizeSchema", () => {
  it.each<[string, unknown]>([
    ["a version below 1", { version: 0, collections: {} }],
    ["a fractional version", { version: 1.5, collections: {} }],
    ["a collection name with a dash", { version: 1, collections: { "a-b": {} } }],
    ["an index name with a dot", { version: 1, collections: { a: { "x.y": { on: "x" } } } }],
    ["an empty path", { version: 1, collections: { a: { x: { on: "" } } } }],
    ["an empty path segment", { version: 1, collections: { a: { x: { on: "b..c" } } } }],
    ["no paths", { version: 1, collections: { a: { x: { on: [] } } } }],
    ["nine paths", { version: 1, collections: { a: { x: { on: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] } } } }],
    ["a repeated path", { version: 1, collections: { a: { x: { on: ["b", "b"] } } } }],
    ["a unique text index", { version: 1, collections: { a: { x: { on: "b", text: "c", unique: true } } } }],
    ["a drop that is not an array", { version: 1, collections: {}, drop: "a" }],
    ["a dropped name with a dash", { version: 1, collections: {}, drop: ["a-b"] }],
    ["a collection both declared and dropped", { version: 1, collections: { a: {} }, drop: ["a"] }],
  ])("refuses %s with code schema", (_, decl) => {
    expect(codeOf(() => normalizeSchema(decl as never))).toBe("schema");
  });
});
