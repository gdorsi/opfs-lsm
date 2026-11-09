/**
 * main.ts — the factory, start to finish. Read this, then decide.ts (every decision) and github.ts
 * (every effect). Nothing else holds flow.
 *
 *   node factory/main.ts run                   the daemon (launchd: caffeinate -s node factory/main.ts run)
 *   node factory/main.ts plan [--pr N]         dry run: steps and merge decisions from a live snapshot; writes nothing
 *   node factory/main.ts doctor [--suite]      checks the setup; exits non-zero with a list of problems
 *   --config <file>                            default ~/.factory/config.json (or $FACTORY_CONFIG)
 *
 * No state on disk except a lock file. Kill it, wipe the laptop, run it from another machine: the next tick is correct.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { plan, mergeDecision, mergeInputOf, render, type Job, type World } from "./decide.ts";
import { connect, checkApp, type Output, type Work } from "./github.ts";
import { loadPolicy, PATHS, hiddenFromAgents, type Policy } from "./policy.ts";
import { openMirror, gitVersion, isSharedRoot, type Mirror } from "./workspace.ts";
import * as agents from "./agents.ts";
import { verify, suiteCommands } from "./verify.ts";
import { runAs, sudoersLine } from "./sandbox.ts";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const remoteUrl = (p: Policy) => `https://github.com/${p.repo.owner}/${p.repo.name}.git`;

// ───────────────────────────── the daemon ─────────────────────────────

async function run(policy: Policy): Promise<void> {
  const release = takeLock(join(homedir(), ".factory", "lock"));
  const remote = await connect(policy);
  const mirror = openMirror(policy.mirrorDir, policy.worktreeRoot, policy.runUser, remoteUrl(policy));
  const work = workFor(policy, mirror, agents.readRubric());
  const inflight = new Set<Promise<void>>();

  let stopping = false;
  let wake: () => void = () => {};
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: no new ticks; waiting for ${inflight.size} job(s)`);
    wake();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  while (!stopping) {
    try {
      const world = await remote.snapshot();
      const { steps, start } = plan(world, policy.rules);
      for (const { pr, step } of steps) {
        try {
          await remote.act(pr, step);
        } catch (e) {
          log(`#${pr.number}: act failed: ${String(e)}`);
        }
      }
      for (const job of stopping ? [] : start) {
        const { done } = await remote.start(job, work);
        inflight.add(done);
        void done.finally(() => inflight.delete(done));
      }
    } catch (e) {
      log(`tick failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
    if (stopping) break;
    await new Promise<void>((r) => {
      const t = setTimeout(r, policy.pollSeconds * 1000);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });
  }
  await Promise.allSettled([...inflight]);
  release();
  log("stopped");
}

/**
 * The work behind each job kind. Agents and checks run as the run user via sandbox.runAs (inside
 * agents.ts / verify.ts). Recording and pushing happen in github.ts `start`, never here.
 */
function workFor(policy: Policy, mirror: Mirror, rubric: string): Work {
  const deadline = (job: Job) => Date.now() + policy.rules.timeoutMs[job.kind];
  return async <J extends Job>(job: J): Promise<Output<J>> => {
    switch (job.kind) {
      case "review": {
        const wt = await mirror.checkout(job.head, "agent", false);
        try {
          return (await agents.review(
            { wt, head: job.head, mergeBase: job.mergeBase, title: job.title, body: job.body, prior: job.prior, rubric, deadline: deadline(job) },
            policy.reviewers,
            policy.runUser,
          )) as Output<J>;
        } finally {
          await wt.dispose();
        }
      }
      case "verify": {
        const wt = await mirror.checkout(job.tree, "full", true);
        try {
          return (await verify(wt, { user: policy.runUser, chromePath: policy.chromePath, pnpmStore: policy.pnpmStore, cargoTarget: policy.cargoTarget, deadline: deadline(job) })) as Output<J>;
        } finally {
          await wt.dispose();
        }
      }
      case "fix": {
        const wt = await mirror.checkout(job.head, "agent", true);
        try {
          const out = await agents.fix(
            {
              wt,
              findings: job.findings,
              failures: job.failures,
              mayRun: suiteCommands(),
              mayNotTouch: PATHS.filter((p) => p.fixer === "deny").map((p) => p.glob),
              allowedPaths: job.allowedPaths,
              maxLines: policy.maxFixLines,
              title: job.title,
              body: job.body,
              deadline: deadline(job),
            },
            policy.fixer,
            policy.runUser,
          );
          // The tree is the fixer's real output; github.ts validates it and builds the commit.
          return { ...out, tree: out.ok ? await wt.capture() : null } as Output<J>;
        } finally {
          await wt.dispose();
        }
      }
    }
  };
}

