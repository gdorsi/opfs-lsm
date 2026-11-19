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
    phases: [{ name: "read", page: "same", timed: true, wallMs: 1000, ops: kops * 1000, userBytes: 0, latency: {} }],
  };
}

const runs = (seed: number) => [run(seed, 100), run(seed, 110)];

test("compare says when the two files ran on different seeds", () => {
  assert.match(compare(measure(runs(1)), measure(runs(7))), /A ran on seed 1 and B on seed 7, so this compares two inputs/);
});

test("compare says nothing about seeds when both files ran on the same one", () => {
  assert.doesNotMatch(compare(measure(runs(7)), measure(runs(7))), /seed/);
});

test("the report states a seed other than the default, and is silent on the default", () => {
  assert.match(report(runs(7)), /seed 7, not the default 1/);
  assert.doesNotMatch(report(runs(1)), /seed/);
});
