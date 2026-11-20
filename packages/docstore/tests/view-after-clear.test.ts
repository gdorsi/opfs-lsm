import type { Db, ViewSnapshot } from "@opfs-lsm/kv";
import { afterEach, describe, expect, it } from "vitest";
import { openDocStore } from "../src/index.js";
import { schema } from "./docs.js";
import { freshName, openKv, wrapViews } from "./harness.js";

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((kv) => kv.close()));
});

describe("a query that started before a clear", () => {
  it("does not bring back the cleared documents", async () => {
    const kv = await openKv(freshName());
    open.push(kv);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const pinned = new Promise<void>((r) => (started = r));
    let hold = false;
    const slow = wrapViews(kv, (snap) => ({
      getMany: (async (...args: Parameters<ViewSnapshot["getMany"]>) => {
        if (hold) {
          hold = false;
          started();
          await gate;
        }
        return snap.getMany(...args);
      }) as ViewSnapshot["getMany"],
    }));
    const c = (await openDocStore(slow, schema)).collection("docs");
    await c.put({ id: "x", a: 1 });

    hold = true;
    const query = c.query({ index: "one" });
    await pinned;
    await c.clear();
    await c.put({ id: "x", a: 2 });
    expect(await c.get("x")).toEqual({ id: "x", a: 2 });

    release();
    expect((await query).docs).toEqual([{ id: "x", a: 1 }]);
    expect(await c.get("x")).toEqual({ id: "x", a: 2 });
  });
});
