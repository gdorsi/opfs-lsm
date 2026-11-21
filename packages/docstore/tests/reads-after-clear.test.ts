import { ingest } from "@opfs-lsm/kv/testing";
import type { Db, ViewSnapshot } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { openDocStore } from "../src/index.js";
import { CATALOG_KEY, bytesEqual } from "../src/keys.js";
import { schema } from "./docs.js";
import { freshName, openKv, openKvWithoutBus, wrapViews } from "./harness.js";

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

  it("read what a query on the same handle just read, while another layer's update catches the handle up", async () => {
    const name = freshName();
    const writer = await handle(name);
    const reader = await handle(name, openKvWithoutBus);
    await writer.c.put({ id: "x", a: 1 });
    await reader.kv.sync();
    expect(await reader.c.get("x")).toEqual({ id: "x", a: 1 });

    await writer.c.clear();
    await writer.c.put({ id: "x", a: 2 });
    await writer.store.whenIdle();

    const other = reader.kv.update([Uint8Array.of(1)], (_, tx) => tx.put(Uint8Array.of(1), Uint8Array.of(1)));
    while ((await reader.c.query({})).docs[0]?.a !== 2) await new Promise((r) => setImmediate(r));
    expect(await reader.c.get("x")).toEqual({ id: "x", a: 2 });
    expect(await reader.c.getMany(["x"])).toEqual([{ id: "x", a: 2 }]);
    await other;
  });

  it("read the state of their snapshot while kv has not announced another handle's clear yet", async () => {
    const name = freshName();
    const writer = await handle(name);
    const reader = await handle(name, openKvWithoutBus);
    await writer.c.put({ id: "x", a: 1 });
    await reader.kv.sync();
    expect(await reader.c.get("x")).toEqual({ id: "x", a: 1 });

    await writer.c.clear();
    await writer.c.put({ id: "x", a: 2 });
    await writer.store.whenIdle();

    const seq = () => reader.kv.view((snap) => snap.seq);
    const before = await seq();
    // Its transaction applies the writer's records, and kv announces them once it ends.
    const other = reader.kv.update([Uint8Array.of(1)], (_, tx) => tx.put(Uint8Array.of(1), Uint8Array.of(1)));
    while ((await seq()) === before) await new Promise((r) => setImmediate(r));
    expect(await reader.c.get("x")).toEqual({ id: "x", a: 2 });
    expect(await reader.c.getMany(["x"])).toEqual([{ id: "x", a: 2 }]);
    expect((await reader.c.query({ index: "one" })).docs).toEqual([{ id: "x", a: 2 }]);
    await other;
  });

  it("read the catalog once for records this handle read before kv announced them", async () => {
    const name = freshName();
    const writer = await handle(name);
    let catalogReads = 0;
    const reader = await handle(name, async (n) =>
      wrapViews(await openKvWithoutBus(n), (snap) => ({
        getMany: ((...args: Parameters<ViewSnapshot["getMany"]>) => {
          if (bytesEqual(args[0][0], CATALOG_KEY)) catalogReads++;
          return snap.getMany(...args);
        }) as ViewSnapshot["getMany"],
      })),
    );
    await writer.c.put({ id: "x", a: 1 });
    await reader.kv.sync();
    expect(await reader.c.get("x")).toEqual({ id: "x", a: 1 });
    expect(catalogReads).toBe(1);

    await writer.c.put({ id: "y", a: 2 });
    const other = reader.kv.update([Uint8Array.of(1)], (_, tx) => tx.put(Uint8Array.of(1), Uint8Array.of(1)));
    while ((await reader.c.get("y")) === undefined) await new Promise((r) => setImmediate(r));
    expect(await reader.c.getMany(["x", "y"])).toEqual([{ id: "x", a: 1 }, { id: "y", a: 2 }]);
    await other;
    expect(await reader.c.get("y")).toEqual({ id: "y", a: 2 });
    expect(catalogReads).toBe(2);
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
