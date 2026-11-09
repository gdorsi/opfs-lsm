/**
 * decide.test.ts — the gate and the loop as tables. No I/O. `node --test 'factory/*.test.ts'`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeDecision,
  nextStep,
  plan,
  NO_RECORDS,
  type MergeInput,
  type MergeDecision,
  type Sha,
  type Pr,
  type World,
  type Rules,
  type Records,
  type Step,
} from "./decide.ts";

const sha = (s: string) => s.padEnd(40, "0") as Sha;
const H = sha("a1"), MB = sha("b1"), T = sha("c1"), TREE = sha("d1"), TT = sha("e1");

/** Every condition met. Each row below breaks exactly one thing. */
const clean: MergeInput = {
  owner: "gdorsi", author: "gdorsi", draft: false, hold: false,
  base: { kind: "trunk" }, head: H, mergeBase: MB, trunkHead: T,
  landing: { kind: "clean", tree: TREE },
  review: { state: "done", key: MB, at: 0, result: { findings: [] } },
  verify: { state: "done", key: TREE, at: 0, result: { steps: [{ name: "test", outcome: "pass", seconds: 1, tail: "" }] } },
  gatePaths: [], tooLarge: false, attribution: [],
};
const unmetOf = (d: MergeDecision) => (d.ok ? [] : d.unmet.map((u) => u.why));
const blocker = { id: "R1", path: null, line: null, severity: "blocker" as const, title: "t", detail: "d" };
const nit = { ...blocker, severity: "nit" as const };

test("all conditions met -> ticket for exactly this head, trunk and tree", () => {
  const d = mergeDecision(clean, 91);
  assert.ok(d.ok);
  assert.deepEqual([d.ticket.pr, d.ticket.head, d.ticket.trunk, d.ticket.tree], [91, H, T, TREE]);
});

const rows: [string, Partial<MergeInput>, string[]][] = [
  ["a push after review (review keyed to another merge base)", { review: { state: "done", key: sha("old"), at: 0, result: { findings: [] } } }, ["review-missing"]],
  ["main moved (verify keyed to another landing tree)", { landing: { kind: "clean", tree: sha("d2") } }, ["verify-missing"]],
  ["blocker finding", { review: { state: "done", key: MB, at: 0, result: { findings: [blocker] } } }, ["review-blockers"]],
  ["nit only", { review: { state: "done", key: MB, at: 0, result: { findings: [nit] } } }, []],
  ["flaky step still green", { verify: { state: "done", key: TREE, at: 0, result: { steps: [{ name: "two-tab", outcome: "flaky", seconds: 1, tail: "" }] } } }, []],
  ["failed step", { verify: { state: "done", key: TREE, at: 0, result: { steps: [{ name: "test", outcome: "fail", seconds: 1, tail: "x" }] } } }, ["verify-failed"]],
  ["empty suite is not green", { verify: { state: "done", key: TREE, at: 0, result: { steps: [] } } }, ["verify-failed"]],
  ["review running", { review: { state: "running", key: MB, startedAt: 5 } }, ["review-running"]],
  ["verify errored", { verify: { state: "errored", key: TREE, at: 0, why: "infra" } }, ["verify-errored"]],
  ["stacked", { base: { kind: "stacked", on: 88 } }, ["not-on-trunk"]],
  ["conflict also invalidates verify", { landing: { kind: "conflict", paths: ["a.ts"] } }, ["conflict", "verify-missing"]],
  ["gate path", { gatePaths: [".github/workflows/m1-smoke.yml"] }, ["gate-paths"]],
  ["attribution in a commit message", { attribution: ["commit:abc"] }, ["attribution"]],
  ["too many paths", { tooLarge: true }, ["too-large"]],
  ["someone else's PR", { author: "mallory" }, ["not-owner"]],
  ["draft", { draft: true }, ["draft"]],
  ["hold", { hold: true }, ["hold"]],
];
for (const [name, patch, expected] of rows) {
  test(`merge gate: ${name}`, () => assert.deepEqual(unmetOf(mergeDecision({ ...clean, ...patch })), expected));
}

// ───────────────────────────── nextStep / plan ─────────────────────────────

