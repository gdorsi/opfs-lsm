import { describe, expect, it } from "vitest";
import type { AsyncFs } from "../../src/index.js";
import { EngineHost, MemoryFs, createLocalIngestClient } from "../../src/index.js";
import { openHarnessDb } from "../../src/testing.js";
import { reclaimLogs } from "../../src/host/ingest.js";
import { recoverGeneration } from "../../src/recover.js";
import { reclaimManifests } from "../../src/store/generation.js";

/**
 * Bugs the model suite found, reduced to plain tests. A failing one is
 * marked `it.fails` until the engine is fixed; then drop the `.fails`.
 */

const utf = (s: string) => new TextEncoder().encode(s);
const NAME = "sim-regressions";


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
  // With per-tab logs, tabs exchange promises over BroadcastChannel, so it
  // stays on: b's parked load still finishes after generation 2 is in.
  it("a stale catch-up never installs an older generation", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
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
    const ingest = createLocalIngestClient(host);
    const a = await openHarnessDb({ name: NAME, fs, ingest });
    const b = await openHarnessDb({ name: NAME, fs: slowFs, ingest });
    try {
      await a.put(utf("k"), utf("v1"));
      await a.ingest(); // generation 1: seq 1
      const parked: (() => void)[] = [];
      held = parked;
      const staleSync = b.sync(); // finds generation 1, then waits to open its run
      await until(() => parked.length > 0);
      held = undefined;
      await a.put(utf("k"), utf("v2"));
      await a.ingest(); // generation 2: seqs 1..2
      // b's update reads everything ordered before it: generation 2 or the log.
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

describe("multi-handle regressions", () => {
  // Found by multi-handle.test.ts, shrunk to
  //   [0: update["":keep] &, step 2, drop next 2 messages, 0: increment &]
  // The update asks the other tabs to promise past its stamp (`advance`).
  // Their answer was lost, and a tab answers an `advance` only above what
  // it promised last, so the update's retries went unanswered: it waited
  // forever, and every later write on its tab with it. A promise is in no
  // log, so a retry now gets the last one sent again.
  it("an update whose promise was lost still finishes", async () => {
    const g = globalThis as { BroadcastChannel: typeof BroadcastChannel };
    const Real = g.BroadcastChannel;
    // Once armed: the first `advance`, then drop the first answer to it.
    let drop = 0;
    let asked: number | undefined;
    g.BroadcastChannel = class extends Real {
      override postMessage(msg: unknown): void {
        const m = msg as { kind?: string; stamp?: number; again?: boolean } | null;
        if (drop > 0 && m?.kind === "advance" && asked === undefined) asked = m.stamp;
        if (drop > 0 && asked !== undefined && m?.kind === "promise" && m.stamp! >= asked) {
          drop--;
          return;
        }
        super.postMessage(msg);
      }
    };
    const fs = new MemoryFs();
    const ingest = createLocalIngestClient(new EngineHost(() => fs));
    const a = await openHarnessDb({ name: NAME, fs, ingest });
    const b = await openHarnessDb({ name: NAME, fs, ingest });
    try {
      await b.put(utf("k"), utf("1"));
      drop = 1;
      const done = a.update([utf("k")], ([v], tx) => tx.put(utf("k"), utf(`${v ? new TextDecoder().decode(v) : ""}+`)));
      const hang = new Promise((_, reject) => setTimeout(() => reject(new Error("update hung")), 2_000));
      await Promise.race([done, hang]);
      expect(drop, "a promise was dropped").toBe(0);
      expect(new TextDecoder().decode((await a.get(utf("k")))!)).toBe("1+");
    } finally {
      g.BroadcastChannel = Real;
      await a.close();
      await b.close();
    }
  });
});

describe("host-chosen cut", () => {
  // Found by multi-handle.test.ts: a tab read a key that a write acked
  // before its open had deleted. A host flush with no cut asked for picks
  // the lowest last stamp among the live tabs. It queried the live tabs
  // before it listed the logs, so a tab that took its liveness lock in
  // between counted as neither live nor written. That tab joined, took a
  // stamp below the cut the other tab's newer write set, and wrote it
  // after the fold read the logs: the generation's cut covered a record it
  // did not hold, and every tab skipped it.
  it("a tab that joins while the host picks its cut keeps its write", async () => {
    const fs = new MemoryFs();
    let parkHost: (() => void)[] | undefined;
    const hostFs: AsyncFs = {
      read: (path, offset, length) => fs.read(path, offset, length),
      open: (path) => fs.open(path),
      list: async (dir) => {
        if (dir === "w" && parkHost) await new Promise<void>((resolve) => parkHost!.push(resolve));
        return fs.list(dir);
      },
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
      segments: () => fs.segments(),
    };
    let parkZ: (() => void)[] | undefined;
    const zFs: AsyncFs = {
      read: (path, offset, length) => fs.read(path, offset, length),
      open: (path) => fs.open(path),
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
      segments: () => ({
        create: async (path) => {
          if (parkZ) await new Promise<void>((resolve) => parkZ!.push(resolve));
          return fs.segments().create(path);
        },
      }),
    };
    const host = new EngineHost(() => hostFs);
    const ingest = createLocalIngestClient(host);
    const x = await openHarnessDb({ name: NAME, fs, ingest });
    let z: Awaited<ReturnType<typeof openHarnessDb>> | undefined;
    try {
      await x.put(utf("a"), utf("1"));
      parkHost = [];
      const flushing = host.ingest(NAME, Number.POSITIVE_INFINITY, false);
      await until(() => parkHost!.length > 0);
      // Z opens and stamps a put; its log write waits.
      z = await openHarnessDb({ name: NAME, fs: zFs, ingest });
      parkZ = [];
      const zPut = z.put(utf("z"), utf("1"));
      await until(() => parkZ!.length > 0);
      // X writes above Z's stamp. Then the host picks its cut and folds.
      await x.put(utf("b"), utf("1"));
      const resumeHost = parkHost;
      parkHost = undefined;
      for (const r of resumeHost) r();
      await flushing;
      // Z's write lands after the fold read the logs.
      const resumeZ = parkZ;
      parkZ = undefined;
      for (const r of resumeZ) r();
      await zPut;
      await z.sync();
      await x.sync();
      const reader = await openHarnessDb({ name: NAME, fs, ingest });
      const got = new TextDecoder().decode((await reader.get(utf("z"))) ?? new Uint8Array());
      await reader.close();
      expect(got, "a fresh tab reads z's write").toBe("1");
    } finally {
      await x.close();
      await z?.close();
    }
  });
});

describe("sync", () => {
  // Found by multi-handle.test.ts, shrunk to
  //   [0: batch[put "b" …] &, 1: del "", 1: sync, 1: range …]
  // Tab 0's batch took a stamp below tab 1's delete but was still being
  // written. Tab 1's sync waited only for other tabs' records it had seen,
  // so its range read its own delete on top of a prefix without the batch:
  // after a sync, a read is one prefix of the order, own writes included.
  it("after a sync a tab's own writes are stable, with everything ordered before them", async () => {
    const fs = new MemoryFs();
    let parkA: (() => void)[] | undefined;
    const aFs: AsyncFs = {
      read: (path, offset, length) => fs.read(path, offset, length),
      open: (path) => fs.open(path),
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
      segments: () => ({
        create: async (path) => {
          if (parkA) await new Promise<void>((resolve) => parkA!.push(resolve));
          return fs.segments().create(path);
        },
      }),
    };
    const ingest = createLocalIngestClient(new EngineHost(() => fs));
    const a = await openHarnessDb({ name: NAME, fs: aFs, ingest });
    const b = await openHarnessDb({ name: NAME, fs, ingest });
    try {
      parkA = [];
      const aPut = a.put(utf("a"), utf("1"));
      await until(() => parkA!.length > 0);
      await b.put(utf("b"), utf("1"));
      let synced = false;
      const syncing = b.sync().then(() => (synced = true));
      for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(synced, "sync waits for a's write, ordered before b's").toBe(false);
      const resume = parkA;
      parkA = undefined;
      for (const r of resume) r();
      await aPut;
      await syncing;
      const keys: string[] = [];
      for await (const e of b.range()) keys.push(new TextDecoder().decode(e.key));
      expect(keys).toEqual(["a", "b"]);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("reclaimed segments", () => {
  // A tab that missed another tab's records (lost broadcasts) reads its log
  // later, after an ingest folded them and reclaim removed their segments.
  // The read went on at the oldest segment left, and the tab handed out the
  // records after the gap numbered as if the missing ones did not exist:
  // a state that is no log prefix (a later write, without an earlier one),
  // until a later generation dropped rows by the wrong numbers. Now it hands
  // out nothing past the gap until a generation covering it is installed.
  it("a tab that missed records now reclaimed waits for their generation", async () => {
    const g = globalThis as { BroadcastChannel: typeof BroadcastChannel };
    const Real = g.BroadcastChannel;
    // R never hears of an ingest, and is deaf to W's records while `deaf`.
    let tagging = false;
    let deaf = false;
    class Tap extends Real {
      private readonly tagged = tagging;
      private blocks(data: unknown): boolean {
        const kind = (data as { kind?: string } | null)?.kind;
        return this.tagged && (kind === "ingest" || (deaf && (kind === "rec" || kind === "promise")));
      }
      override get onmessage() {
        return super.onmessage;
      }
      override set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        super.onmessage = fn && ((ev: MessageEvent) => (this.blocks(ev.data) ? undefined : fn(ev)));
      }
      override addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
        super.addEventListener(type, (ev) => (this.blocks((ev as MessageEvent).data) ? undefined : fn(ev as MessageEvent)));
      }
    }
    g.BroadcastChannel = Tap as unknown as typeof BroadcastChannel;
    const fs = new MemoryFs();
    const ingest = createLocalIngestClient(new EngineHost(() => fs));
    const w = await openHarnessDb({ name: NAME, fs, ingest, ingestPolicy: { maxWalBytes: 64 } });
    tagging = true;
    // Its own host: W's ingests reach R only through the files.
    const r = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
    tagging = false;
    const read = async (k: string) => {
      const v = await r.get(utf(k));
      return v && new TextDecoder().decode(v);
    };
    try {
      await w.put(utf("k1"), utf("v1"));
      await untilAsync(async () => (await read("k1")) === "v1");
      deaf = true;
      for (const k of ["k2", "k3", "k4"]) await w.put(utf(k), utf(`v${k[1]}`));
      await w.ingest();
      const [tab] = await fs.list("w");
      const oldest = (await fs.list(`w/${tab}`)).sort()[0]!;
      expect(Number(oldest.slice(0, 10)), "reclaim removed W's first segments").toBeGreaterThan(2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      deaf = false;
      // W's next record reaches R, which finds a gap and reads W's log.
      await w.put(utf("k5"), utf("v5"));
      await untilAsync(async () => (await read("k5")) === "v5");
      expect(await read("k2"), "k2 came before k5").toBe("v2");
      expect(await read("k4")).toBe("v4");
    } finally {
      g.BroadcastChannel = Real;
      await w.close();
      await r.close();
    }
  });
});

describe("a dead tab's log reclaimed whole", () => {
  // Found by multi-handle.test.ts ("holds with the host ingesting in the
  // background"), seed -1519416426, shrunk to [1: close, 0: increment,
  // 2: bulk put 50 &, 0: close, host flush &, drop next 3 messages,
  // 2: increment, 0: open]: an update read "ctr" as undefined though a
  // closed tab's increment came before it. That tab's record never reached
  // the reader (lost broadcast), the host folded it and, the tab being
  // dead, removed its whole log. Retiring the tab, the reader found no log,
  // took it for a tab that never wrote, and moved its watermark past the
  // record. Now a dead tab whose log is gone waits for the newest
  // generation, which holds whatever it wrote.
  it("an update after it still reads what that tab wrote", async () => {
    const g = globalThis as { BroadcastChannel: typeof BroadcastChannel };
    const Real = g.BroadcastChannel;
    // R hears no ingest at all, and while `deaf` none of W's records,
    // promises or goodbye: only W's requests to promise, which it answers.
    let tagging = false;
    let deaf = false;
    class Tap extends Real {
      private readonly tagged = tagging;
      private blocks(data: unknown): boolean {
        const kind = (data as { kind?: string } | null)?.kind;
        return this.tagged && (kind === "ingest" || (deaf && (kind === "rec" || kind === "promise" || kind === "bye")));
      }
      override get onmessage() {
        return super.onmessage;
      }
      override set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        super.onmessage = fn && ((ev: MessageEvent) => (this.blocks(ev.data) ? undefined : fn(ev)));
      }
      override addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
        super.addEventListener(type, (ev) => (this.blocks((ev as MessageEvent).data) ? undefined : fn(ev as MessageEvent)));
      }
    }
    g.BroadcastChannel = Tap as unknown as typeof BroadcastChannel;
    const fs = new MemoryFs();
    const w = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
    tagging = true;
    const r = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
    tagging = false;
    try {
      deaf = true;
      await w.put(utf("k1"), utf("v1"));
      await w.ingest();
      await w.close();
      // W is dead and its record is in the generation: reclaim leaves a
      // tombstone, then removes it once every manifest covers it.
      const { meta } = await recoverGeneration(fs, () => false);
      await reclaimLogs(fs, NAME, meta.cut);
      await reclaimManifests(fs, meta.generation);
      await reclaimLogs(fs, NAME, meta.cut);
      expect(await fs.list("w"), "W's log is gone").toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const seen = await r.update([utf("k1")], ([v], tx) => {
        tx.put(utf("k1"), utf("v2"));
        return v && new TextDecoder().decode(v);
      });
      expect(seen, "W's write came before the update").toBe("v1");
    } finally {
      g.BroadcastChannel = Real;
      await r.close();
    }
  });
});

describe("a tab whose log fails", () => {
  // Found by the Chrome kill loop (kind `quota`): once a tab's log write
  // failed for lack of space, the other tabs' `ingest()` hung. The failed
  // tab stayed live but could not flush or promise past the records it had
  // written, so it held every other tab's watermark forever. Now it leaves
  // as on close, and the others retire it by reading its log.
  it("leaves, so the other tabs go on", async () => {
    const fs = new MemoryFs();
    let full = false;
    const failing = new Proxy(fs, {
      get(target, prop) {
        if (prop === "segments") {
          return () => {
            const store = target.segments!();
            return {
              async create(path: string) {
                const f = await store.create(path);
                return {
                  write(bytes: Uint8Array, at: number) {
                    if (full) throw new Error("No space available for this operation");
                    return f.write(bytes, at);
                  },
                  flush() {
                    if (full) throw new Error("No space available for this operation");
                    f.flush();
                  },
                  getSize: () => f.getSize(),
                  close: () => f.close(),
                  ...(f.settled ? { settled: () => f.settled!() } : {}),
                };
              },
            };
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const host = new EngineHost(() => fs);
    const a = await openHarnessDb({ name: NAME, fs: failing, ingest: createLocalIngestClient(host) });
    const b = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(host) });
    try {
      // Written, not yet flushed: the flush fails.
      const first = a.put(utf("k1"), utf("v1"));
      await first;
      full = true;
      await expect(a.put(utf("k2"), utf("v2"))).rejects.toThrow(/No space/);
      // Stable only once every live tab promised past it.
      await b.put(utf("k3"), utf("v3"));
      const ingested = await Promise.race([
        b.ingest().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      expect(ingested, "b's ingest finished").toBe(true);
      const v = await b.get(utf("k1"));
      expect(v && new TextDecoder().decode(v), "a's acked write survives it").toBe("v1");
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("recovery past a dead tab's reclaimed log", () => {
  // Recovery lets an older manifest stand in for a newest one that lists a
  // missing run (a power loss) only while the logs hold every record above
  // the older cut. It saw only the logs left: a dead tab whose whole log
  // reclaim had removed left no trace, so its records were silently gone.
  // Now reclaim leaves an empty segment named past them until every
  // manifest covers them, and recovery refuses.
  it("refuses rather than drop that tab's writes", async () => {
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const x = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(host) });
    await x.put(utf("a"), utf("1"));
    await x.ingest();
    const w = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(host) });
    await w.put(utf("k1"), utf("v1"));
    await w.close();
    await x.put(utf("b"), utf("2"));
    await x.ingest();
    await x.close();
    // A power loss kept the newest manifest but not its run.
    const { meta } = await recoverGeneration(fs, () => false);
    for (const run of meta.runs) if (run.path.startsWith("l0/")) await fs.remove(run.path);
    const opened = await openHarnessDb({ name: NAME, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) }).then(
      async (db) => {
        const v = await db.get(utf("k1"));
        await db.close();
        return v ? "has k1" : "lost k1";
      },
      (err: unknown) => (err as Error).name,
    );
    expect(opened).not.toBe("lost k1");
  });
});

async function untilAsync(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never held");
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((resolve) => setImmediate(resolve));
  if (!cond()) throw new Error("condition never held");
}
