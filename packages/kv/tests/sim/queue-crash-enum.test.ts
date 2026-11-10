import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import type { GenerationMeta } from "../../src/store/generation.js";
import { manifestNumbers, readManifest } from "../../src/store/generation.js";
import { recoverQueues } from "../../src/recover.js";
import { FaultFs, Faults, type SiteKind } from "./fault-fs.js";
import { BROWSERS, type Browser } from "./queue-fs.js";
import { hostCmdArb, mulberry32, QueueWorld, segmentBytesArb, tabCmdArb, type EndState, type HostCmd, type TabCmd } from "./queue-world.js";

/**
 * Crash enumeration for the SharedWorker's queue passes. A workload sets
 * up tabs, logs and manifests; then the pass under test, an ingest or a
 * reclaim, stops after each of its file-system calls in turn (and before
 * the first). The host restarts: the browser drops its unclosed writables
 * and its locks, and up to RECLAIM_LAG of the newest manifests are lost
 * too. Recovery must open, and the pass runs again. With no manifest lost,
 * the newest manifest (ingest) or the files (reclaim) match a pass that
 * never stopped; an ingest stopped after it published already matches
 * before it runs again. Every tab then ends, the host drains, and the runs must
 * hold every acked record (`QueueWorld.checkRuns`) and match that pass's
 * drain record for record and cursor for cursor.
 *
 *   KV_QUEUE_CRASH_RUNS=100 pnpm exec vitest run tests/sim/queue-crash-enum.test.ts
 */
const env = process.env;
const RUNS = Number(env.KV_QUEUE_CRASH_RUNS ?? 100);
const replay = env.KV_MODEL_SEED
  ? { seed: Number(env.KV_MODEL_SEED), ...(env.KV_MODEL_PATH ? { path: env.KV_MODEL_PATH } : {}) }
  : {};
/** Newest manifests a crash may lose: the RECLAIM_LAG that reclaim leaves room for. */
const DROPS = [0, 1, 2] as const;

type Step = { readonly tab: number; readonly cmd: TabCmd } | { readonly host: HostCmd };
type Workload = { readonly seed: number; readonly tabs: number; readonly segmentBytes: number; readonly steps: readonly Step[]; readonly op: HostCmd };

/** A host that stops for good once `calls` file-system calls have run. */
class StopAfter extends Faults {
  constructor(private readonly calls: number) {
    super();
  }

  override hit(kind: SiteKind, label: string): "ok" | "fail" | "crash" {
    if (!this.isCrashed && this.sites.length >= this.calls) this.crash();
    return super.hit(kind, label);
  }
}

const counts = { workloads: 0, crashPoints: 0, states: 0 };
afterAll(() => console.info(`queue crash enumeration: ${counts.workloads} workloads, ${counts.crashPoints} crash points, ${counts.states} restarts`));

async function setUp(browser: Browser, w: Workload): Promise<QueueWorld> {
  const world = new QueueWorld(browser, mulberry32(w.seed), w.tabs, w.segmentBytes);
  await world.start();
  for (const step of w.steps) {
    if ("host" in step) await world.serve(step.host);
    else await world.run(step.tab % w.tabs, step.cmd);
  }
  return world;
}

/** So every try of the pass sees each open file as the reference did. */
const reseed = (world: QueueWorld, w: Workload): void => void (world.fs.random = mulberry32(w.seed ^ 0x5bd1e995));

/** Runs `op` until it ends or `faults` stops it; the number of file-system calls it made. */
async function pass(world: QueueWorld, op: HostCmd, faults: Faults): Promise<number> {
  const done = world.serve(op, { fs: new FaultFs(world.fs, faults), locks: world.locks.for("host") });
  await Promise.race([done, faults.crashed]);
  return faults.sites.length;
}

const newest = async (world: QueueWorld): Promise<GenerationMeta> => (await recoverQueues(world.fs)).base;
/** A manifest but its number, which a stopped pass's empty manifest file can push up by one. */
const sameManifest = (m: GenerationMeta) => ({ through: m.through, tombstoneSeq: m.tombstoneSeq, runs: m.runs, queues: m.queues ?? [] });
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

async function dropNewest(world: QueueWorld, count: number): Promise<void> {
  let left = count;
  for (const g of await manifestNumbers(world.fs)) {
    if (left === 0) return;
    if (!(await readManifest(world.fs, g))) continue;
    await world.fs.remove(`m/${String(g).padStart(16, "0")}.mft`);
    left--;
  }
}