const rules: Rules = {
  owner: "gdorsi", trunk: "main", stage: "merge", maxFixes: 2, maxErrors: 2,
  runsPerDay: { review: 30, verify: 40, fix: 12 },
  timeoutMs: { review: 20 * 60_000, verify: 45 * 60_000, fix: 30 * 60_000 },
  graceMs: 10 * 60_000, backoffMs: 30 * 60_000, settleMs: 5 * 60_000,
};
const NOW = 100 * 60_000;
const doneRecords: Records = {
  review: { latest: { state: "done", key: MB, at: 0, result: { findings: [] } }, errors: 0 },
  verify: { latest: { state: "done", key: TREE, at: 0, result: { steps: [{ name: "test", outcome: "pass", seconds: 1, tail: "" }] } }, errors: 0 },
  fix: { latest: null, errors: 0 },
};
const basePr: Pr = {
  number: 91, branch: "fix/x", author: "gdorsi", title: "t", body: "b", draft: false, hold: false,
  base: { kind: "trunk" }, head: H, headAt: 0, mergeBase: MB, landing: { kind: "clean", tree: TREE },
  changed: ["packages/kv/src/a.ts"], gatePaths: [], streak: 0, attribution: [], records: doneRecords, priorReview: null,
};
const world = (prs: Pr[], patch: Partial<World> = {}): World => ({
  now: NOW, paused: false,
  trunk: { name: "main", head: T, tree: TT, verify: { latest: { state: "done", key: TT, at: 0, result: { steps: [{ name: "test", outcome: "pass", seconds: 1, tail: "" }] } }, errors: 0 } },
  prs, usage: { review: 0, verify: 0, fix: 0 }, ...patch,
});
const pr = (patch: Partial<Pr>): Pr => ({ ...basePr, ...patch });
const rec = (patch: Partial<Records>): Records => ({ ...doneRecords, ...patch });
const tracked = (s: Step) => { assert.equal(s.kind, "track"); return s as Step & { kind: "track" }; };

test("clean PR at stage merge -> merge act", () => {
  const s = tracked(nextStep(basePr, world([basePr]), rules));
  assert.equal(s.act?.kind, "merge");
  assert.equal(s.status.phase, "landing");
});
test("clean PR at stage fix -> hand off ready", () => {
  const s = tracked(nextStep(basePr, world([basePr]), { ...rules, stage: "fix" }));
  assert.deepEqual([s.status.phase, (s.status as { code: string }).code, s.act], ["handed-off", "ready", null]);
});
test("paused -> waiting, no act", () => {
  const s = tracked(nextStep(basePr, world([basePr], { paused: true }), rules));
  assert.deepEqual([s.status.phase, s.act], ["waiting", null]);
});
test("someone else's PR -> ignore", () => {
  assert.equal(nextStep(pr({ author: "mallory" }), world([]), rules).kind, "ignore");
});
test("hold -> waiting without jobs", () => {
  const s = tracked(nextStep(pr({ hold: true, records: NO_RECORDS }), world([]), rules));
  assert.deepEqual([s.status.phase, s.want.length], ["waiting", 0]);
});
test("no records -> want review and verify", () => {
  const s = tracked(nextStep(pr({ records: NO_RECORDS }), world([]), rules));
  assert.deepEqual(s.want.map((j) => j.kind), ["review", "verify"]);
});
test("fresh head -> settling, no jobs", () => {
  const s = tracked(nextStep(pr({ records: NO_RECORDS, headAt: NOW - 60_000 }), world([]), rules));
  assert.deepEqual([s.status.phase, s.want.length], ["waiting", 0]);
});
test("conflict -> hand off before any spend", () => {
  const s = tracked(nextStep(pr({ records: NO_RECORDS, landing: { kind: "conflict", paths: ["a"] } }), world([]), rules));
  assert.deepEqual([s.status.phase, (s.status as { code: string }).code, s.want.length], ["handed-off", "conflict", 0]);
});
test("blocker with verify still running -> working, no fix yet", () => {
  const s = tracked(nextStep(pr({ records: rec({
    review: { latest: { state: "done", key: MB, at: 0, result: { findings: [blocker] } }, errors: 0 },
    verify: { latest: { state: "running", key: TREE, startedAt: NOW - 60_000 }, errors: 0 },
  }) }), world([]), rules));
  assert.deepEqual([s.status.phase, s.want.length], ["working", 0]);
});
test("blocker + failed step, streak 0 -> want fix with both inputs and the PR's own paths", () => {
  const s = tracked(nextStep(pr({ records: rec({
    review: { latest: { state: "done", key: MB, at: 0, result: { findings: [blocker, nit] } }, errors: 0 },
    verify: { latest: { state: "done", key: TREE, at: 0, result: { steps: [{ name: "test", outcome: "fail", seconds: 1, tail: "boom" }] } }, errors: 0 },
  }) }), world([]), rules));
  const j = s.want[0];
  assert.equal(j?.kind, "fix");
  if (j?.kind !== "fix") return;
  assert.deepEqual([j.findings.length, j.failures.map((f) => f.name), j.allowedPaths, j.attempt], [1, ["test"], ["packages/kv/src/a.ts"], 1]);
});
test("streak == maxFixes -> hand off fix-exhausted", () => {
  const s = tracked(nextStep(pr({ streak: 2, records: rec({ review: { latest: { state: "done", key: MB, at: 0, result: { findings: [blocker] } }, errors: 0 } }) }), world([]), rules));
  assert.equal((s.status as { code: string }).code, "fix-exhausted");
});
test("stage review + blocker -> hand off autofix-off", () => {
  const s = tracked(nextStep(pr({ records: rec({ review: { latest: { state: "done", key: MB, at: 0, result: { findings: [blocker] } }, errors: 0 } }) }), world([]), { ...rules, stage: "review" }));
  assert.equal((s.status as { code: string }).code, "autofix-off");
});
test("fix disputed on head -> hand off fix-disputed, no job", () => {
  const s = tracked(nextStep(pr({ records: rec({
    review: { latest: { state: "done", key: MB, at: 0, result: { findings: [blocker] } }, errors: 0 },
    fix: { latest: { state: "done", key: H, at: 0, result: { outcome: "disputed", disputes: [{ id: "R1", reason: "no" }] } }, errors: 0 },
  }) }), world([]), rules));
  assert.deepEqual([(s.status as { code: string }).code, s.want.length], ["fix-disputed", 0]);
});
test("fix superseded on head -> waiting", () => {
  const s = tracked(nextStep(pr({ records: rec({
    review: { latest: { state: "done", key: MB, at: 0, result: { findings: [blocker] } }, errors: 0 },
    fix: { latest: { state: "done", key: H, at: 0, result: { outcome: "superseded" } }, errors: 0 },
  }) }), world([]), rules));
  assert.equal(s.status.phase, "waiting");
});
test("review errored at the cap -> hand off reviewer-failing", () => {
  const s = tracked(nextStep(pr({ records: rec({ review: { latest: { state: "errored", key: MB, at: 0, why: "crashed" }, errors: 2 } }) }), world([]), rules));
  assert.equal((s.status as { code: string }).code, "reviewer-failing");
});
test("review unavailable 10 min ago -> waiting (backoff), not counted", () => {
  const s = tracked(nextStep(pr({ records: rec({ review: { latest: { state: "errored", key: MB, at: NOW - 10 * 60_000, why: "unavailable" }, errors: 0 } }) }), world([]), rules));
  assert.deepEqual([s.status.phase, s.want.length], ["waiting", 0]);
});
test("running review older than timeout + grace -> want review again", () => {
  const s = tracked(nextStep(pr({ records: rec({ review: { latest: { state: "running", key: MB, startedAt: NOW - 40 * 60_000 }, errors: 0 } }) }), world([]), rules));
  assert.deepEqual(s.want.map((j) => j.kind), ["review"]);
});
test("main red and verify failed -> waiting, no fix", () => {
  const w = world([], { trunk: { name: "main", head: T, tree: TT, verify: { latest: { state: "done", key: TT, at: 0, result: { steps: [{ name: "test", outcome: "fail", seconds: 1, tail: "" }] } }, errors: 0 } } });
  const s = tracked(nextStep(pr({ records: rec({ verify: { latest: { state: "done", key: TREE, at: 0, result: { steps: [{ name: "test", outcome: "fail", seconds: 1, tail: "" }] } }, errors: 0 } }) }), w, rules));
  assert.deepEqual([s.status.phase, s.want.length], ["waiting", 0]);
});
test("base landed -> retarget", () => {
  const s = tracked(nextStep(pr({ base: { kind: "landed", pr: 90, into: "main" } }), world([]), rules));
  assert.deepEqual(s.act, { kind: "retarget", to: "main" });
});
test("stacked and clean -> waiting on the base", () => {
  const s = tracked(nextStep(pr({ base: { kind: "stacked", on: 90 } }), world([]), rules));
  assert.deepEqual([s.status.phase, s.want.length], ["waiting", 0]);
});
test("gate paths and clean -> hand off gate-paths", () => {
  const s = tracked(nextStep(pr({ gatePaths: ["factory/x.ts"] }), world([]), rules));
  assert.equal((s.status as { code: string }).code, "gate-paths");
});

