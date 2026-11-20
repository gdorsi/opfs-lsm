import assert from "node:assert/strict";
import { describe as suite, test } from "node:test";
import type { Footprint, HistogramSnapshot, PhaseResult, RunRecord } from "../core/types.ts";
import { describe, measure, versus, type Measures, type Metric } from "./metrics.ts";

const hist = (n: number, sumUs: number): HistogramSnapshot => ({ n, sumUs, minUs: 0, maxUs: sumUs, buckets: [] });

function phase(name: string, over: Partial<PhaseResult> = {}): PhaseResult {
  return { name, page: "same", timed: true, wallMs: 1000, busyMs: 1000, ops: 1000, userBytes: 0, latency: {}, ...over };
}

function run(phases: PhaseResult[], over: Partial<RunRecord> = {}): RunRecord {
  return {
    workload: "kv/test",
    contender: "kv/kv",
    durability: "none",
    fastPath: "",
    size: "small",
    rep: 0,
    params: { entries: 1, keyBytes: 1, valueBytes: 1, compressibility: 0, batch: 1, ops: 1, seed: 1 },
    host: { chrome: "", headless: true, os: "", cpu: "", cores: 1, loadAvg1: 0, node: "", gitSha: "" },
    phases,
    ...over,
  };
}

/** A phase of `kops` thousand ops per second. */
const atRate = (kops: number) => phase("read", { ops: kops * 1000, wallMs: 1000, busyMs: 1000 });

const series = (m: Measures, metric: Metric, name = "read") =>
  m.get({ workload: "kv/test", size: "small", contender: "kv/kv", phase: name, metric });

const ratesOf = (kops: number[]) => measure(kops.map((k) => run([atRate(k)])));

suite("clusters", () => {
  test("two states with a gap wider than either spread are reported as two clusters", () => {
    const low = [426, 440, 452, 460, 468, 471, 475, 480, 484, 488];
    const high = [592, 600, 610, 618, 625, 631, 640, 648, 655, 658, 662];
    const s = series(ratesOf([...low, ...high]), "rate")!;
    const [lo, hi] = s.summary.clusters!;
    assert.deepEqual([lo.n, lo.min, lo.max], [10, 426_000, 488_000]);
    assert.deepEqual([hi.n, hi.min, hi.max], [11, 592_000, 662_000]);
    assert.equal(s.summary.n, 21);
  });

  test("one wide state has no clusters: its largest gap is narrower than each side's own range", () => {
    const s = series(ratesOf([100, 120, 140, 170, 190, 210]), "rate")!;
    assert.equal(s.summary.clusters, undefined);
    assert.deepEqual([s.summary.min, s.summary.max], [100_000, 210_000]);
  });

  test("a gap narrower than either side's range is not a split", () => {
    const s = series(ratesOf([100, 101, 102, 112, 121, 130, 139, 148]), "rate")!;
    assert.equal(s.summary.clusters, undefined);
  });

  test("a gap under a tenth of the median is not a split, however tight each side is", () => {
    const s = series(ratesOf([587, 610, 613, 640, 648, 650]), "rate")!;
    assert.equal(s.summary.clusters, undefined);
  });

  test("a single outlier is not a cluster", () => {
    const s = series(ratesOf([100, 101, 102, 103, 104, 300]), "rate")!;
    assert.equal(s.summary.clusters, undefined);
  });

  test("fewer than five runs never cluster", () => {
    const s = series(ratesOf([100, 101, 300, 301]), "rate")!;
    assert.equal(s.summary.clusters, undefined);
  });
});

