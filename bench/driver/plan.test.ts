import assert from "node:assert/strict";
import { test } from "node:test";
import type { Catalog } from "../core/types.ts";
import { plan } from "./plan.ts";

const CATALOG: Catalog = [
  { workload: "kv/a", family: "kv", title: "", owns: [], phases: [{ name: "fill", page: "same", rounds: 1 }], contenders: ["kv/idb", "kv/kv"] },
];

test("every planned run carries the selection's seed", () => {
  const runs = plan(CATALOG, { workloads: [], contenders: [], size: "tiny", reps: 2, seed: 7 });
  assert.equal(runs.length, 4);
  assert.deepEqual(new Set(runs.map((r) => r.seed)), new Set([7]));
});
