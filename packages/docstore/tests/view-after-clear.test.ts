import type { Db, ViewSnapshot } from "@opfs-lsm/kv";
import { ingest } from "@opfs-lsm/kv/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDocStore } from "../src/index.js";
import { schema } from "./docs.js";
import { freshName, keysUnder, openKv, openKvWithoutBus, storedPrefix, wrap, wrapViews } from "./harness.js";

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

/**
 * `kv` whose views wait in their next `getMany` after each `hold()`, which
 * resolves once that read arrived and gives its release.
 */
function holdingReads(kv: Db) {
  const waiting: { arrived: () => void; released: Promise<void> }[] = [];
  const db = wrapViews(kv, (snap) => ({
    getMany: (async (...args: Parameters<ViewSnapshot["getMany"]>) => {
      const held = waiting.shift();
      held?.arrived();
      await held?.released;
      return snap.getMany(...args);
    }) as ViewSnapshot["getMany"],
  }));
  const hold = () => {
    let release!: () => void;
    let arrived!: () => void;
    const pinned = new Promise<void>((r) => (arrived = r));
    waiting.push({ arrived, released: new Promise((r) => (release = r)) });
    return { pinned, release };
  };
  return { db, hold };
}

describe("a query that started before a clear", () => {
  it("does not bring back the cleared documents", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    const { db, hold } = holdingReads(kv);
    const c = (await openDocStore(db, schema)).collection("docs");
    await c.put({ id: "x", a: 1 });

    const { pinned, release } = hold();
    const query = c.query({ index: "one" });
    await pinned;
    await c.clear();
    await c.put({ id: "x", a: 2 });
    expect(await c.get("x")).toEqual({ id: "x", a: 2 });

    release();
    expect((await query).docs).toEqual([{ id: "x", a: 1 }]);
    expect(await c.get("x")).toEqual({ id: "x", a: 2 });
  });

  it("deletes the old rows in the clear's write though a query from before it resolves just after", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    const { db, hold } = holdingReads(kv);
    let afterWrite: (() => Promise<unknown>) | undefined;
    const store = await openDocStore(
      wrap(db, {
        update: async (keys, body) => {
          const out = await kv.update(keys, body);
          const run = afterWrite;
          afterWrite = undefined;
          await run?.();
          return out;
        },
      }),
      schema,
    );
    const c = store.collection("docs");
    await c.put({ id: "x", a: 1 });
    const old = await storedPrefix(kv, "docs");

    const { pinned, release } = hold();
    const query = c.query({ index: "one" });
    await pinned;
    afterWrite = () => (release(), query);
    await c.clear();
    await store.whenIdle();
    expect((await query).docs).toEqual([{ id: "x", a: 1 }]);
    expect(await keysUnder(kv, old)).toBe(0);
  });
});

describe("two views in flight, one from before another handle's clear and one from after it", () => {
  it.each(["older", "newer"] as const)("each read their own snapshot when the %s one resolves first", async (first) => {
    const name = freshName();
    const writerKv = await openKv(name);
    const kv = await openKvWithoutBus(name);
    open.push(writerKv, kv);
    const writerStore = await openDocStore(writerKv, schema);
    const writer = writerStore.collection("docs");
    const { db, hold } = holdingReads(kv);
    const c = (await openDocStore(db, schema)).collection("docs");
    await writer.put({ id: "x", a: 1 });
    await kv.sync();

    const older = hold();
    const before = c.view((snap) => snap.get("x"));
    await older.pinned;
    await writer.clear();
    await writer.put({ id: "x", a: 2 });
    await writerStore.whenIdle();
    // The flush folds the clear, so this handle skips its record and reads the catalog again.
    await ingest(writerKv);
    await kv.sync();
    const newer = hold();
    const after = c.view((snap) => snap.get("x"));
    await newer.pinned;

    const [one, other] = first === "older" ? [older, newer] : [newer, older];
    one.release();
    await (first === "older" ? before : after);
    other.release();
    expect(await before).toEqual({ id: "x", a: 1 });
    expect(await after).toEqual({ id: "x", a: 2 });
    expect(await c.get("x")).toEqual({ id: "x", a: 2 });
    expect((await c.query({ index: "one" })).docs).toEqual([{ id: "x", a: 2 }]);
  });
});