suite("versus", () => {
  const rate = (...r: number[]) => series(ratesOf(r), "rate")!;
  const wall = (...ms: number[]) => series(measure(ms.map((w) => run([phase("read", { wallMs: w })]))), "wall")!;

  test("higher is better: disjoint runs are distinct and times is b over a", () => {
    const v = versus(rate(95, 100, 105, 98, 102), rate(190, 200, 210, 195, 205));
    assert.deepEqual(v, { times: 2, distinct: true, separable: true });
    assert.equal(describe("rate").direction, "higher");
  });

  test("higher is better: a slower b has times below 1", () => {
    const v = versus(rate(190, 200, 210, 195, 205), rate(95, 100, 105, 98, 102));
    assert.equal(v.distinct, true);
    assert.equal(v.times, 0.5);
  });

  test("lower is better: times is a over b", () => {
    const v = versus(wall(9, 10, 11, 9.5, 10.5), wall(4, 5, 6, 4.5, 5.5));
    assert.equal(describe("wall").direction, "lower");
    assert.equal(v.distinct, true);
    assert.equal(v.times, 2);
    assert.equal(versus(wall(4, 5, 6, 4.5, 5.5), wall(9, 10, 11, 9.5, 10.5)).times, 0.5);
  });

  test("overlapping runs are not distinct, whatever the medians say", () => {
    const v = versus(rate(95, 100, 150, 99, 140), rate(120, 160, 170, 100, 155));
    assert.equal(v.distinct, false);
    assert.equal(v.separable, true);
  });

  test("a side with one run is neither distinct nor separable", () => {
    const one = (kops: number) => rate(kops);
    assert.deepEqual(versus(one(100), one(200)), { times: 2, distinct: false, separable: false });
    const v = versus(one(100), rate(190, 200, 210, 195, 205));
    assert.equal(v.distinct, false);
    assert.equal(v.separable, false);
  });

  test("3 against 3 that do not overlap are neither distinct nor separable", () => {
    const v = versus(rate(95, 100, 105), rate(190, 200, 210));
    assert.equal(v.distinct, false);
    assert.equal(v.separable, false);
  });

  test("4 against 4 that do not overlap are distinct", () => {
    const v = versus(rate(95, 100, 105, 98), rate(190, 200, 210, 195));
    assert.equal(v.distinct, true);
    assert.equal(v.separable, true);
  });

  test("5 against 5 with one value inside the other range are still distinct", () => {
    const v = versus(rate(42.8, 42.5, 43, 42.8, 47.4), rate(47.9, 47.6, 48.1, 47.3, 47.8));
    assert.equal(v.distinct, true);
  });

  test("a run beyond the other side's range counts as one rank: four of five below is not enough", () => {
    assert.equal(versus(wall(6.11, 6.17, 6.78, 9.74, 48.23), wall(10.18, 10.45, 10.85, 11.09, 11.36)).distinct, false);
  });

  test("interleaved runs are not distinct", () => {
    assert.equal(versus(wall(100, 101, 102, 103, 104), wall(100.5, 101.5, 102.5, 103.5, 104.5)).distinct, false);
  });

  test("tied runs that pass with few runs are distinct and separable", () => {
    const v = versus(wall(1, 1), wall(2, 2, 2, 2, 2));
    assert.equal(v.distinct, true);
    assert.equal(v.separable, true);
  });
});

suite("timed phases", () => {
  const open = phase("coldopen", {
    wallMs: 100,
    busyMs: 80,
    ops: 1000,
    latency: { open: hist(1, 40_000), get: hist(1000, 50_000) },
  });
  const m = measure([run([open]), run([{ ...open, wallMs: 120, busyMs: 100, latency: { open: hist(1, 60_000), get: hist(1000, 50_000) } }])]);
  const at = (metric: Metric) => series(m, metric, "coldopen");

  test("mean:<op> is the run's own sum over count, and mean:open is the store open", () => {
    assert.deepEqual(at("mean:open")!.values, [40, 60]);
    assert.deepEqual(at("mean:get")!.values, [0.05, 0.05]);
  });

  test("wall includes the open", () => {
    assert.deepEqual(at("wall")!.values, [100, 120]);
  });

  test("rate divides ops by the busy time, which includes the open, and not by the wall time", () => {
    assert.deepEqual(at("rate")!.values, [(1000 / 80) * 1000, (1000 / 100) * 1000]);
  });

  test("an untimed phase has no timing series", () => {
    const settle = measure([run([phase("settle", { timed: false, wallMs: 0, ops: 0 })])]);
    assert.deepEqual(settle.all, []);
  });

  test("a phase with no ops has a wall but no rate", () => {
    const m2 = measure([run([phase("open-only", { ops: 0, wallMs: 5, latency: { open: hist(1, 5000) } })])]);
    assert.ok(series(m2, "wall", "open-only"));
    assert.equal(series(m2, "rate", "open-only"), undefined);
  });
});

