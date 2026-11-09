/**
 * verify.ts — the local check suite. This list IS the gate's definition of "green": no GitHub Actions,
 * no diff-based selection. It lives in factory/ (a gate path), so a PR can't drop a step.
 * `verify.test.ts` fails if any command here is missing verbatim from docs/verification.md.
 */
import type { StepOutcome, StepResult, VerifyResult } from "./decide.ts";
import type { Worktree } from "./workspace.ts";
import { launchFailed, runAs, type Exit, type RunOpts } from "./sandbox.ts";

export interface Check {
  name: string;
  argv: readonly string[];
  timeoutMin: number;
  /** Needs CHROME_PATH set to the system Chrome. */
  chrome?: true;
}

/**
 * Union of m1-smoke.yml on main and on the PR branches (bench, gate, rust, two-tab, test, static, formal),
 * ordered cheap-first, with docs/verification.md's "formal, then Chrome drives and benches, then pnpm test".
 * Every step runs even after a failure (one fix attempt should see every failure), except `install`.
 */
export const SUITE: readonly Check[] = [
  { name: "install", argv: ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], timeoutMin: 5 },
  { name: "static", argv: ["pnpm", "static"], timeoutMin: 5 },
  { name: "rust", argv: ["cargo", "test", "-p", "engine-core"], timeoutMin: 10 },
  { name: "formal", argv: ["pnpm", "--filter", "@opfs-lsm/kv", "formal:kv"], timeoutMin: 10 },
  { name: "two-tab", argv: ["pnpm", "--filter", "@opfs-lsm/kv", "two-tab"], timeoutMin: 5, chrome: true },
  { name: "bench-size", argv: ["pnpm", "bench:size", "--check"], timeoutMin: 10 },
  { name: "bench-smoke", argv: ["pnpm", "bench:smoke"], timeoutMin: 15, chrome: true },
  { name: "test", argv: ["pnpm", "test"], timeoutMin: 10 },
];

export interface VerifyEnv {
  user: string; // factoryrun
  chromePath: string; // /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  /** Shared caches, owned by the run user: the pnpm content-addressed store and the cargo target dir. */
  pnpmStore: string;
  cargoTarget: string;
  /** Whole-suite deadline (epoch ms); per-step deadlines are min(step timeout, this). */
  deadline: number;
}

/** "infra" means the suite could not run at all (sudo failed, disk full, laptop slept): not the PR's fault. */
export type VerifyOut = { kind: "ran"; result: VerifyResult } | { kind: "infra"; detail: string };

/** Injectable for tests; production uses `runAs`. */
type StepRunner = (argv: readonly string[], opts: RunOpts) => Promise<Exit>;

const TAIL_LINES = 150;
const TAIL_BUDGET = 64 * 1024;

