/**
 * A build that met a value its index cannot hold must not fail the
 * index once a write has replaced that value. The sorted backfill checks
 * that each row it read is unchanged before it commits a step or a failure,
 * and the count build checks the row it fails on the same way.
 */
import type { Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore } from "../src/index.js";
import type { Json } from "../src/schema.js";
import { codeOf, freshName, gate, openKv, storedCatalog } from "./harness.js";

type Todo = { id: string; label?: Json | undefined };

const v1 = defineSchema({ version: 1, collections: { todos: collection<Todo>() } });
const sorted = defineSchema({ version: 2, collections: { todos: collection<Todo>().index("byLabel", "label" as never) } });
const counted = defineSchema({ version: 2, collections: { todos: collection<Todo>().count("perLabel", "label" as never) } });

const kvs: Db[] = [];
afterEach(async () => {
  await Promise.all(kvs.splice(0).map((kv) => kv.close()));
});
async function kvOn(name: string): Promise<Db> {
  const kv = await openKv(name);
  kvs.push(kv);
  return kv;
}

/**
 * Store a row whose label no index can hold, open `schema` with its second
 * kv update (the build's commit or its failure) held, fix the row through
 * the old handle, then let the update through.
 */
async function fixDuringBuild(schema: typeof sorted | typeof counted) {
  const name = freshName();
  const old = (await openDocStore(await kvOn(name), v1)).collection("todos");
  await old.putMany([
    { id: "x", label: { o: 1 } },
    { id: "y", label: "fine" },
  ]);
  const held = gate(await kvOn(name), "update", 1);
  const opening = openDocStore(held.db, schema);
  await held.arrived(2);
  await old.put({ id: "x", label: "fixed" });
  held.release();
  const store = await opening;
  await store.whenIdle();
  return { store, kv: kvs.at(-1)! };
}

describe("a build whose unindexable row is fixed before it commits", () => {
  it("control: a sorted index rescans and is ready", async () => {
    const { store } = await fixDuringBuild(sorted);
    const todos = store.collection("todos");
    expect((await todos.queryIds({ index: "byLabel", eq: ["fixed"] } as never)).ids).toEqual(["x"]);
  });

  it("a count index is ready and counts the fixed row", async () => {
    const { store, kv } = await fixDuringBuild(counted);
    const state = (await storedCatalog(kv)).collections["todos"]!.indexes["perLabel"]!.state;
    expect(state).toEqual({ kind: "ready" });
    const todos = store.collection("todos");
    expect(await codeOf(todos.count({ index: "perLabel", eq: ["fixed"] } as never))).toBe("no error");
    expect(await todos.count({ index: "perLabel", eq: ["fixed"] } as never)).toBe(1);
  });
});