/** One daemon per user: O_EXCL lock file holding the pid; a dead pid's lock is taken over. */
function takeLock(file: string): () => void {
  mkdirSync(join(file, ".."), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(file, "utf8").trim());
      if (pid > 0 && isAlive(pid)) throw new Error(`another factory is running (pid ${pid}, lock ${file})`);
      unlinkSync(file);
    }
  }
  throw new Error(`could not take the lock ${file}`);
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ───────────────────────────── plan (dry run) ─────────────────────────────

/** Dry run. Same snapshot and plan as the daemon; prints instead of acting. */
async function dryRun(policy: Policy, only: number | null): Promise<void> {
  const remote = await connect(policy, { readOnly: true });
  const world: World = await remote.snapshot();
  const p = plan(world, policy.rules);
  const t = world.trunk;
  console.log(`${t.name} ${t.head.slice(0, 7)} tree ${t.tree.slice(0, 7)}  verify: ${t.verify.latest ? t.verify.latest.state : "none"}${world.paused ? "  PAUSED" : ""}`);
  console.log(`usage (24 h): review ${world.usage.review}/${policy.rules.runsPerDay.review}, verify ${world.usage.verify}/${policy.rules.runsPerDay.verify}, fix ${world.usage.fix}/${policy.rules.runsPerDay.fix}`);
  for (const { pr, step } of p.steps) {
    if (only !== null && pr.number !== only) continue;
    const r = render(step.status, pr);
    const act = step.act ? `  act: ${step.act.kind === "merge" ? "merge" : `retarget -> ${step.act.to}`}` : "";
    console.log(`\n#${pr.number} ${pr.branch} @ ${pr.head.slice(0, 7)}: ${r.title}${act}`);
    if (step.want.length > 0) console.log(`  wants: ${step.want.map((j) => j.kind).join(", ")}`);
  }
  console.log(`\nwould start: ${p.start.length === 0 ? "nothing" : p.start.map((j) => `${j.kind} ${"pr" in j ? `#${j.pr}` : "trunk" in j.on ? t.name : `#${j.on.pr}`}`).join(", ")}`);

  if (only !== null) {
    const pr = world.prs.find((x) => x.number === only);
    if (!pr) {
      console.log(`\n#${only}: not tracked (closed, someone else's, from a fork, or its head is already in ${t.name})`);
      return;
    }
    const d = mergeDecision(mergeInputOf(pr, t, policy.rules), pr.number);
    console.log(`\n#${only} merge decision: ${d.ok ? `OK -> lands ${pr.head.slice(0, 7)} as tree ${d.ticket.tree.slice(0, 7)} on ${d.ticket.trunk.slice(0, 7)}` : "not yet"}`);
    if (!d.ok) for (const u of d.unmet) console.log(`  ✗ ${u.why}${detail(u)}`);
  }
}

function detail(u: object): string {
  const rest = Object.entries(u).filter(([k]) => k !== "why");
  return rest.length === 0 ? "" : `  ${JSON.stringify(Object.fromEntries(rest)).slice(0, 400)}`;
}

// ───────────────────────────── doctor ─────────────────────────────

const WANT_PERMISSIONS: Readonly<Record<string, string>> = { contents: "write", pull_requests: "write", checks: "write", issues: "read", metadata: "read" };

