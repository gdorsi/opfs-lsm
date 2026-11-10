import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryFs } from "../src/index.js";
import { RECLAIM_LAG } from "../src/host/queues.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";

const NAME = "installed-manifest";
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const text = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);

beforeEach(() => __resetMemoryFsForTests(NAME));
afterEach(() => __resetMemoryFsForTests(NAME));

/** Counts `list` calls, which a read must not need once its generation is installed. */
function observedFs(inner: MemoryFs) {
  let lists = 0;
  const fs: AsyncFs = {
    read: (path, offset, length) => inner.read(path, offset, length),
    async list(dir) {
      lists += 1;
      return inner.list(dir);
    },
    remove: (path) => inner.remove(path),
    open: (path) => inner.open(path),
    removeUnlessOpen: (path) => inner.removeUnlessOpen(path),
    create: (path) => inner.create(path),
  };
  return { fs, segments: inner.segments, lists: () => lists };
}

describe("the installed manifest", () => {
  it("a view pinned before a batch sees none of it after ingest", async () => {
    const db = await openHarnessDb({ name: NAME, fs: new MemoryFs() });
    await db.put(utf("z"), utf("0"));
    await db.ingest();
    await db.put(utf("a"), utf("1"));

    const seen = await db.view(async (snap) => {
      await db.batch((tx) => {
        tx.put(utf("a"), utf("2"));
        tx.put(utf("b"), utf("2"));
      });
      await db.ingest();
      return [text(await snap.get(utf("a"))), text(await snap.get(utf("b")))];
    });

    expect(seen).toEqual(["1", undefined]);
    expect(text(await db.get(utf("b")))).toBe("2");
    await db.close();
  });

  it("the host keeps the newest RECLAIM_LAG + 1 manifests, and every key reads back", async () => {
    const inner = new MemoryFs();
    const db = await openHarnessDb({ name: NAME, fs: inner });
    for (let i = 0; i < 6; i++) {
      await db.put(utf(`k${i}`), utf(`v${i}`));
      await db.ingest();
    }
    expect(await inner.list("m")).toHaveLength(RECLAIM_LAG + 1);
    for (let i = 0; i < 6; i++) {
      expect(text(await db.get(utf(`k${i}`)))).toBe(`v${i}`);
    }
    await db.close();
  });

  it("a get after ingest does not list OPFS", async () => {
    const o = observedFs(new MemoryFs());
    const db = await openHarnessDb({ name: NAME, fs: o.fs, segments: o.segments });
    for (let i = 0; i < 20; i++) await db.put(utf(`k${i}`), utf(`v${i}`));
    await db.ingest();
    const before = o.lists();
    for (let i = 0; i < 20; i++) {
      expect(text(await db.get(utf(`k${i}`)))).toBe(`v${i}`);
    }
    expect(o.lists()).toBe(before);
    await db.close();
  });
});