suite("runs", () => {
  test("a failed run feeds no series", () => {
    const m = measure([run([atRate(100)]), run([atRate(900)], { error: "boom" }), run([atRate(110)])]);
    const s = series(m, "rate")!;
    assert.deepEqual(s.values, [100_000, 110_000]);
    assert.equal(s.summary.max, 110_000);
  });

  test("a workload with only failed runs has no series", () => {
    assert.deepEqual(measure([run([atRate(100)], { error: "boom" })]).all, []);
  });

  test("two phases of one name throw", () => {
    assert.throws(() => measure([run([atRate(100), atRate(200)])]), /two phases are named "read"/);
  });

  test("series are listed in phase order, then contender", () => {
    const m = measure([
      run([phase("b"), phase("a")], { contender: "kv/kv" }),
      run([phase("b"), phase("a")], { contender: "kv/idb" }),
    ]);
    const walls = m.all.filter((s) => s.at.metric === "wall").map((s) => `${s.at.phase} ${s.at.contender}`);
    assert.deepEqual(walls, ["b kv/idb", "b kv/kv", "a kv/idb", "a kv/kv"]);
  });
});

suite("footprints", () => {
  const base = { opfsBytes: 1000, idbEstimateBytes: 0, liveLogicalBytes: 500 };
  const amps = (m: Measures) => m.all.filter((s) => s.at.metric.startsWith("amp:")).map((s) => s.at.metric.slice(4));

  test("an approximate footprint yields only space and byte measures, marked approximate", () => {
    const m = measure([run([phase("settle", { timed: false, ops: 0, userBytes: 300, footprint: { ...base, idbEstimateBytes: 200 } })])]);
    assert.deepEqual(amps(m).sort(), ["diskBytes", "liveBytes", "spaceAmp", "userBytes"]);
    const space = series(m, "amp:spaceAmp", "settle")!;
    assert.equal(space.approx, true);
    assert.deepEqual(space.values, [2.4]);
  });

  test("a kv footprint yields write amplification from the counters, summed over the page's phases", () => {
    const kv = {
      tab: { walBytes: 120 },
      host: {
        fs: { written: { l0: { calls: 1, bytes: 100 }, l1: { calls: 1, bytes: 200 }, l2: { calls: 1, bytes: 100 }, m: { calls: 1, bytes: 10 } } },
        layout: [
          { level: 0, runs: 2, bytes: 1 },
          { level: 1, runs: 1, bytes: 1 },
          { level: 2, runs: 0, bytes: 0 },
        ],
      },
    } as unknown as Footprint["kv"];
    const m = measure([
      run([
        phase("fill", { userBytes: 40 }),
        phase("settle", { timed: false, ops: 0, userBytes: 60, footprint: { ...base, kv } }),
      ]),
    ]);
    const v = (name: string) => series(m, `amp:${name}` as Metric, "settle")!.values[0];
    assert.equal(v("wampEngine"), 4);
    assert.equal(v("wampTotal"), 5.3);
    assert.equal(v("compaction"), 3);
    assert.equal(v("readAmp"), 3);
    assert.equal(v("spaceAmp"), 2);
    assert.equal(v("userBytes"), 100);
    assert.equal(series(m, "amp:walBytes", "settle")!.approx, false);
  });

  test("user bytes stop at the last fresh page", () => {
    const m = measure([
      run([
        phase("fill", { userBytes: 40 }),
        phase("reopen", { page: "fresh", userBytes: 5 }),
        phase("settle", { timed: false, ops: 0, userBytes: 10, footprint: base }),
      ]),
    ]);
    assert.deepEqual(series(m, "amp:userBytes", "settle")!.values, [15]);
  });

  test("after a phase with rounds, user bytes are those of its last round, whose tab goes on", () => {
    const reopen = phase("reopen", { page: "fresh", userBytes: 5 });
    const m = measure([
      run([
        { ...reopen, laterRounds: [{ ...reopen, userBytes: 7 }] },
        phase("settle", { timed: false, ops: 0, userBytes: 10, footprint: base }),
      ]),
    ]);
    assert.deepEqual(series(m, "amp:userBytes", "settle")!.values, [17]);
  });

  test("a footprint after a second tab wrote has disk bytes but no write amplification", () => {
    const m = measure([
      run([
        phase("fill", { userBytes: 40 }),
        phase("write-second", { page: "other", userBytes: 5 }),
        phase("settle", { timed: false, ops: 0, footprint: base }),
      ]),
    ]);
    assert.equal(series(m, "amp:wampTotal", "settle"), undefined);
    assert.equal(series(m, "amp:userBytes", "settle"), undefined);
    assert.ok(series(m, "amp:diskBytes", "settle"));
  });
});

