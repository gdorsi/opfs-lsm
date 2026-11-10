import fc from "fast-check";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { MemoryFs, type AsyncFs } from "../../src/index.js";
import { holdingFiles } from "../../src/locks.js";
import { Host, openHarnessDb } from "../../src/testing.js";
import { checkDatabase } from "./check-database.js";
import { commandsArb, Model, Sut } from "./commands.js";
import { describeOp, FaultFs, Faults, traceSegments, type DurableOp } from "./fault-fs.js";
import { checkCrashState, runSteps, Traced, type Ack, type Cut, type Step } from "./crash.js";
import { Oracle } from "./oracle.js";

/**
 * Crash-state enumeration (docs/research/corruption-hardening-test-suite.md,
 * technique 3). A workload runs once with every durable op traced: run
 * files, manifests, removes, and log segment writes. Then every crash state
 * is rebuilt from a prefix of the trace, reopened, and checked against the
 * log (`crash.ts`):
 * - process crash: every cut `k` of the trace. The database opens and
 *   holds a log prefix with every write acked before `k`;
 * - lost manifests: every cut `k` again, with the newest one or two
 *   manifests lost as well, as a power loss can lose the newest publishes.
 *   The logs keep what those manifests ingested, so still no acked write
 *   may be missing, though writes of two logs may land in another order
 *   (crash.ts).
 *
 * Fixed workloads cover ingest, compaction install and reclaim; random
 * histories reuse the single-handle commands of model.test.ts. The
 * SharedWorker's own ingest and reclaim passes, with tabs dying around
 * them, are enumerated in queue-crash-enum.test.ts.
 *
 *   KV_CRASH_RUNS=200 pnpm exec vitest run tests/sim/crash-enum.test.ts
 *   KV_MODEL_SEED=<seed> KV_MODEL_PATH=<path> KV_MODEL_REPLAY=<replayPath> pnpm exec vitest run tests/sim/crash-enum.test.ts
 */
const env = process.env;
const RUNS = Number(env.KV_CRASH_RUNS ?? 15);
/** Lost-manifest cuts drawn per random history. */
const PAIRS = Number(env.KV_CRASH_PAIRS ?? 40);
const replay = env.KV_MODEL_SEED
  ? { seed: Number(env.KV_MODEL_SEED), ...(env.KV_MODEL_PATH ? { path: env.KV_MODEL_PATH } : {}) }
  : {};

const put = (key: string, value: string): Step => ({ put: key, value });
const del = (key: string): Step => ({ del: key });
const ingest: Step = { ingest: true };
const reopen: Step = { reopen: true };

/** Two flushes, a reopen, and a third flush over a batch. */
const INGEST: Step[] = [
  put("a", "a1"), put("b", "b1"), del("a"), ingest,
  { batch: [{ put: "c", value: "c1" }, { del: "b" }] }, put("a", "a2"), ingest,
  reopen, put("d", "d1"), ingest,
];

/** Four flushes: the fourth L0 run starts an L0 -> L1 compaction, its install and reclaim. Then one more flush. */
const COMPACTION: Step[] = [
  put("a", "a1"), put("b", "b1"), ingest,
  del("a"), put("c", "c1"), ingest,
  put("a", "a2"), { batch: [{ put: "d", value: "d1" }, { del: "b" }] }, ingest,
  put("e", "e1"), ingest,
  put("c", "c2"), del("e"), ingest,
];

const many = (prefix: string, n: number, tag: string) =>
  ({ batch: Array.from({ length: n }, (_, i) => ({ put: `${prefix}/${String(i).padStart(4, "0")}`, value: `${tag}${i}` })) });

/**
 * Eight flushes: two compactions. The second merges four L0 runs into the
 * overlapping L1 run (reclaiming an L1 run) at the bottom, so it drops
 * tombstones and raises `tombstoneSeq`. Multi-block runs from a big batch.
 */
const CASCADE: Step[] = [
  many("n", 300, "x"), ingest,
  put("a", "a1"), ingest,
  del("n/0001"), put("b", "b1"), ingest,
  put("a", "a2"), ingest,
  del("a"), ingest,
  many("n", 40, "y"), ingest,
  del("b"), put("c", "c1"), ingest,
  put("a", "a3"), ingest,
];

