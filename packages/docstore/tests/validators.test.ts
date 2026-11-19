import type { Db } from "@opfs-lsm/kv";
import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DocStoreError, collection, defineSchema, openDocStore } from "../src/index.js";
import { codeOf, freshName, openKv } from "./harness.js";

const Task = v.object({
  id: v.string(),
  title: v.pipe(v.string(), v.minLength(1)),
  done: v.optional(v.boolean(), false),
  createdAt: v.number(),
});

const Person = z.object({
  id: z.string(),
  joined: z.date().transform((d) => d.getTime()),
});

const Slow = v.objectAsync({ id: v.string() });

const Tag = v.object({
  id: v.pipe(v.string(), v.toLowerCase()),
  label: v.pipe(
    v.string(),
    v.transform((label) => {
      if (label === "boom") throw new RangeError("boom");
      return label;
    }),
  ),
});

const schema = defineSchema({
  version: 1,
  collections: {
    tasks: collection(Task).index("byCreated", "createdAt"),
    people: collection(Person).index("byJoined", "joined"),
    slow: collection(Slow),
    tags: collection(Tag).unique("byLabel", "label"),
  },
});

type Plain = { id: string; title: string; createdAt?: number };
const untyped = defineSchema({
  version: 1,
  collections: { tasks: collection<Plain>().index("byCreated", "createdAt") },
});

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

async function store(name = freshName()) {
  const kv = await openKv(name);
  open.push(kv);
  return { kv, store: await openDocStore(kv, schema) };
}

async function rejection(p: Promise<unknown>): Promise<DocStoreError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof DocStoreError)) throw new Error(`expected a DocStoreError, got ${String(err)}`);
  return err;
}

describe("a collection with a validator", () => {
  it("stores the validator's output, defaults and transforms applied", async () => {
    const { store: s } = await store();
    await s.collection("tasks").put({ id: "t1", title: "Buy milk", createdAt: 1 });
    expect(await s.collection("tasks").get("t1")).toEqual({ id: "t1", title: "Buy milk", done: false, createdAt: 1 });

    const people = s.collection("people");
    await people.put({ id: "p1", joined: new Date(5) });
    expect(await people.get("p1")).toEqual({ id: "p1", joined: 5 });
    expect((await people.query({ index: "byJoined", eq: [5] })).docs.map((d) => d.id)).toEqual(["p1"]);
  });

  it("drops the keys the validator strips", async () => {
    const { store: s } = await store();
    await s.collection("tasks").put({ id: "t1", title: "x", createdAt: 1, extra: 1 } as never);
    expect(await s.collection("tasks").get("t1")).toEqual({ id: "t1", title: "x", done: false, createdAt: 1 });
  });

  it("throws invalid with the issues and the id, and stores nothing of the batch", async () => {
    const { store: s } = await store();
    const tasks = s.collection("tasks");
    const err = await rejection(
      tasks.putMany([
        { id: "ok", title: "fine", createdAt: 1 },
        { id: "bad", title: "", createdAt: 2 },
      ]),
    );
    expect(err.code).toBe("invalid");
    expect(err.ids).toEqual(["bad"]);
    expect(err.issues?.[0]?.path?.map((p) => (typeof p === "object" ? p.key : p))).toEqual(["title"]);
    expect(await tasks.getMany(["ok", "bad"])).toEqual([undefined, undefined]);
    expect(await tasks.count({ index: "byCreated" })).toBe(0);
  });

  it("names no id when the rejected value has none", async () => {
    const { store: s } = await store();
    const err = await rejection(s.collection("tasks").put(null as never));
    expect(err.code).toBe("invalid");
    expect(err.ids).toBeUndefined();
  });

  it("validates what modify returns, and returns the stored output", async () => {
    const { store: s } = await store();
    const tasks = s.collection("tasks");
    await tasks.put({ id: "t1", title: "a", createdAt: 1 });

    const err = await rejection(tasks.modify("t1", (t) => ({ ...t, title: "" })));
    expect([err.code, err.ids]).toEqual(["invalid", ["t1"]]);
    expect(await tasks.get("t1")).toEqual({ id: "t1", title: "a", done: false, createdAt: 1 });

    const { done: _, ...rest } = (await tasks.get("t1"))!;
    expect(await tasks.modify("t1", () => ({ ...rest, title: "b" }))).toEqual({ id: "t1", title: "b", done: false, createdAt: 1 });
  });

  it("validates every document modifyMany returns, and stores none if one fails", async () => {
    const { store: s } = await store();
    const tasks = s.collection("tasks");
    await tasks.putMany([
      { id: "a", title: "a", createdAt: 1 },
      { id: "b", title: "b", createdAt: 2 },
    ]);
    const err = await rejection(
      tasks.modifyMany(["a", "b", "c"], ([a, b]) => [a && { ...a, done: true }, b && { ...b, createdAt: "late" as never }, null]),
    );
    expect([err.code, err.ids]).toEqual(["invalid", ["b"]]);
    expect((await tasks.getMany(["a", "b"])).map((t) => t?.done)).toEqual([false, false]);

    await tasks.modifyMany(["a", "c"], ([a]) => [a && { ...a, title: "A" }, { id: "c", title: "c", createdAt: 3 }]);
    expect(await tasks.getMany(["a", "c"])).toEqual([
      { id: "a", title: "A", done: false, createdAt: 1 },
      { id: "c", title: "c", done: false, createdAt: 3 },
    ]);
  });

  it("throws invalid with no issues for a validator that returns a Promise, in put and in modify", async () => {
    const { kv, store: s } = await store();
    const slow = s.collection("slow");
    const err = await rejection(slow.put({ id: "x" }));
    expect([err.code, err.issues]).toEqual(["invalid", undefined]);
    expect(await slow.get("x")).toBeUndefined();

    const unchecked = defineSchema({ version: 1, collections: { slow: collection<{ id: string }>() } });
    await (await openDocStore(kv, unchecked)).collection("slow").put({ id: "x" });
    expect(await codeOf(slow.modify("x", (d) => d))).toBe("invalid");
    expect(await codeOf(slow.modifyMany(["x"], () => [{ id: "x" }]))).toBe("invalid");
  });

  it("leaves no unhandled rejection when the Promise of a validator rejects", async () => {
    const Failing = v.pipeAsync(
      v.objectAsync({ id: v.string() }),
      v.checkAsync(() => Promise.reject(new Error("boom"))),
    );
    const failing = defineSchema({ version: 1, collections: { docs: collection(Failing) } });
    const kv = await openKv(freshName());
    open.push(kv);
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      expect(await codeOf((await openDocStore(kv, failing)).collection("docs").put({ id: "x" }))).toBe("invalid");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", record);
    }
    expect(unhandled).toEqual([]);
  });

  it("keeps the id rules on the validator's output", async () => {
    const { store: s } = await store();
    const tasks = s.collection("tasks");
    await tasks.put({ id: "t1", title: "a", createdAt: 1 });
    expect(await codeOf(tasks.modify("t1", (t) => ({ ...t, id: "t2" })))).toBe("document");
    expect(await tasks.getMany(["t1", "t2"])).toEqual([{ id: "t1", title: "a", done: false, createdAt: 1 }, undefined]);
  });

  it("stores a put under the id the validator returns", async () => {
    const { store: s } = await store();
    const tags = s.collection("tags");
    await tags.put({ id: "Bug", label: "bug" });
    expect(await tags.getMany(["Bug", "bug"])).toEqual([undefined, { id: "bug", label: "bug" }]);
    await tags.put({ id: "BUG", label: "defect" });
    expect(await tags.count({ index: "byLabel" })).toBe(1);
    expect((await tags.get("bug"))?.label).toBe("defect");
  });

  it("lets an error the validator throws reach the caller, and stores nothing", async () => {
    const { store: s } = await store();
    const tags = s.collection("tags");
    await tags.put({ id: "a", label: "a" });
    await expect(tags.putMany([{ id: "b", label: "b" }, { id: "c", label: "boom" }])).rejects.toThrow(RangeError);
    await expect(tags.modify("a", (t) => ({ ...t, label: "boom" }))).rejects.toThrow(RangeError);
    expect(await tags.getMany(["a", "b", "c"])).toEqual([{ id: "a", label: "a" }, undefined, undefined]);
    await tags.put({ id: "b", label: "b" });
    expect(await tags.count({ index: "byLabel" })).toBe(2);
  });

  it("opens with a changed validator at the same version", async () => {
    const { kv, store: s } = await store();
    await s.collection("tasks").put({ id: "t1", title: "a", createdAt: 1 });
    const Stricter = v.object({ ...Task.entries, title: v.pipe(v.string(), v.minLength(3)) });
    const stricter = defineSchema({
      version: 1,
      collections: { ...schema.collections, tasks: collection(Stricter).index("byCreated", "createdAt") },
    });
    const tasks = (await openDocStore(kv, stricter)).collection("tasks");
    expect((await tasks.get("t1"))?.title).toBe("a");
    expect(await codeOf(tasks.put({ id: "t2", title: "ab", createdAt: 2 }))).toBe("invalid");
  });
});

