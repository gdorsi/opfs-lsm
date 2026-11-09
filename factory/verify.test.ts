/**
 * verify.test.ts — SUITE and docs/verification.md must not drift, and the suite runner's rules
 * (re-run once, flaky, install stops the run, infra on sleep, tail budget) hold. No sudo: a fake runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Sha, StepResult } from "./decide.ts";
import type { Exit, RunOpts } from "./sandbox.ts";
import type { Worktree } from "./workspace.ts";
import { SUITE, fitTails, suiteCommands, suiteEnv, tailOf, verify, type VerifyEnv } from "./verify.ts";

test("every SUITE command appears in docs/verification.md", async () => {
  const doc = await readFile(new URL("../docs/verification.md", import.meta.url), "utf8");
  const missing = suiteCommands().filter((c) => !doc.includes(c));
  assert.deepEqual(missing, []);
});

const wt: Worktree = { path: "/work/landing", capture: async () => "t" as Sha, dispose: async () => {} };
const env = (deadline = Date.now() + 3_600_000): VerifyEnv => ({
  user: "factoryrun",
  chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  pnpmStore: "/Users/factoryrun/.factory/pnpm-store",
  cargoTarget: "/Users/factoryrun/.factory/cargo-target",
  deadline,
});
const exit = (over: Partial<Exit> = {}): Exit => ({ code: 0, signal: null, stdout: "", stderr: "", seconds: 1, timedOut: false, interrupted: false, ...over });

/** A runner scripted per step name: each call pops the next Exit for that command; default pass. */
function scripted(plan: Record<string, Exit[]>): { run: (argv: readonly string[], o: RunOpts) => Promise<Exit>; calls: { argv: readonly string[]; opts: RunOpts }[] } {
  const calls: { argv: readonly string[]; opts: RunOpts }[] = [];
  const byCmd = new Map(SUITE.map((c) => [c.argv.join(" "), c.name]));
  return {
    calls,
    run: async (argv, opts) => {
      calls.push({ argv, opts });
      const name = byCmd.get(argv.join(" ")) ?? "?";
      return plan[name]?.shift() ?? exit();
    },
  };
}

test("all green: every step runs once, in order, as the run user with the suite env", async () => {
  const s = scripted({});
  const out = await verify(wt, env(), s.run);
  assert.equal(out.kind, "ran");
  if (out.kind !== "ran") return;
  assert.deepEqual(out.result.steps.map((x) => [x.name, x.outcome]), SUITE.map((c) => [c.name, "pass"]));
  assert.deepEqual(s.calls.map((c) => c.argv.join(" ")), suiteCommands());
  for (const c of s.calls) {
    assert.equal(c.opts.user, "factoryrun");
    assert.equal(c.opts.cwd, "/work/landing");
    assert.equal(c.opts.env.CI, "1");
  }
});

test("a step that fails then passes is flaky; one that fails twice keeps the first tail", async () => {
  const s = scripted({
    "two-tab": [exit({ code: 1, stdout: "first try broke" }), exit()],
    rust: [exit({ code: 101, stdout: "first rust failure" }), exit({ code: 101, stdout: "second rust failure" })],
  });
  const out = await verify(wt, env(), s.run);
  assert.equal(out.kind, "ran");
  if (out.kind !== "ran") return;
  const by = new Map(out.result.steps.map((x) => [x.name, x]));
  assert.equal(by.get("two-tab")?.outcome, "flaky");
  assert.equal(by.get("two-tab")?.tail, "");
  assert.equal(by.get("rust")?.outcome, "fail");
  assert.match(by.get("rust")?.tail ?? "", /first rust failure/);
  assert.equal(by.get("rust")?.seconds, 2);
  // Every step still ran after the failure.
  assert.equal(out.result.steps.length, SUITE.length);
});

test("install failing stops the run; the result lists only what ran", async () => {
  const s = scripted({ install: [exit({ code: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE" }), exit({ code: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE" })] });
  const out = await verify(wt, env(), s.run);
  assert.equal(out.kind, "ran");
  if (out.kind !== "ran") return;
  assert.deepEqual(out.result.steps.map((x) => [x.name, x.outcome]), [["install", "fail"]]);
  assert.match(out.result.steps[0]?.tail ?? "", /OUTDATED_LOCKFILE/);
});

