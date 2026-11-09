import fc from "fast-check";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { EngineHost, MemoryFs, createLocalIngestClient, type AsyncFs } from "../../src/index.js";
import { holdingFiles } from "../../src/host/protocol.js";
import { openHarnessDb } from "../../src/testing.js";
import { checkDatabase } from "./check-database.js";
import { commandsArb, Model, Sut } from "./commands.js";
import { describeOp, FaultFs, Faults, type DurableOp } from "./fault-fs.js";
import {
  checkCrashState,
  describeCut,
  powerCuts,
  processCut,
  runSteps,
  Traced,
  type Cut,
  type Step,
} from "./crash.js";
import { Oracle } from "./oracle.js";

/**
 * Crash-state enumeration (docs/research/corruption-hardening-test-suite.md,
 * technique 3). A workload runs once with every durable op traced; then
 * every crash state is rebuilt from a prefix of the trace, reopened, and
 * checked against the log (`crash.ts`):
 * - process crash: every crash point `k`. The database opens and holds
 *   exactly the committed log, so every acked write survives;
 * - power loss: at each crash point, logs keep their flushed writes and
 *   any prefix of the rest, OPFS file ops any prefix of theirs. The
 *   database opens and holds some log prefix (design.md, "Recovery").
 *
 * Fixed workloads cover ingest, compaction install and reclaim; random
 * histories reuse the single-handle commands of model.test.ts.
 *
 *   KV_CRASH_RUNS=200 pnpm exec vitest run tests/sim/crash-enum.test.ts
 *   KV_MODEL_SEED=<seed> KV_MODEL_PATH=<path> KV_MODEL_REPLAY=<replayPath> pnpm exec vitest run tests/sim/crash-enum.test.ts
 */
const env = process.env;
const RUNS = Number(env.KV_CRASH_RUNS ?? 15);
/** Power-loss states drawn per random history. */
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
 * Small segments: a segment seals every write or two, so the logs are
 * chains of segments, ingests are also asked for by the tab on its own,
 * and reclaim removes whole segments.
 */
const SEGMENTS: Step[] = [
  put("a", "a1"), put("b", "b1"), put("c", "c1"), ingest,
  del("a"), put("d", "d1"), reopen, put("e", "e1"),
  { batch: [{ put: "a", value: "a2" }, { del: "c" }] }, ingest, put("f", "f1"),
];

const WORKLOADS: [string, Step[], number][] = [
  ["ingest", INGEST, 1 << 30],
  ["compaction", COMPACTION, 1 << 30],
  ["cascade", CASCADE, 1 << 30],
  ["segments", SEGMENTS, 64],
];

let runs = 0;

/** Run `steps` with every durable op traced. */
async function trace(steps: readonly Step[], maxWalBytes = 1 << 30): Promise<{ ops: DurableOp[]; log: Oracle }> {
  const t = new Traced(`trace-${++runs}`, maxWalBytes);
  const log = new Oracle();
  try {
    await runSteps(t, steps, log);
    await t.expectTraceComplete();
    return { ops: [...t.faults.ops], log };
  } finally {
    await t.dispose();
  }
}

