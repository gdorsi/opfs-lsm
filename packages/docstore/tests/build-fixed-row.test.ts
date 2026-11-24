/**
 * A build that met a value its index cannot hold must not fail the
 * index once a write has replaced that value. The backfill checks that
 * each row it read is unchanged before it commits a step or a failure.
 */
import type { Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { collection, defineSchema, openDocStore } from "../src/index.js";
import type { Json } from "../src/schema.js";
import { freshName, gate, openKv } from "./harness.js";

type Todo = { id: string; label?: Json | undefined };

const v1 = defineSchema({ version: 1, collections: { todos: collection<Todo>() } });
const sorted = defineSchema({ version: 2, collections: { todos: collection<Todo>().index("byLabel", "label" as never) } });

const kvs: Db[] = [];
afterEach(async () => {
  await Promise.all(kvs.splice(0).map((kv) => kv.close()));
});
async function kvOn(name: string): Promise<Db> {
  const kv = await openKv(name);
  kvs.push(kv);
  return kv;
}

describe("a build whose unindexable row is fixed before it commits", () => {
  it("rescans, and the sorted index is ready", async () => {
    const name = freshName();
    const old = (await openDocStore(await kvOn(name), v1)).collection("todos");
    await old.putMany([
      { id: "x", label: { o: 1 } },
      { id: "y", label: "fine" },
    ]);
    // The second kv update is the build's commit or its failure.
    const held = gate(await kvOn(name), "update", 1);
    const opening = openDocStore(held.db, sorted);
    await held.arrived(2);
    await old.put({ id: "x", label: "fixed" });
    held.release();
    const store = await opening;
    await store.whenIdle();
    expect((await store.collection("todos").queryIds({ index: "byLabel", eq: ["fixed"] } as never)).ids).toEqual(["x"]);
  });
});