test("a timeout is re-run and reported as timeout", async () => {
  const s = scripted({ "bench-smoke": [exit({ code: null, signal: "SIGTERM", timedOut: true }), exit({ code: null, signal: "SIGTERM", timedOut: true })] });
  const out = await verify(wt, env(), s.run);
  assert.equal(out.kind, "ran");
  if (out.kind !== "ran") return;
  assert.equal(out.result.steps.find((x) => x.name === "bench-smoke")?.outcome, "timeout");
});

test("an interrupted step (the laptop slept) makes the whole run infra", async () => {
  const s = scripted({ formal: [exit({ interrupted: true })] });
  const out = await verify(wt, env(), s.run);
  assert.equal(out.kind, "infra");
});

test("sudo refusing to start the step is infra, not a failure of the PR", async () => {
  const s = scripted({ install: [exit({ code: 1, stderr: "sudo: a password is required\n" })] });
  const out = await verify(wt, env(), s.run);
  assert.deepEqual(out.kind, "infra");
});

test("past the suite deadline, remaining steps are timeouts without running", async () => {
  const s = scripted({});
  const out = await verify(wt, env(Date.now() - 1), s.run);
  assert.equal(s.calls.length, 0);
  assert.equal(out.kind, "ran");
  if (out.kind !== "ran") return;
  assert.ok(out.result.steps.every((x) => x.outcome === "timeout"));
});

test("per-step deadline is the step timeout, capped by the suite deadline", async () => {
  const s = scripted({});
  const suiteDeadline = Date.now() + 60_000;
  await verify(wt, env(suiteDeadline), s.run);
  for (const c of s.calls) assert.ok(c.opts.deadline <= suiteDeadline);
});

test("suite env: run user's HOME and PATH, Chrome, shared caches, CI, and no credential", () => {
  const e = suiteEnv(env());
  assert.equal(e.HOME, "/Users/factoryrun");
  const path = (e.PATH ?? "").split(":");
  for (const p of ["/Users/factoryrun/.local/bin", "/Users/factoryrun/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) assert.ok(path.includes(p), p);
  assert.equal(e.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(e.npm_config_store_dir, "/Users/factoryrun/.factory/pnpm-store");
  assert.equal(e.CARGO_TARGET_DIR, "/Users/factoryrun/.factory/cargo-target");
  assert.equal(e.CI, "1");
  for (const k of Object.keys(e)) assert.doesNotMatch(k, /TOKEN|KEY|SECRET/);
});

test("tails: last 150 lines, ANSI stripped, stderr after stdout", () => {
  const stdout = Array.from({ length: 300 }, (_, i) => `\u001b[31mline ${i}\u001b[0m`).join("\n");
  const t = tailOf(exit({ stdout, stderr: "boom" }));
  const lines = t.split("\n");
  assert.equal(lines.length, 150);
  assert.equal(lines.at(-1), "boom");
  assert.equal(lines.at(-2), "[stderr]");
  assert.ok(!t.includes(String.fromCharCode(27)));
});

test("tails fit a total budget, trimming the largest first", () => {
  const big = Array.from({ length: 2000 }, (_, i) => `big ${i}`).join("\n");
  const steps: StepResult[] = [
    { name: "a", outcome: "fail", seconds: 1, tail: "small tail" },
    { name: "b", outcome: "fail", seconds: 1, tail: big },
    { name: "c", outcome: "pass", seconds: 1, tail: "" },
  ];
  const fitted = fitTails(steps, 1000);
  assert.ok(fitted.reduce((n, s) => n + s.tail.length, 0) <= 1000);
  assert.equal(fitted[0]?.tail, "small tail");
  assert.match(fitted[1]?.tail ?? "", /big 1999$/);
  assert.match(fitted[1]?.tail ?? "", /^big \d+/); // cut at a line boundary
  assert.deepEqual(fitTails(steps.slice(0, 1), 1000), steps.slice(0, 1));
});
