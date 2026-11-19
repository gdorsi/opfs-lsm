import assert from "node:assert/strict";
import { test } from "node:test";
import type { Footprint, PhaseResult, RunRecord } from "../core/types.ts";
import { budgetProblems, type Budget } from "./budgets.ts";
import { measure } from "./metrics.ts";

const budget: Budget = { workload: "kv/test", contender: "kv/kv", size: "tiny", phase: "settle", metric: "amp:spaceAmp", max: 1.5 };

function settle(name: string, diskBytes: number): PhaseResult {
  const footprint = { opfsBytes: diskBytes, idbEstimateBytes: 0, liveLogicalBytes: 1000 } as Footprint;
  return { name, page: "same", timed: false, wallMs: 1, ops: 0, userBytes: 0, latency: {}, footprint };
}

function run(phases: PhaseResult[], over: Partial<RunRecord> = {}): RunRecord {
  return {
    workload: "kv/test",
    contender: "kv/kv",
    durability: "none",
    fastPath: "",
    size: "tiny",
    rep: 0,
    params: { entries: 1, keyBytes: 1, valueBytes: 1, compressibility: 0, batch: 1, ops: 1, seed: 1 },
    host: { chrome: "", headless: true, os: "", cpu: "", cores: 1, loadAvg1: 0, node: "", gitSha: "" },
    phases,
    ...over,
  };
}

const problems = (records: RunRecord[]) => budgetProblems(measure(records), [budget]);

test("every run at or under the budget passes", () => {
  assert.deepEqual(problems([run([settle("settle", 1400)]), run([settle("settle", 1500)])]), []);
});

test("one run over the budget fails, whatever the median says", () => {
  const found = problems([run([settle("settle", 1000)]), run([settle("settle", 1000)]), run([settle("settle", 1600)])]);
  assert.equal(found.length, 1);
  assert.match(found[0]!, /kv\/test kv\/kv tiny settle amp:spaceAmp: 1\.600 is over the budget of 1\.5/);
});

test("a renamed phase fails its budget instead of switching it off", () => {
  const found = problems([run([settle("settled", 1000)])]);
  assert.equal(found.length, 1);
  assert.match(found[0]!, /recorded no such number/);
});

test("a budget whose workload, contender or size did not run is skipped", () => {
  assert.deepEqual(problems([run([settle("settle", 9000)], { size: "small" })]), []);
  assert.deepEqual(problems([run([settle("settle", 9000)], { contender: "kv/idb" })]), []);
  assert.deepEqual(problems([]), []);
});
