import { describe, expect, it } from "vitest";
import type { AsyncFs } from "../../src/index.js";
import { MemoryFs } from "../../src/index.js";
import { Host, openHarnessDb } from "../../src/testing.js";

/**
 * Bugs the model suite found, reduced to plain tests. A failing one is
 * marked `it.fails` until the engine is fixed; then drop the `.fails`.
 */

const utf = (s: string) => new TextEncoder().encode(s);
const NAME = "sim-regressions";

async function open() {
  return openHarnessDb({ name: NAME, fs: new MemoryFs() });
}

describe("model suite regressions", () => {
  // Found by model.test.ts, seed -2023477141, shrunk to:
  //   [view[range {}] with put "" 0a before read 0, view[range {"limit":0}]]
  // `mergeCursors` and `scanMatching` checked the limit after yielding, so
  // `limit: 0` yielded one entry.
  it("range with limit 0 returns nothing", async () => {
    const db = await open();
    await db.put(utf("a"), utf("1"));
    const out = [];
    for await (const e of db.range({ limit: 0 })) out.push(e);
    await db.close();
    expect(out).toEqual([]);
  });

  // Found by multi-handle.test.ts ("holds with the host ingesting in the
  // background"), seed -1085041484, path "177", replayPath "PALAD:V", on
  // the IndexedDB WAL: tab s2 holds run opens, so a background `sync` reads
  // generation 2 and then waits in `load(2)`. Meanwhile s2 loads and
  // installs generation 3. Then `load(2)` finished and installed the older
  // generation over the newer one: s2 read a state that is no installed
  // prefix, and its next increment was lost. Kept for the per-tab logs: a
  // load that finishes late never installs an older generation.
  it("a stale catch-up never installs an older generation", async () => {
    const fs = new MemoryFs();
    const host = new Host(() => fs);
    // Without BroadcastChannel, nothing but these calls moves either tab.
    const g = globalThis as { BroadcastChannel?: unknown };
    const channel = g.BroadcastChannel;
    g.BroadcastChannel = undefined;
    let held: (() => void)[] | undefined;
    const slowFs: AsyncFs = {
      read: (path, offset, length) => fs.read(path, offset, length),
      open: async (path) => {
        if (held) await new Promise<void>((resolve) => held!.push(resolve));
        return fs.open(path);
      },
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
    };
    const a = await openHarnessDb({ name: NAME, fs, host });
    const b = await openHarnessDb({ name: NAME, fs: slowFs, segments: fs.segments, host });
    g.BroadcastChannel = channel;
    try {
      await a.put(utf("k"), utf("v1"));
      await a.ingest();
      const parked: (() => void)[] = [];
      held = parked;
      const staleSync = b.sync(); // loads the generation with v1, then waits to open its run
      await until(() => parked.length > 0);
      held = undefined;
      await a.put(utf("k"), utf("v2"));
      await a.ingest();
      // The first sync still waits to open its run; this one loads v2's generation after it.
      const freshSync = b.sync();
      for (const resume of parked) resume();
      await staleSync;
      await freshSync;
      expect(new TextDecoder().decode((await b.get(utf("k")))!)).toBe("v2");
    } finally {
      await a.close();
      await b.close();
    }
  });
});

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((resolve) => setImmediate(resolve));
  if (!cond()) throw new Error("condition never held");
}
