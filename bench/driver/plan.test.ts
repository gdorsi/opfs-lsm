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

function orders(contenders: string[], reps: number): string[][] {
  const catalog: Catalog = [{ ...CATALOG[0]!, contenders }];
  const runs = plan(catalog, { workloads: [], contenders: [], size: "tiny", reps, seed: 1 });
  return Array.from({ length: reps }, (_, rep) => runs.filter((r) => r.rep === rep).map((r) => r.contender));
}

test("three contenders over six reps run all six orders", () => {
  const seen = orders(["a", "b", "c"], 6).map((o) => o.join(""));
  assert.equal(new Set(seen).size, 6, seen.join(" "));
});

test("over six reps every contender follows every other one", () => {
  const follows = new Set<string>();
  for (const order of orders(["a", "b", "c"], 6)) order.slice(1).forEach((c, i) => follows.add(`${order[i]}>${c}`));
  assert.equal(follows.size, 6);
});

test("two contenders swap places, and each leads as often as the other", () => {
  const seen = orders(["a", "b"], 4);
  assert.deepEqual(seen.slice(0, 2), [["a", "b"], ["b", "a"]]);
  assert.equal(seen.filter((o) => o[0] === "a").length, 2);
});

test("one contender runs once per rep", () => {
  assert.deepEqual(orders(["a"], 3), [["a"], ["a"], ["a"]]);
});