/** Check every cut, collect the failures, and fail with the first few. */
async function checkAll(ops: readonly DurableOp[], log: Oracle, cuts: readonly Cut[], model: "process" | "power"): Promise<number> {
  const failures: string[] = [];
  for (const cut of cuts) {
    await checkCrashState(ops, log, cut, model).catch((err: Error) => failures.push(err.message));
  }
  counts[model] += cuts.length;
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${cuts.length} ${model} crash states fail. First:\n${failures.slice(0, 2).join("\n\n")}`);
  }
  return cuts.length;
}

/** States checked, printed with KV_CRASH_REPORT=1. */
const counts = { process: 0, power: 0 };
afterAll(() => {
  if (env.KV_CRASH_REPORT) console.log(`crash states checked: ${JSON.stringify(counts)}`);
});

const allProcessCuts = (ops: readonly DurableOp[]) => Array.from({ length: ops.length + 1 }, (_, k) => processCut(ops, k));

describe("process crash: every crash point", () => {
  it.each(WORKLOADS)("%s: reopens to the whole committed log", async (_name, steps, maxWalBytes) => {
    const { ops, log } = await trace(steps, maxWalBytes);
    await expect(checkAll(ops, log, allProcessCuts(ops), "process")).resolves.toBe(ops.length + 1);
  });

  // A live crash freezes the stores at op k. What is left must be exactly the
  // first k ops of the uncrashed run's trace, so the rebuilt states above are
  // the states a crash leaves.
  it("a live crash at op k leaves exactly the first k traced ops", async () => {
    const { ops } = await trace(COMPACTION);
    // The host logs the background WAL read a crash aborts.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => quiet.mockRestore());
    for (let k = 0; k <= ops.length; k++) {
      const t = new Traced(`live-${++runs}`);
      t.faults.crashAfter = k;
      if (k === 0) t.faults.crash();
      try {
        const run = runSteps(t, COMPACTION, new Oracle()).catch(() => undefined);
        await Promise.race([run, t.faults.crashed]);
        // Let whatever was in flight run into the frozen stores.
        for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
        expect(t.faults.ops.map(describeOp), `ops left by a crash at ${k}`).toEqual(ops.slice(0, k).map(describeOp));
        await t.expectTraceComplete();
      } finally {
        await t.dispose();
      }
    }
  });

  it("random histories: every crash point reopens to the whole committed log", async () => {
    await expect(
      fc.assert(fc.asyncProperty(commandsArb(env.KV_MODEL_REPLAY, 30), fc.integer(), (cmds, seed) => randomHistory(cmds, seed)), {
        numRuns: RUNS,
        ...replay,
      }),
    ).resolves.toBeUndefined();
  }, 600_000);
});

/** One random history, then every process crash point and a sample of power-loss pairs. */
async function randomHistory(cmds: Iterable<fc.AsyncCommand<Model, Sut, false>>, seed: number): Promise<void> {
  const faults = new Faults();
  const name = `random-${++runs}`;
  const sut = new Sut(name, 1 << 30, new FaultFs(new MemoryFs(), faults));
  const model = new Model();
  await sut.open();
  try {
    await fc.asyncModelRun(() => ({ model, real: sut }), cmds);
    await sut.db.close();
    await sut.settle();
    expect((await checkDatabase(sut.fs, name)).problems).toEqual([]);
  } finally {
    await sut.dispose();
  }
  const ops = [...faults.ops];
  const log = model.oracle;
  await checkAll(ops, log, allProcessCuts(ops), "process");
  await checkAll(ops, log, powerCuts(ops, PAIRS, mulberry32(seed)), "power");
}

describe("power loss: logs keep what they flushed, OPFS any prefix", () => {
  it.each(WORKLOADS)("%s: reopens to a log prefix", async (_name, steps, maxWalBytes) => {
    const { ops, log } = await trace(steps, maxWalBytes);
    const cuts = powerCuts(ops, 5_000, mulberry32(1));
    await expect(checkAll(ops, log, cuts, "power")).resolves.toBe(cuts.length);
  }, 120_000);
});

/** Run `steps` traced, and cut the trace where `pick` says. `at(text)` is the first op whose label holds `text`. */
async function cutOf(steps: readonly Step[], pick: (at: (text: string) => number, ops: readonly DurableOp[]) => Cut) {
  const { ops, log } = await trace(steps);
  const at = (text: string) => {
    const op = ops.find((o) => o.label.includes(text));
    if (!op) throw new Error(`no op ${text} in\n${ops.map(describeOp).join("\n")}`);
    return op.i;
  };
  const cut = pick(at, ops);
  return { ops, log, cut, describe: describeCut(ops, cut) };
}

/** OPFS file ops among the first `k` ops. */
const opfsBefore = (ops: readonly DurableOp[], k: number) => ops.slice(0, k).filter((o) => o.store === "opfs").length;

const dec = (b: Uint8Array | undefined) => b && new TextDecoder().decode(b);

describe("risks to target first (research note)", () => {
  // An ingest publishes l0/1-1.sst and manifest 1 with no fsync; a power
  // loss can drop both while the log, flushed before the ingest, keeps
  // the record. The open reads it from the log.
  it("an ingest whose files are lost leaves its records in the log", async () => {
    const { ops, log, cut } = await cutOf([put("a", "a1"), ingest], (_at, ops) => ({ k: ops.length, opfs: 0 }));
    await expect(checkCrashState(ops, log, cut, "power")).resolves.toBeUndefined();
    const t = new Traced(`risk1-${++runs}`);
    await t.load(ops, cut);
    const db = await t.open();
    expect(dec(await db.get(new TextEncoder().encode("a"))), "the record survives").toBe("a1");
    await db.close();
  });

  // A tab's writes are in its log at once and flushed a little later. A
  // power loss before the flush drops them, and only them: what the log
  // flushed before stands.
  it("a power loss drops only the writes after the last flush", async () => {
    const { ops, log, cut } = await cutOf([put("a", "a1"), ingest, put("b", "b1"), put("c", "c1")], (at, ops) => {
      const k = ops.length;
      const logs: Record<string, number> = {};
      // Keep the writes the ingest flushed, lose the two after it.
      const flushed = ops.filter((o) => o.store === "log" && o.kind === "write" && o.i < at("publish m/"));
      for (const o of flushed) logs[o.path] = (logs[o.path] ?? 0) + 1;
      return { k, opfs: opfsBefore(ops, k), logs };
    });
    await expect(checkCrashState(ops, log, cut, "power")).resolves.toBeUndefined();
    const t = new Traced(`tail-${++runs}`);
    await t.load(ops, cut);
    const db = await t.open();
    const enc = new TextEncoder();
    expect([dec(await db.get(enc.encode("a"))), dec(await db.get(enc.encode("b"))), dec(await db.get(enc.encode("c")))]).toEqual(["a1", undefined, undefined]);
    await db.close();
  });

  // A process crash after manifest 1 and before reclaim. The next ingest
  // builds on manifest 1, two more flushes compact, and reclaim removes the
  // leftovers. Checked as one of the process crash points above too;
  // spelled out here.
  it("a crash between a manifest and its reclaim compacts and reclaims cleanly", async () => {
    const { ops, log, cut } = await cutOf([put("a", "a1"), put("b", "b1"), ingest], (at, ops) =>
      processCut(ops, at("publish m/0000000000000001.mft")),
    );
    await checkCrashState(ops, log, cut, "process");
    const t = new Traced(`risk3-${++runs}`);
    await t.load(ops, cut);
    let db = await t.open();
    await db.ingest();
    expect((await checkDatabase(t.fs, t.name)).runs, "the ingest lists l0/1-2.sst once").toEqual(["l0/1-2.sst"]);
    // Three more flushes make four L0 runs: compaction.
    for (const [i, key] of ["c", "d", "e"].entries()) {
      await db.put(new TextEncoder().encode(key), new TextEncoder().encode(`${key}${i}`));
      log.append([{ type: "put", key: new TextEncoder().encode(key), value: new TextEncoder().encode(`${key}${i}`) }]);
      await db.ingest();
    }
    await db.close();
    await t.host.ingest(t.name, 0, true);
    const report = await checkDatabase(t.fs, t.name);
    expect(report.problems).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.runs.every((p) => p.startsWith("l1/")), `compacted into L1: ${report.runs.join(", ")}`).toBe(true);
    const decode = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(report.state.map((e) => `${decode(e.key)}=${decode(e.value)}`)).toEqual(["a=a1", "b=b1", "c=c0", "d=d1", "e=e2"]);
    db = await t.open();
    expect(decode((await db.get(new TextEncoder().encode("b")))!)).toBe("b1");
    await db.close();
  });
});

describe("risks to target first: false corruption", () => {
  // Risk 4. `syncOnce` reads the tail, loads the manifest it names and opens
  // that generation's runs. The host's reclaim removes any run no tab holds
  // open, and a tab holds a run only once its open returns. Here tab B's run
  // opens are slow, and before each one returns the host flushes four times
  // and compacts. B used to give up after 8 tries with
  // CorruptDatabaseError(GENERATION_GONE) although every file of the
  // recorded generation was there. Now a retry holds the reclaim lock
  // shared, so the host skips reclaim until it returns (design.md, "Loading
  // a generation under churn").
  it("risk 4: a healthy database never reports GENERATION_GONE under compaction churn", async () => {
    const enc = new TextEncoder();
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
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
    const ingest = createLocalIngestClient(host);
    const a = await openHarnessDb({ name, fs, ingest });
    const b = await openHarnessDb({ name, fs: slow, ingest });
    let n = 0;
    const flush = async () => {
      await a.put(enc.encode(`k${n % 3}`), enc.encode(`v${n++}`));
      await host.ingest(name, Number.POSITIVE_INFINITY, true);
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
      const report = await checkDatabase(fs, name);
      expect(report.problems, "the database is healthy").toEqual([]);
      expect(outcome).toBe("ok");
    } finally {
      parked = undefined;
      await a.close();
      await b.close();
    }
  });
});

describe("generation loads under churn", () => {
  // Before every file call of tab B's sync (each manifest read and run
  // open), tab A writes and the host flushes and compacts: a new generation
  // is recorded, and the old one's runs and manifest are reclaimed unless a
  // lock stops it. Every sync must still succeed and read A's writes.
  it("sync succeeds when compaction installs and reclaims between every step of its load", async () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const name = `churn-every-step-${++runs}`;
    const ingest = createLocalIngestClient(host);
    const a = await openHarnessDb({ name, fs, ingest });
    let n = 0;
    let churning = false;
    let churns = 0;
    const churn = async () => {
      if (!churning) return;
      for (let i = 0; i < 4; i++) {
        await a.put(enc.encode(`k${n % 5}`), enc.encode(`v${n++}`));
        await host.ingest(name, Number.POSITIVE_INFINITY, true);
      }
      churns++;
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
    const b = await openHarnessDb({ name, fs: churned, ingest });
    try {
      for (let round = 0; round < 40; round++) {
        await a.put(enc.encode("round"), enc.encode(`r${round}`));
        await host.ingest(name, Number.POSITIVE_INFINITY, true);
        churning = true;
        await b.sync();
        churning = false;
        expect(dec.decode((await b.get(enc.encode("round")))!)).toBe(`r${round}`);
      }
      expect(churns, "the host churned during B's loads").toBeGreaterThan(40);
      const report = await checkDatabase(fs, name);
      expect(report.problems).toEqual([]);
    } finally {
      churning = false;
      await a.close();
      await b.close();
    }
  });

  // The other direction: a tab that holds the reclaim lock and never lets
  // go (hung, or killed before the browser frees its locks) stalls no flush
  // or compaction. Reclaim skips while it is held and catches up after.
  it("a tab that keeps the reclaim lock stalls no flush or compaction", async () => {
    const enc = new TextEncoder();
    const fs = new MemoryFs();
    const host = new EngineHost(() => fs);
    const name = `held-forever-${++runs}`;
    const a = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(host) });
    let n = 0;
    const flush = async () => {
      await a.put(enc.encode(`k${n % 3}`), enc.encode(`v${n++}`));
      await host.ingest(name, Number.POSITIVE_INFINITY, true);
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
      const during = await checkDatabase(fs, name);
      expect(during.problems).toEqual([]);
      expect(during.staleManifests.length, "nothing reclaimed while held").toBeGreaterThan(0);
      expect(during.orphans.length, "nothing reclaimed while held").toBeGreaterThan(0);
      release();
      await held;
      await flush();
      const after = await checkDatabase(fs, name);
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

describe("crash leftovers", () => {
  // Risk 6 (unbounded orphans): a crash in the middle of a compaction
  // leaves output runs no manifest lists. A host that swept once after the
  // crash must still reclaim them.
  it("a host that swept after a crash still reclaims runs the crash left behind", async () => {
    const { ops, cut } = await cutOf(COMPACTION, (at, ops) => processCut(ops, at("publish l1/")));
    const t = new Traced(`leak-${++runs}`);
    try {
      await t.load(ops, cut);
      await t.host.ingest(t.name, 0, true); // the first pass sweeps
      const db = await t.open();
      await db.put(new TextEncoder().encode("x"), new TextEncoder().encode("x1"));
      await db.ingest();
      await db.close();
      await t.host.ingest(t.name, 0, true);
      expect((await checkDatabase(t.fs, t.name)).orphans).toEqual([]);
    } finally {
      await t.dispose();
    }
  });
});

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