/** Every check prints one line; any failure makes the exit code 1. `--suite` also times one full verify of trunk. */
async function doctor(configFile: string, suite: boolean): Promise<boolean> {
  let ok = true;
  const line = (pass: boolean, what: string, why = "") => {
    if (!pass) ok = false;
    console.log(`${pass ? "ok  " : "FAIL"} ${what}${why ? `: ${why}` : ""}`);
  };
  const guard = async (what: string, f: () => Promise<string | true>) => {
    try {
      const r = await f();
      line(r === true, what, r === true ? "" : r);
    } catch (e) {
      line(false, what, e instanceof Error ? e.message : String(e));
    }
  };

  let policy: Policy;
  try {
    policy = loadPolicy(configFile);
    line(true, `config ${configFile} (reviewers are not the fixer's family)`);
  } catch (e) {
    line(false, "config", e instanceof Error ? e.message : String(e));
    return false;
  }
  const runUser = policy.runUser;
  const home = `/Users/${runUser}`;
  const asRun = (argv: string[], seconds = 30) => runAs(argv, { user: runUser, cwd: "/", env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", HOME: home }, deadline: Date.now() + seconds * 1000 });

  await guard("GitHub App token mints; installation permissions are exactly contents/pull_requests/checks write, issues/metadata read", async () => {
    const { permissions, botUserId } = await checkApp(policy);
    const extra = Object.keys(permissions).filter((k) => !(k in WANT_PERMISSIONS));
    const wrong = Object.entries(WANT_PERMISSIONS).filter(([k, v]) => permissions[k] !== v);
    const problems = [...extra.map((k) => `unexpected ${k}:${permissions[k]}`), ...wrong.map(([k, v]) => `${k} is ${permissions[k] ?? "missing"}, want ${v}`)];
    const email = botUserId ? `${botUserId}+${policy.app.botLogin}@users.noreply.github.com` : null;
    if (email && email !== policy.app.botEmail) problems.push(`app.botEmail should be ${email} so commits link to the bot`);
    return problems.length === 0 ? true : problems.join("; ");
  });
  await guard("git >= 2.38 (merge-tree --write-tree)", async () => {
    const v = await gitVersion();
    const [maj = 0, min = 0] = v.split(".").map(Number);
    return maj > 2 || (maj === 2 && min >= 38) ? true : `git ${v}`;
  });
  await guard(`sudo -n -u ${runUser} works`, async () => {
    const e = await asRun(["/usr/bin/true"]);
    return e.code === 0 ? true : `add to sudoers: ${sudoersLine(userInfo().username, runUser)}  (${e.stderr.trim().slice(0, 200)})`;
  });
  await guard(`${runUser} has the fixer and reviewer CLIs`, async () => {
    const clis = [...new Set<string>([policy.fixer.cli, ...policy.reviewers.map((r) => r.cli)])];
    const missing: string[] = [];
    for (const c of clis) if ((await asRun(["/bin/sh", "-c", `command -v ${c}`])).code !== 0) missing.push(c);
    return missing.length === 0 ? true : `not on PATH for ${runUser}: ${missing.join(", ")}`;
  });
  await guard(`${home}/.factory-env has the fixer's OAuth token and no API key`, async () => {
    const script = 'f="$HOME/.factory-env"; [ -f "$f" ] || { echo missing; exit 1; }; grep -q "^CLAUDE_CODE_OAUTH_TOKEN=." "$f" || { echo "no OAuth token"; exit 1; }; if grep -q "^ANTHROPIC_API_KEY=" "$f"; then echo "has an API key"; exit 1; fi';
    const e = await asRun(["/bin/sh", "-c", script]);
    return e.code === 0 ? true : e.stdout.trim() || e.stderr.trim();
  });
  await guard(`${runUser} has no GitHub credential`, async () => {
    const script = [
      'f="$HOME/.factory-env"; [ -f "$f" ] && grep -Eq "^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)=" "$f" && echo "token in .factory-env"',
      '[ -e "$HOME/.config/gh/hosts.yml" ] && echo "gh is logged in"',
      '[ -e "$HOME/.git-credentials" ] && echo "~/.git-credentials exists"',
      'h=$(git config --global --get credential.helper 2>/dev/null); [ -n "$h" ] && echo "git credential helper: $h"',
      "true",
    ].join("; ");
    const e = await asRun(["/bin/sh", "-c", script]);
    return e.stdout.trim() === "" ? true : e.stdout.trim().split("\n").join("; ");
  });
  await guard(`Chrome at ${policy.chromePath} runs for ${runUser}`, async () => ((await asRun(["/bin/test", "-x", policy.chromePath])).code === 0 ? true : "not executable"));
  await guard(`pnpm store and cargo target writable by ${runUser}`, async () => {
    const bad: string[] = [];
    for (const d of [policy.pnpmStore, policy.cargoTarget]) {
      if ((await asRun(["/bin/sh", "-c", `mkdir -p "$1" && test -w "$1"`, "sh", d])).code !== 0) bad.push(d);
    }
    return bad.length === 0 ? true : bad.join(", ");
  });
  await guard(`worktree root ${policy.worktreeRoot} is group-shared (rwx)`, async () => (!existsSync(policy.worktreeRoot) || (await isSharedRoot(policy.worktreeRoot)) ? true : "chgrp it to a group with the run user and chmod 2770"));

  // Live checks against the repository: read-only snapshot, then local checkouts of trunk.
  let world: World | null = null;
  await guard("snapshot (git fetch + GraphQL), read-only", async () => {
    world = await (await connect(policy, { readOnly: true })).snapshot();
    return true;
  });
  const w = world as World | null;
  if (w) {
    const mirror = openMirror(policy.mirrorDir, policy.worktreeRoot, policy.runUser, remoteUrl(policy));
    await guard("agent checkouts hide " + hiddenFromAgents().join(", "), async () => {
      const wt = await mirror.checkout(w.trunk.head, "agent", false);
      try {
        const present = hiddenFromAgents().map((g) => g.replace(/\/\*\*$/, "")).filter((p) => !p.includes("*") && existsSync(join(wt.path, p)));
        return present.length === 0 ? true : `present: ${present.join(", ")}`;
      } finally {
        await wt.dispose();
      }
    });
    if (suite) {
      await guard(`full suite on ${w.trunk.name} ${w.trunk.head.slice(0, 7)}`, async () => {
        const wt = await mirror.checkout(w.trunk.tree, "full", true);
        try {
          const out = await verify(wt, { user: runUser, chromePath: policy.chromePath, pnpmStore: policy.pnpmStore, cargoTarget: policy.cargoTarget, deadline: Date.now() + policy.rules.timeoutMs.verify });
          if (out.kind === "infra") return `infra: ${out.detail}`;
          for (const s of out.result.steps) console.log(`       ${s.name.padEnd(14)} ${s.outcome.padEnd(8)} ${s.seconds.toFixed(1)} s`);
          const bad = out.result.steps.filter((s) => s.outcome === "fail" || s.outcome === "timeout");
          return bad.length === 0 ? true : `${bad.map((s) => s.name).join(", ")} failed`;
        } finally {
          await wt.dispose();
        }
      });
    }
  }
  return ok;
}

// ───────────────────────────── argv ─────────────────────────────

async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (f: string) => rest.includes(f);
  const value = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const configFile = value("--config") ?? process.env.FACTORY_CONFIG ?? "~/.factory/config.json";
  switch (cmd) {
    case "run":
      await run(loadPolicy(configFile));
      return 0;
    case "plan": {
      const n = value("--pr");
      if (n !== undefined && !/^\d+$/.test(n)) throw new Error("--pr takes a PR number");
      await dryRun(loadPolicy(configFile), n === undefined ? null : Number(n));
      return 0;
    }
    case "doctor":
      return (await doctor(configFile, flag("--suite"))) ? 0 : 1;
    default:
      console.error("usage: node factory/main.ts run | plan [--pr N] | doctor [--suite]   [--config file]");
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