test("plan: one job per lane, trunk verify first, lowest PR first", () => {
  const w = world(
    [pr({ number: 91, records: NO_RECORDS }), pr({ number: 88, records: NO_RECORDS, head: sha("a2"), landing: { kind: "clean", tree: sha("d3") } })],
    { trunk: { name: "main", head: T, tree: TT, verify: { latest: null, errors: 0 } } },
  );
  const p = plan(w, rules);
  assert.deepEqual(p.start.map((j) => (j.kind === "verify" ? `verify:${"trunk" in j.on ? "trunk" : j.on.pr}` : `${j.kind}:${j.pr}`)), ["verify:trunk", "review:88"]);
  const s91 = p.steps.find((s) => s.pr.number === 91)!.step;
  assert.equal(s91.status.phase, "waiting");
});
test("plan: daily cap blocks a lane", () => {
  const p = plan(world([pr({ records: NO_RECORDS })], { usage: { review: 30, verify: 0, fix: 0 } }), rules);
  assert.deepEqual(p.start.map((j) => j.kind), ["verify"]);
});
test("plan: a fresh running record anywhere occupies its lane", () => {
  const busy = pr({ number: 50, records: rec({ verify: { latest: { state: "running", key: TREE, startedAt: NOW - 1000 }, errors: 0 } }) });
  const p = plan(world([busy, pr({ number: 91, records: NO_RECORDS })]), rules);
  assert.deepEqual(p.start.map((j) => j.kind), ["review"]);
});
