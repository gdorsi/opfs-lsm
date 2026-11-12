import { ingest } from "@opfs-lsm/kv/testing";
import type { Db } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { openDocStore } from "../src/index.js";
import { schema } from "./docs.js";
import { freshName, openKv, openKvWithoutBus } from "./harness.js";

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

async function handle(name: string, connect = openKv) {
  const kv = await connect(name);
  open.push(kv);
  const store = await openDocStore(kv, schema);
  return { kv, store, c: store.collection("docs") };
}

describe("get and getMany after another handle cleared the collection", () => {
  it("read the rows written after the clear, once this handle has its records", async () => {
    const name = freshName();
    const reader = await handle(name);
    const writer = await handle(name);
    await reader.c.put({ id: "x", a: 1 });
    expect(await reader.c.get("x")).toEqual({ id: "x", a: 1 });

    await writer.c.clear();
    await writer.c.put({ id: "x", a: 2 });
    await reader.kv.sync();
    expect(await reader.c.get("x")).toEqual({ id: "x", a: 2 });
    expect(await reader.c.getMany(["x", "gone"])).toEqual([{ id: "x", a: 2 }, undefined]);
  });

  it("read them when a flush folded the clear before this handle saw its record", async () => {
    const name = freshName();
    const writer = await handle(name);
    const reader = await handle(name, openKvWithoutBus);
    await writer.c.put({ id: "x", a: 1 });
    await reader.kv.sync();
    expect(await reader.c.get("x")).toEqual({ id: "x", a: 1 });

    await writer.c.clear();
    await writer.c.put({ id: "x", a: 2 });
    await writer.store.whenIdle();
    await ingest(writer.kv);
    await reader.kv.sync();
    expect(await reader.c.get("x")).toEqual({ id: "x", a: 2 });
  });

  it("read them on a handle that opened its store before the clear and never read since", async () => {
    const name = freshName();
    const writer = await handle(name);
    const reader = await handle(name);
    await writer.c.put({ id: "x", a: 1 });
    await writer.c.clear();
    await writer.c.put({ id: "x", a: 2 });
    await reader.kv.sync();
    expect(await reader.c.get("x")).toEqual({ id: "x", a: 2 });
  });
});