/** The complete environment of every step. No credential of any kind. */
export function suiteEnv(env: VerifyEnv): Record<string, string> {
  const home = `/Users/${env.user}`;
  return {
    HOME: home,
    USER: env.user,
    LOGNAME: env.user,
    LANG: "en_US.UTF-8",
    PATH: [`${home}/.local/bin`, `${home}/.cargo/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    CHROME_PATH: env.chromePath,
    npm_config_store_dir: env.pnpmStore,
    CARGO_TARGET_DIR: env.cargoTarget,
    CI: "1",
  };
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** CSI sequences (colors, cursor), OSC sequences (titles, links), and two-byte escapes. */
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`, "g");

/** Last `TAIL_LINES` lines of a failed step's output, ANSI stripped. stderr follows stdout. */
export function tailOf(exit: Exit, note = ""): string {
  const strip = (s: string): string => s.replace(ANSI, "").replace(/\r(?!\n)/g, "\n").trimEnd();
  const parts = [strip(exit.stdout)];
  const e = strip(exit.stderr);
  if (e) parts.push(`[stderr]\n${e}`);
  if (note) parts.push(note);
  const lines = parts.filter((p) => p.length > 0).join("\n").split("\n");
  return lines.slice(-TAIL_LINES).join("\n");
}

/**
 * Fit the tails into `budget` characters in total. The largest tails are trimmed first (to their last
 * lines), so a short tail is never sacrificed for a long one.
 */
export function fitTails(steps: readonly StepResult[], budget = TAIL_BUDGET): StepResult[] {
  const total = steps.reduce((n, s) => n + s.tail.length, 0);
  if (total <= budget) return [...steps];
  // Water-fill: the largest cap c with sum(min(len, c)) <= budget.
  const lens = steps.map((s) => s.tail.length).sort((a, b) => a - b);
  let left = budget;
  let cap = 0;
  for (let i = 0; i < lens.length; i++) {
    const share = Math.floor(left / (lens.length - i));
    const len = lens[i] ?? 0;
    if (len <= share) left -= len;
    else {
      cap = share;
      break;
    }
  }
  return steps.map((s) => {
    if (s.tail.length <= cap) return s;
    const cut = s.tail.slice(s.tail.length - cap);
    const nl = cut.indexOf("\n");
    return { ...s, tail: nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut };
  });
}

type Attempt = { kind: "ran"; outcome: StepOutcome; seconds: number; tail: string } | { kind: "infra"; detail: string };

async function attempt(check: Check, cwd: string, env: VerifyEnv, vars: Record<string, string>, run: StepRunner): Promise<Attempt> {
  const deadline = Math.min(Date.now() + check.timeoutMin * 60_000, env.deadline);
  const exit = await run(check.argv, { user: env.user, cwd, env: vars, deadline });
  if (exit.interrupted) return { kind: "infra", detail: `${check.name}: the host slept during the step` };
  const launch = launchFailed(exit);
  if (launch) return { kind: "infra", detail: `${check.name}: could not start: ${launch}` };
  if (exit.timedOut) return { kind: "ran", outcome: "timeout", seconds: exit.seconds, tail: tailOf(exit, `[factory] timed out after ${exit.seconds}s`) };
  if (exit.code === 0) return { kind: "ran", outcome: "pass", seconds: exit.seconds, tail: "" };
  return { kind: "ran", outcome: "fail", seconds: exit.seconds, tail: tailOf(exit, `[factory] exit ${exit.code ?? exit.signal}`) };
}

/**
 * Run SUITE in a full, writable worktree of the landing tree, as the run user.
 *  - each step: fail|timeout -> run once more; second pass -> "flaky", second fail -> first outcome and tail
 *  - `install` failing stops the run: the result lists only what ran
 *  - the suite deadline passing marks the remaining steps `timeout` without running them
 *  - an interrupted step (the laptop slept) or a step that could not start -> infra
 */
export async function verify(wt: Worktree, env: VerifyEnv, run: StepRunner = runAs): Promise<VerifyOut> {
  const vars = suiteEnv(env);
  const steps: StepResult[] = [];
  for (const check of SUITE) {
    if (Date.now() >= env.deadline) {
      steps.push({ name: check.name, outcome: "timeout", seconds: 0, tail: "[factory] the suite deadline passed before this step started" });
      continue;
    }
    const first = await attempt(check, wt.path, env, vars, run);
    if (first.kind === "infra") return first;
    let step: StepResult = { name: check.name, outcome: first.outcome, seconds: first.seconds, tail: first.tail };
    if (first.outcome !== "pass" && Date.now() < env.deadline) {
      const again = await attempt(check, wt.path, env, vars, run);
      if (again.kind === "infra") return again;
      const seconds = Math.round((first.seconds + again.seconds) * 10) / 10;
      step = again.outcome === "pass" ? { name: check.name, outcome: "flaky", seconds, tail: "" } : { ...step, seconds };
    }
    steps.push(step);
    if (check.name === "install" && (step.outcome === "fail" || step.outcome === "timeout")) break;
  }
  return { kind: "ran", result: { steps: fitTails(steps) } };
}

/** For the fixer's allowlist: it may re-run exactly these commands in its own worktree. */
export function suiteCommands(): string[] {
  return SUITE.map((c) => c.argv.join(" "));
}