/**
 * A page reads its write ingested, closes, and the next page deletes it.
 * Lose the manifest that ingested the put and the recovery round re-ingests
 * both logs in one round with no order between them, so the delete can
 * land first (the reorder crash.ts accepts after lost manifests).
 */
const REOPEN: Step[] = [put("a", "a1"), reopen, del("a"), ingest, put("b", "b1"), reopen, put("a", "a2"), ingest];

const WORKLOADS: [string, Step[]][] = [
  ["ingest", INGEST],
  ["reopen", REOPEN],
  ["compaction", COMPACTION],
  ["cascade", CASCADE],
];

let runs = 0;

type Traced_ = { ops: DurableOp[]; log: Oracle; acks: Ack[] };

/** Run `steps` with every durable op traced. */
async function trace(steps: readonly Step[]): Promise<Traced_> {
  const t = new Traced(`trace-${++runs}`);
  const log = new Oracle();
  await runSteps(t, steps, log);
  await t.expectTraceComplete();
  return { ops: [...t.faults.ops], log, acks: [...t.acks] };
}

/** Check every cut, collect the failures, and fail with the first few. */
async function checkAll(run: Traced_, cuts: readonly Cut[], kind: "process" | "lost manifests"): Promise<number> {
  const failures: string[] = [];
  for (const cut of cuts) {
    await checkCrashState(run.ops, run.log, run.acks, cut).catch((err: Error) => failures.push(err.message));
  }
  counts[kind] += cuts.length;
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${cuts.length} ${kind} crash states fail. First:\n${failures.slice(0, 2).join("\n\n")}`);
  }
  return cuts.length;
}

/** States checked, printed with KV_CRASH_REPORT=1. */
const counts = { process: 0, "lost manifests": 0 };
afterAll(() => {
  if (env.KV_CRASH_REPORT) console.log(`crash states checked: ${JSON.stringify(counts)}`);
});

const allCuts = (ops: readonly DurableOp[], drop = 0): Cut[] => Array.from({ length: ops.length + 1 }, (_, k) => ({ k, drop }));

/** Each 16-hex log id as L1, L2, … in order of first use: ids are random per run. */
function normalize(lines: readonly string[]): string[] {
  const ids = new Map<string, string>();
  return lines.map((l) => l.replace(/[0-9a-f]{16}/g, (id) => ids.get(id) ?? (ids.set(id, `L${ids.size + 1}`), ids.get(id)!)));
}

describe("process crash: every crash point", () => {
  it.each(WORKLOADS)("%s: reopens to a log prefix with every acked write", async (_name, steps) => {
    const run = await trace(steps);
    await expect(checkAll(run, allCuts(run.ops), "process")).resolves.toBe(run.ops.length + 1);
  }, 120_000);

  // A live crash freezes the files at op k. What is left must be exactly the
  // first k traced ops of the uncrashed run, so the rebuilt states above are
  // the states a crash leaves.
  it("a live crash at op k leaves exactly the first k traced ops", async () => {
    const { ops } = await trace(COMPACTION);
    // The host logs the background work a crash aborts.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => quiet.mockRestore());
    const want = normalize(ops.map(describeOp));
    for (let k = 0; k <= ops.length; k++) {
      const t = new Traced(`live-${++runs}`);
      t.faults.crashAfter = k;
      if (k === 0) t.faults.crash();
      const run = runSteps(t, COMPACTION, new Oracle()).catch(() => undefined);
      await Promise.race([run, t.faults.crashed]);
      // Let whatever was in flight run into the frozen files.
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(normalize(t.faults.ops.map(describeOp)), `ops left by a crash at ${k}`).toEqual(want.slice(0, k));
      await t.expectTraceComplete();
    }
  }, 120_000);

  it("random histories: every crash point reopens to a log prefix with every acked write", async () => {
    await expect(
      fc.assert(fc.asyncProperty(commandsArb(env.KV_MODEL_REPLAY, 30), fc.integer(), (cmds, seed) => randomHistory(cmds, seed)), {
        numRuns: RUNS,
        ...replay,
      }),
    ).resolves.toBeUndefined();
  }, 600_000);
});

/** One random history, then every process crash point and a sample of lost-manifest cuts. */
async function randomHistory(cmds: Iterable<fc.AsyncCommand<Model, Sut, false>>, seed: number): Promise<void> {
  const faults = new Faults();
  const mem = new MemoryFs();
  const sut = new Sut(`random-${++runs}`, { batchBytes: 1 << 30 }, new FaultFs(mem, faults), traceSegments(mem.segments, faults));
  const acks: Ack[] = [];
  sut.onAck = () => acks.push({ at: faults.ops.length, log: sut.opens });
  const model = new Model();
  await sut.open();
  try {
    await fc.asyncModelRun(() => ({ model, real: sut }), cmds);
  } finally {
    await sut.dispose();
  }
  const run = { ops: [...faults.ops], log: model.oracle, acks };
  await checkAll(run, allCuts(run.ops), "process");
  const random = mulberry32(seed);
  const lost = Array.from({ length: PAIRS }, () => ({ k: Math.floor(random() * (run.ops.length + 1)), drop: 1 + Math.floor(random() * 2) }));
  await checkAll(run, lost, "lost manifests");
}

describe("lost manifests: every crash point, with the newest manifests gone too", () => {
  it.each(WORKLOADS)("%s: reopens with every acked write, each log in order", async (_name, steps) => {
    const run = await trace(steps);
    const cuts = [...allCuts(run.ops, 1), ...allCuts(run.ops, 2)];
    await expect(checkAll(run, cuts, "lost manifests")).resolves.toBe(cuts.length);
  }, 120_000);
});

describe("generation loads under churn", () => {
  // A tab loads a generation and opens its runs. The host reclaims any run
  // no tab holds open, and a tab holds a run only once its open returns.
  // Here tab B's run opens are slow, and before each one returns tab A
  // ingests four times and compacts. B used to give up with
  // CorruptDatabaseError(GENERATION_GONE) although every file of the
  // generation was there. A load holds the reclaim lock shared, so the host
  // skips reclaim until it returns (design.md, "Loading a generation under
  // churn").
  it("a healthy database never reports GENERATION_GONE under compaction churn", async () => {
    const enc = new TextEncoder();
    const fs = new MemoryFs();
    const host = new Host(() => fs, { maxLatencyMs: 1e9 });
    const g = globalThis as { BroadcastChannel?: unknown };
    const channel = g.BroadcastChannel;
    // No broadcasts: only these calls move either handle.
    g.BroadcastChannel = undefined;
    let parked: (() => void)[] | undefined;
    const slow: AsyncFs = {
      read: (path, offset, length) => fs.read(path, offset, length),
      open: async (path) => {
        const queue = parked;
        if (queue) await new Promise<void>((resolve) => queue.push(resolve));
        return fs.open(path);
      },
      list: (dir) => fs.list(dir),
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
    };
    const name = `churn-${++runs}`;
    const a = await openHarnessDb({ name, fs, host });
    const b = await openHarnessDb({ name, fs: slow, segments: fs.segments, host });
    let n = 0;
    const flush = async () => {
      await a.put(enc.encode(`k${n % 3}`), enc.encode(`v${n++}`));
      await a.ingest();
    };
    try {
      await flush();
      await b.sync();
      await flush();
      parked = [];
      let outcome: "pending" | "ok" | Error = "pending";
      const syncing = b.sync().then(
        () => (outcome = "ok"),
        (err: Error) => (outcome = err),
      );
      for (let round = 0; round < 12 && outcome === "pending"; round++) {
        await until(() => (parked?.length ?? 0) > 0 || outcome !== "pending");
        if (outcome !== "pending") break;
        for (let i = 0; i < 4; i++) await flush();
        const resume = parked!;
        parked = [];
        for (const r of resume) r();
      }
      parked = undefined;
      await syncing;
      const report = await checkDatabase(fs);
      expect(report.problems, "the database is healthy").toEqual([]);
      expect(outcome).toBe("ok");
    } finally {
      parked = undefined;
      g.BroadcastChannel = channel;
      await a.close();
      await b.close();
    }
  });

  // Before every file call of tab B's sync (each manifest read and run
  // open), tab A writes, ingests and compacts: a new generation is
  // published, and the old one's runs and manifest are reclaimed unless a
  // lock stops it. Every sync must still succeed and read A's writes.
  it("sync succeeds when compaction installs and reclaims between every step of its load", async () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const fs = new MemoryFs();
    const host = new Host(() => fs, { maxLatencyMs: 1e9 });
    const g = globalThis as { BroadcastChannel?: unknown };
    const channel = g.BroadcastChannel;
    g.BroadcastChannel = undefined;
    const name = `churn-every-step-${++runs}`;
    const a = await openHarnessDb({ name, fs, host });
    let n = 0;
    let churning = false;
    let churns = 0;
    const churn = async () => {
      if (!churning) return;
      churning = false;
      for (let i = 0; i < 4; i++) {
        await a.put(enc.encode(`k${n % 5}`), enc.encode(`v${n++}`));
        await a.ingest();
      }
      churns++;
      churning = true;
    };
    const churned: AsyncFs = {
      read: async (path, offset, length) => {
        await churn();
        return fs.read(path, offset, length);
      },
      open: async (path) => {
        await churn();
        return fs.open(path);
      },
      list: async (dir) => {
        await churn();
        return fs.list(dir);
      },
      remove: (path) => fs.remove(path),
      removeUnlessOpen: (path) => fs.removeUnlessOpen(path),
      create: (path) => fs.create(path),
    };
    const b = await openHarnessDb({ name, fs: churned, segments: fs.segments, host });
    try {
      for (let round = 0; round < 40; round++) {
        await a.put(enc.encode("round"), enc.encode(`r${round}`));
        await a.ingest();
        churning = true;
        await b.sync();
        churning = false;
        expect(dec.decode((await b.get(enc.encode("round")))!)).toBe(`r${round}`);
      }
      expect(churns, "A churned during B's loads").toBeGreaterThan(40);
      const report = await checkDatabase(fs);
      expect(report.problems).toEqual([]);
    } finally {
      churning = false;
      g.BroadcastChannel = channel;
      await a.close();
      await b.close();
    }
  }, 60_000);

  // The other direction: a tab that holds the reclaim lock and never lets
  // go (hung, or killed before the browser frees its locks) stalls no
  // ingest or compaction. Reclaim skips while it is held and catches up after.
  it("a tab that keeps the reclaim lock stalls no ingest or compaction", async () => {
    const enc = new TextEncoder();
    const fs = new MemoryFs();
    const host = new Host(() => fs, { maxLatencyMs: 1e9 });
    const name = `held-forever-${++runs}`;
    const a = await openHarnessDb({ name, fs, host });
    let n = 0;
    const flush = async () => {
      await a.put(enc.encode(`k${n % 3}`), enc.encode(`v${n++}`));
      await a.ingest();
    };
    let release!: () => void;
    let granted = false;
    try {
      await flush();
      const held = holdingFiles(name, () => {
        granted = true;
        return new Promise<void>((resolve) => (release = resolve));
      });
      await until(() => granted);
      for (let i = 0; i < 12; i++) await flush();
      const during = await checkDatabase(fs);
      expect(during.problems).toEqual([]);
      // The manifests stay, so every run they list stays too.
      expect(during.staleManifests.length, "nothing reclaimed while held").toBeGreaterThan(0);
      release();
      await held;
      await flush();
      await a.close();
      // A's last ingest retired runs it still held; the next page's pass removes them.
      const next = await openHarnessDb({ name, fs, host });
      await next.ingest();
      await next.close();
      const after = await checkDatabase(fs);
      expect(after.problems).toEqual([]);
      expect(after.staleManifests).toEqual([]);
      expect(after.orphans).toEqual([]);
    } finally {
      release?.();
      await a.close();
    }
  });
});

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((resolve) => setImmediate(resolve));
  if (!cond()) throw new Error("condition never held");
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
