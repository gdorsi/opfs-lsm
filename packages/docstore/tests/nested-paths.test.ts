/**
 * `by` takes a dot path, and so do the array field of a multi index and the
 * text field of a text index. The model test declares top-level fields only.
 */
import type { Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore } from "../src/index.js";
import { freshName, openKv } from "./harness.js";

type Task = {
  id: string;
  at: number;
  meta?: {
    due?: number;
    owner?: { name?: string; team?: { lead?: string } };
    labels?: string[];
    note?: string | null;
  };
};

const schema = defineSchema({
  version: 1,
  collections: {
    tasks: collection<Task>()
      .index("byOwnerDue", ["meta.owner.name", "meta.due"])
      .index("byLead", "meta.owner.team.lead")
      .index("byLabel", "meta.labels[]")
      .text("search", "at", "meta.note"),
  },
});

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

async function tasks() {
  const kv = await openKv(freshName());
  open.push(kv);
  return (await openDocStore(kv, schema)).collection("tasks");
}

describe("an index on a dot path", () => {
  it("reads the value at the path, and gives no entry to a document that lacks a segment of it", async () => {
    const c = await tasks();
    await c.putMany([
      { id: "t1", at: 1, meta: { owner: { name: "ann", team: { lead: "l@x" } }, due: 2, labels: ["x", "y"], note: "Buy milk" } },
      { id: "t2", at: 2, meta: { owner: { name: "ann" }, due: 1, labels: ["y"], note: null } },
      { id: "t3", at: 3, meta: { owner: {} } },
      { id: "t4", at: 4 },
    ]);
    expect((await c.queryEntries({ index: "byOwnerDue" })).entries).toEqual([
      { id: "t2", values: ["ann", 1] },
      { id: "t1", values: ["ann", 2] },
    ]);
    expect((await c.queryEntries({ index: "byLead" })).entries).toEqual([{ id: "t1", values: ["l@x"] }]);
    expect((await c.queryEntries({ index: "byLabel" })).entries).toEqual([
      { id: "t1", values: ["x"] },
      { id: "t1", values: ["y"] },
      { id: "t2", values: ["y"] },
    ]);
    expect((await c.queryIds({ index: "byLabel", eq: ["y"] })).ids).toEqual(["t1", "t2"]);
    expect((await c.queryIds({ index: "search" })).ids).toEqual(["t1", "t2"]);
    expect((await c.queryIds({ index: "search", match: "milk" })).ids).toEqual(["t1"]);
  });

  it("moves a document's entries when a write changes or removes the value at the path", async () => {
    const c = await tasks();
    await c.putMany([
      { id: "t1", at: 1, meta: { owner: { name: "ann" }, due: 2, labels: ["x", "y"], note: "Buy milk" } },
      { id: "t2", at: 2, meta: { owner: { name: "ann" }, due: 1, labels: ["y"], note: "Fix window" } },
    ]);

    await c.modify("t1", (t) => ({ ...t, meta: { owner: { name: "bob" }, labels: ["z"], note: "Call mom" } }));
    expect((await c.queryEntries({ index: "byOwnerDue" })).entries).toEqual([{ id: "t2", values: ["ann", 1] }]);
    expect((await c.queryIds({ index: "byLabel", eq: ["x"] })).ids).toEqual([]);
    expect((await c.queryIds({ index: "byLabel", eq: ["z"] })).ids).toEqual(["t1"]);
    expect((await c.queryIds({ index: "search", match: "milk" })).ids).toEqual([]);
    expect((await c.queryIds({ index: "search", match: "mom" })).ids).toEqual(["t1"]);

    await c.modify("t2", (doc) => {
      const rest = { ...doc };
      delete rest.meta;
      return rest;
    });
    expect((await c.queryIds({ index: "byOwnerDue" })).ids).toEqual([]);
    expect((await c.queryIds({ index: "byLabel" })).ids).toEqual(["t1"]);
    expect((await c.queryIds({ index: "search" })).ids).toEqual(["t1"]);
  });

  it("never enters an array, even at a key the array has", async () => {
    type Holder = { id: string; m: { length: number } | string[] };
    const schema = defineSchema({ version: 1, collections: { holders: collection<Holder>().index("len", "m.length") } });
    const kv = await openKv(freshName());
    open.push(kv);
    const c = (await openDocStore(kv, schema)).collection("holders");
    await c.putMany([
      { id: "arr", m: ["x", "y"] },
      { id: "obj", m: { length: 2 } },
    ]);
    expect((await c.queryEntries({ index: "len" })).entries).toEqual([{ id: "obj", values: [2] }]);
  });
});