async function enumerate(browser: Browser, w: Workload): Promise<{ calls: number; changed: boolean }> {
  counts.workloads++;
  const ref = await setUp(browser, w);
  const before = { paths: ref.fs.paths().sort(), generation: (await newest(ref)).generation };
  reseed(ref, w);
  const calls = await pass(ref, w.op, new StopAfter(Number.POSITIVE_INFINITY));
  const after = { paths: ref.fs.paths().sort(), manifest: sameManifest(await newest(ref)) };
  const changed = w.op.t === "reclaim" ? after.paths.join() !== before.paths.join() : (await newest(ref)).generation !== before.generation;
  await ref.drain();
  const end: EndState = await ref.checkRuns();

  for (let k = 0; k <= calls; k++) {
    counts.crashPoints++;
    for (const drops of DROPS) {
      counts.states++;
      const where = `${w.op.t} stopped after ${k} of ${calls} calls, ${drops} manifest(s) lost`;
      const world = await setUp(browser, w);
      reseed(world, w);
      await pass(world, w.op, new StopAfter(k));
      await world.fs.dropStages();
      world.locks.releaseAll("host");
      await dropNewest(world, drops);
      await expect(recoverQueues(world.fs), `recovery after ${where}`).resolves.toBeDefined();
      const restarted = sameManifest(await newest(world));
      const published = drops === 0 && w.op.t === "ingest" && equal(restarted, after.manifest);
      reseed(world, w);
      await world.serve(w.op);
      if (drops === 0 && w.op.t === "reclaim") expect(world.fs.paths().sort(), `files after ${where}`).toEqual(after.paths);
      if (drops === 0 && w.op.t === "ingest" && !published) expect(sameManifest(await newest(world)), `newest manifest after ${where}`).toEqual(after.manifest);
      await world.drain();
      if (drops === 0) await world.checkFiles();
      expect(await world.checkRuns(), `drain after ${where}`).toEqual(end);
    }
  }
  return { calls, changed };
}

const tab = (t: number, cmd: TabCmd): Step => ({ tab: t, cmd });
const append = (t: number, count = 1): Step => tab(t, { t: "append", count, size: 8 });
const ingest = (maxBytes = Number.POSITIVE_INFINITY): Step => ({ host: { t: "ingest", maxBytes } });

/** Tab 0's log dies and is final in three manifests while tab 1 keeps writing: reclaim removes its directory and old manifests. */
const RECLAIM_DEAD: Workload = {
  seed: 1,
  tabs: 2,
  segmentBytes: 160,
  steps: [
    append(0, 3), tab(0, { t: "rotate" }), append(0), tab(0, { t: "die", clean: true }),
    ...[1, 2, 3, 4].flatMap(() => [append(1), tab(1, { t: "rotate" }), tab(1, { t: "flush" }), ingest()]),
  ],
  op: { t: "reclaim" },
};

/**
 * A failed write whose frame landed whole, a successor that caps it, a log
 * that died mid-segment, and a live one: ingested a few records at a time.
 * Each live log's first segment is sealed, so chrome holds no dead log back.
 */
const INGEST_MIXED: Workload = {
  seed: 2,
  tabs: 3,
  segmentBytes: 160,
  steps: [
    append(0, 2), tab(0, { t: "flush" }),
    tab(0, { t: "fail", via: "append", fault: { at: "write", mode: "throw", landed: 1 << 20 } }),
    append(0, 2), tab(0, { t: "reap" }), tab(0, { t: "rotate" }),
    append(1, 3), tab(1, { t: "rotate" }), append(1, 1), tab(1, { t: "die", clean: false }),
    append(2, 2), tab(2, { t: "rotate" }), append(2), tab(2, { t: "flush" }), ingest(64),
  ],
  op: { t: "ingest", maxBytes: 64 },
};

const workloadArb: fc.Arbitrary<Workload> = fc.record({
  seed: fc.integer(),
  tabs: fc.integer({ min: 1, max: 3 }),
  segmentBytes: segmentBytesArb,
  steps: fc.array(
    fc.oneof(
      { weight: 3, arbitrary: fc.record({ tab: fc.nat({ max: 2 }), cmd: tabCmdArb }) },
      { weight: 1, arbitrary: hostCmdArb.map((host) => ({ host })) },
    ),
    { maxLength: 30 },
  ),
  op: hostCmdArb,
});

describe("ingest queue crash enumeration", () => {
  it.each(BROWSERS)("%s: a reclaim stopped anywhere, with up to two manifests lost, ends where it would have", async (browser) => {
    const { calls, changed } = await enumerate(browser, RECLAIM_DEAD);
    expect(changed, "the reference reclaim removes files").toBe(true);
    expect(calls).toBeGreaterThan(10);
  });

  it.each(BROWSERS)("%s: an ingest stopped anywhere, with up to two manifests lost, ends where it would have", async (browser) => {
    const { calls, changed } = await enumerate(browser, INGEST_MIXED);
    expect(changed, "the reference ingest publishes").toBe(true);
    expect(calls).toBeGreaterThan(10);
  });

  it.each(BROWSERS)("%s: random workloads", async (browser) => {
    await expect(
      fc.assert(
        fc.asyncProperty(workloadArb, async (w) => void (await enumerate(browser, w))),
        { numRuns: RUNS, ...replay },
      ),
    ).resolves.toBeUndefined();
  }, 600_000);
});