suite("memory", () => {
  test("the SharedWorker total adds heap in use, backing store and wasm memory, with no phase", () => {
    const memory = {
      worker: { usedSize: 10, totalSize: 99, backingStorageSize: 20, samples: 1 },
      workerWasmBytes: 30,
      tab: null,
      tabWasmBytes: null,
      largestRendererBytes: 500,
    };
    const m = measure([run([atRate(100)], { memory })]);
    const s = m.get({ workload: "kv/test", size: "small", contender: "kv/kv", metric: "mem:workerTotal" })!;
    assert.deepEqual(s.values, [60]);
    assert.equal(m.get({ workload: "kv/test", size: "small", contender: "kv/kv", metric: "mem:tabTotal" }), undefined);
  });
});

suite("rounds", () => {
  const cold = (ms: number, n = 1) => ({ cold: hist(n, ms * 1000 * n) });
  const first = phase("goal", { page: "fresh", wallMs: 40, busyMs: 30, ops: 20, latency: cold(4) });
  const later = [phase("goal", { page: "fresh", wallMs: 9, ops: 1, latency: cold(8) }), phase("goal", { page: "fresh", wallMs: 9, ops: 1, latency: cold(6) })];
  const m = measure([run([{ ...first, laterRounds: later }])]);

  test("an op's mean pools its samples over every round", () => {
    assert.equal(series(m, "mean:cold", "goal")!.values[0], 6);
  });

  test("wall and rate stay the first round's, as in a record without rounds", () => {
    const alone = measure([run([first])]);
    assert.deepEqual(series(m, "wall", "goal")!.values, series(alone, "wall", "goal")!.values);
    assert.deepEqual(series(m, "rate", "goal")!.values, series(alone, "rate", "goal")!.values);
  });

  test("an op only a later round timed still has a series", () => {
    const only = measure([run([{ ...first, laterRounds: [phase("goal", { latency: { open: hist(1, 3000) } })] }])]);
    assert.equal(series(only, "mean:open", "goal")!.values[0], 3);
  });
});

suite("seeds", () => {
  const seeded = (seed: number, over: Partial<RunRecord> = {}) => run([atRate(1)], { params: { ...run([]).params, seed }, ...over });

  test("each seed of a successful run is listed once, in ascending order", () => {
    assert.deepEqual(measure([seeded(7), seeded(1), seeded(7)]).seeds, [1, 7]);
  });

  test("a failed run's seed is not listed", () => {
    assert.deepEqual(measure([seeded(1), seeded(7, { error: "timeout" })]).seeds, [1]);
  });
});

suite("kv options", () => {
  test("each set of overrides is listed once, and default runs list none", () => {
    assert.deepEqual(measure([run([atRate(1)])]).kvOptions, []);
    const small = { kv: { cacheBytes: 4_194_304 } };
    assert.deepEqual(measure([run([atRate(1)], small), run([atRate(1)], small), run([atRate(1)])]).kvOptions, ["cacheBytes 4194304"]);
  });
});