describe("a collection with no validator", () => {
  it("stores any JSON object with an id, as before", async () => {
    const { kv } = await store();
    const plain = (await openDocStore(kv, untyped)).collection("tasks");
    await plain.put({ id: "t1", title: "" });
    expect(await plain.get("t1")).toEqual({ id: "t1", title: "" });
  });

  it("guards only its own handle: another handle's writes reach the same rows unchecked", async () => {
    const { kv, store: s } = await store();
    await (await openDocStore(kv, untyped)).collection("tasks").put({ id: "t1", title: "" });
    expect(await s.collection("tasks").get("t1")).toEqual({ id: "t1", title: "" });
  });
});

describe("a schema that mixes validated and type-only collections", () => {
  const mixed = defineSchema({
    version: 1,
    collections: {
      tasks: collection(Task).index("byCreated", "createdAt"),
      notes: collection<Plain>().index("byCreated", "createdAt"),
    },
  });

  it("validates the collection with a validator and not the other", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    const s = await openDocStore(kv, mixed);
    expect(await codeOf(s.collection("tasks").put({ id: "t1", title: "", createdAt: 1 }))).toBe("invalid");
    await s.collection("notes").put({ id: "n1", title: "", createdAt: 1 });
    expect(await s.collection("notes").get("n1")).toEqual({ id: "n1", title: "", createdAt: 1 });
    expect(await s.collection("tasks").get("t1")).toBeUndefined();
  });

  it("stores the output of the validator only in its own collection", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    const s = await openDocStore(kv, mixed);
    await s.collection("tasks").put({ id: "t1", title: "a", createdAt: 1 });
    await s.collection("notes").put({ id: "t1", title: "a", createdAt: 1 });
    expect(await s.collection("tasks").get("t1")).toEqual({ id: "t1", title: "a", done: false, createdAt: 1 });
    expect(await s.collection("notes").get("t1")).toEqual({ id: "t1", title: "a", createdAt: 1 });
  });
});
