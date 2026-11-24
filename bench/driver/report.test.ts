import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRecord } from "../core/types.ts";
import { measure } from "./metrics.ts";
import { compare, report } from "./report.ts";

function run(seed: number, kops: number): RunRecord {
  return {
    workload: "kv/test",
    contender: "kv/kv",
    durability: "none",
    fastPath: "",
    size: "small",
    rep: 0,
    params: { entries: 1, keyBytes: 1, valueBytes: 1, compressibility: 0, batch: 1, ops: 1, seed },
    host: { chrome: "", headless: true, os: "", cpu: "", cores: 1, loadAvg1: 0, node: "", gitSha: "" },
    phases: [{ name: "read", page: "same", timed: true, wallMs: 1000, spanMs: 1000, ops: kops * 1000, userBytes: 0, latency: {} }],
  };
}

const runs = (seed: number) => [run(seed, 100), run(seed, 110)];

test("compare says when the two files ran on different seeds", () => {
  assert.match(compare(measure(runs(1)), measure(runs(7))), /A ran on seed 1 and B on seed 7, so this compares two inputs/);
});

test("compare says nothing about seeds when both files ran on the same one", () => {
  assert.doesNotMatch(compare(measure(runs(7)), measure(runs(7))), /seed/);
});

test("compare names the failed runs of each file, which its medians leave out", () => {
  const out = compare(measure([...runs(1), { ...run(1, 5), error: "timeout" }]), measure(runs(1)));
  assert.match(out, /A has 1 failed run of kv\/test small kv\/kv, left out of its medians/);
  assert.doesNotMatch(out, /B has/);
});

test("the report states a seed other than the default, and is silent on the default", () => {
  assert.match(report(runs(7)), /seed 7, not the default 1/);
  assert.doesNotMatch(report(runs(1)), /seed/);
});

/** One run per value on the default seed, each reading `kops` thousand ops per second. Its wall time is the same in every run, so that series never differs. */
const rates = (kops: number[]) => measure(kops.map((k) => run(1, k)));

test("compare lists a series whose runs the rank-sum test separates, with the ratio", () => {
  const out = compare(rates([95, 100, 105, 98, 102]), rates([190, 200, 210, 195, 205]));
  assert.match(out, /\| kv\/test \| small \| read \| kv\/kv \| rate \|.*\| B better ×2\.00 \|/);
  assert.match(out, /2 series compared, 1 with no measurable difference/);
  assert.doesNotMatch(out, /too few runs/);
});

test("compare: one value inside the other range is still a difference", () => {
  const out = compare(rates([42.8, 42.5, 43, 42.8, 47.4]), rates([47.9, 47.6, 48.1, 47.3, 47.8]));
  assert.match(out, /B better/);
});

test("compare counts the runs the test does not separate, and lists them only with --all", () => {
  const a = rates([95, 100, 150, 99, 140]);
  const b = rates([120, 160, 170, 100, 155]);
  assert.doesNotMatch(compare(a, b), /\| kv\/test \|/);
  assert.match(compare(a, b), /2 series compared, 2 with no measurable difference/);
  assert.match(compare(a, b, { all: true }), /\| ≈ \|/);
});

test("compare counts the series with too few runs to show a difference, and says 4 per side are enough", () => {
  const out = compare(rates([95, 100, 105]), rates([190, 200, 210]));
  assert.match(out, /2 series compared, 2 with no measurable difference\n2 of them have too few runs to show a difference: 4 runs per side are enough/);
});

test("compare says how many differences chance alone would give, counting only the series the test can separate and mark", () => {
  const out = compare(rates([95, 100, 105, 98, 102]), rates([190, 200, 210, 195, 205]));
  assert.match(out, /\nchance alone would mark about 0\.1 of the 1 series the test can separate, at the 5% level/);
  assert.doesNotMatch(compare(rates([95, 100, 105]), rates([190, 200, 210])), /chance alone/);
  assert.doesNotMatch(compare(rates([100, 100, 100, 100, 100]), rates([100, 100, 100, 100, 100])), /chance alone/);
  const many = (n: number) =>
    measure(
      Array.from({ length: 5 }, (_, k) => {
        const r = run(1, 100 + k);
        return { ...r, phases: Array.from({ length: n }, (_, i) => ({ ...r.phases[0]!, name: `p${i}` })) };
      }),
    );
  assert.match(compare(many(20), many(20)), /chance alone would mark about 1\.0 of the 20 series/);
});

test("the report lists the ops of every run, not only the first", () => {
  const snap = { n: 1, sumUs: 1, minUs: 1, maxUs: 1, buckets: [[1, 1]] as [number, number][] };
  const withOps = (latency: Record<string, typeof snap>): RunRecord => {
    const r = run(1, 100);
    return { ...r, phases: [{ ...r.phases[0]!, latency }] };
  };
  const [a, b] = [withOps({ get: snap }), withOps({ get: snap, scan: snap })];
  assert.match(report([a, b]), /\| scan \|/);
});
