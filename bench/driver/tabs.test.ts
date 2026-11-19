import assert from "node:assert/strict";
import { test } from "node:test";
import type { PageMode } from "../core/types.ts";
import { tabPlan } from "./tabs.ts";

const plan = (...phases: (PageMode | [PageMode, number])[]) =>
  tabPlan(phases.map((p) => (typeof p === "string" ? { page: p, rounds: 1 } : { page: p[0], rounds: p[1] })));
const slots = (...pages: PageMode[]) => plan(...pages).map((s) => s.slot);
const freshAt = (...phases: (PageMode | [PageMode, number])[]) => plan(...phases).map((s) => s.fresh);

test("a same phase stays in the tab of the phase before it", () => {
  assert.deepEqual(slots("same", "same"), [0, 0]);
  assert.deepEqual(slots("same", "other", "same"), [0, 1, 1]);
});

test("an other phase swaps tabs each time", () => {
  assert.deepEqual(slots("same", "other", "other", "same", "other"), [0, 1, 0, 0, 1]);
});

test("a fresh phase is the first tab, wherever the phase before ran", () => {
  assert.deepEqual(slots("same", "other", "fresh", "other"), [0, 1, 0, 1]);
});

test("the first phase never closes a tab, and every later fresh phase does", () => {
  assert.deepEqual(freshAt("fresh", "same", "fresh", "other", "same"), [false, false, true, false, false]);
});

test("every round after the first starts on a fresh tab, also in the first phase", () => {
  assert.deepEqual(freshAt(["fresh", 3], "same"), [false, true, true, false]);
  assert.deepEqual(
    plan("same", ["fresh", 2]).map((s) => [s.phase, s.round, s.fresh]),
    [[0, 0, false], [1, 0, true], [1, 1, true]],
  );
});
