import { afterEach, describe, expect, it } from "vitest";
import {
  openHarnessDb,
  ingest as ingestDb,
  type AsyncFs,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
} from "../../src/testing.js";
import { deleteWal } from "./check-database.js";

/**
 * Bugs the model suite found, reduced to plain tests. A failing one is
 * marked `it.fails` until the engine is fixed; then drop the `.fails`.
 */

const utf = (s: string) => new TextEncoder().encode(s);
const NAME = "sim-regressions";

afterEach(() => deleteWal(NAME));

async function open() {
  const fs = new MemoryFs();
  return openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
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
  // background"), seed -1085041484, path "177", replayPath "PALAD:V"
  // (KV_MODEL_RUNS=400; fast-check could not shrink it). Its history:
  // tab s2 holds run opens, so a background `sync` reads a tail naming
  // generation 2 and then waits in `load(2)`. Meanwhile an `update` on s2
  // reads a fresher tail, loads and installs generation 3, and drops the
  // memtable rows through seq 8. Then `load(2)` finishes: `load` keeps a
  // generation older than the installed one, and `catchUp` with the stale
  // tail installs it. s2 now reads generation 2 (through seq 5) with no
  // memtable rows for seqs 6..8, a state that is no log prefix, and stays
  // there, because a later tail for generation 3 is not "behind". Its next
  // increment read "c1" instead of "c2" and committed at seq 9: a lost
  // update.
  // Reduced below: the stale `sync` installs generation 1 over generation 2.
  it("a stale catch-up never installs an older generation", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
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
      removeAll: () => fs.removeAll(),
      create: (path) => fs.create(path),
    };
    const ingest = createLocalIngestClient(host);
    const a = await openHarnessDb({ name: NAME, fs, ingest });
    const b = await openHarnessDb({ name: NAME, fs: slowFs, ingest });
    g.BroadcastChannel = channel;
    try {
      await a.put(utf("k"), utf("v1"));
      await ingestDb(a); // generation 1: seq 1
      const parked: (() => void)[] = [];
      held = parked;
      const staleSync = b.sync(); // reads a tail naming generation 1, then waits to open its run
      await until(() => parked.length > 0);
      held = undefined;
      await a.put(utf("k"), utf("v2"));
      await ingestDb(a); // generation 2: seqs 1..2
      // b's update catches up to generation 2 inside its transaction.
      const seen = await b.update([utf("k")], ([v], tx) => {
        tx.put(utf("y"), utf("1"));
        return v && new TextDecoder().decode(v);
      });
      expect(seen).toBe("v2");
      for (const resume of parked) resume();
      await staleSync;
      // b acked seq 3 and read k = v2 at seq 2, so k must still be v2.
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
