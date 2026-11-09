/**
 * sandbox.ts — the only way to execute agents and repo code. Everything runs as the `runUser`
 * (factoryrun), which holds model credentials and no GitHub credential, so PR code and agents can never
 * write to GitHub. The factory process itself never executes PR code.
 *
 * Credentials: `runAs` never reads `~<user>/.factory-env` and never puts a secret in argv (argv is
 * visible in `ps` to every user). A caller that needs the model credentials wraps its argv so the run
 * user's own shell sources the file (see `agents.ts`); verification steps don't get them at all.
 */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface Exit {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  seconds: number;
  timedOut: boolean;
  /** The wall clock jumped (laptop slept) while running; callers don't count this as an attempt. */
  interrupted: boolean;
}

export interface RunOpts {
  user: string;
  cwd: string;
  /** The complete environment. Nothing is inherited (`env -i`): no GH_TOKEN, no ANTHROPIC_API_KEY. */
  env: Readonly<Record<string, string>>;
  /** Wall-clock deadline (epoch ms). Checked every 10 s, so it fires after sleep, unlike setTimeout. */
  deadline: number;
  stdin?: string;
  /** Keep only the last N bytes of stdout and stderr. Default 256 KiB. */
  keepBytes?: number;
}

const POLL_MS = 10_000;
const KILL_AFTER_MS = 10_000;
const JUMP_MS = 60_000;
const DEFAULT_KEEP = 256 * 1024;
/** After the main process exits, how long to wait for grandchildren holding the pipes open. */
const DRAIN_MS = 5_000;

/** The one sudoers rule the factory needs. `doctor` prints it. */
export function sudoersLine(daemonUser: string, runUser: string): string {
  return `${daemonUser} ALL=(${runUser}) NOPASSWD: /usr/bin/env`;
}

/** argv for `sudo`: `-n -u <user> /usr/bin/env -i K=V... <argv>`. Exported for tests. */
export function sudoArgv(argv: readonly string[], user: string, env: Readonly<Record<string, string>>): string[] {
  for (const k of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`runAs: bad env name ${JSON.stringify(k)}`);
  if (argv.length === 0) throw new Error("runAs: empty argv");
  const full = withGitDefaults(env);
  // umask 007: files the run user creates in a shared worktree stay readable and removable by the daemon.
  return ["-n", "-u", user, "/usr/bin/env", "-i", ...Object.entries(full).map(([k, v]) => `${k}=${v}`), "/bin/sh", "-c", 'umask 007 && exec "$@"', "sh", ...argv];
}

/**
 * Worktrees are owned by the daemon's user, so git run by the run user would refuse them as
 * "dubious ownership". `safe.directory=*` is added through GIT_CONFIG_* unless the caller set its own.
 */
function withGitDefaults(env: Readonly<Record<string, string>>): Record<string, string> {
  if ("GIT_CONFIG_COUNT" in env) return { ...env };
  return { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };
}

/** A bounded tail buffer: keeps at most `keep` trailing bytes. */
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  private readonly keep: number;
  constructor(keep: number) {
    this.keep = keep;
  }
  push(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    if (this.size > 2 * this.keep) this.compact();
  }
  private compact(): void {
    const all = Buffer.concat(this.chunks);
    const kept = all.subarray(Math.max(0, all.length - this.keep));
    this.chunks = [kept];
    this.size = kept.length;
  }
  text(): string {
    this.compact();
    return this.chunks[0]?.toString("utf8") ?? "";
  }
}

/**
 * Signal the job's process group. Two routes, because the group mixes users: `sudo` itself (root) and
 * the command (run user). The daemon signals what it may directly; a second `sudo -u <user> kill` reaches
 * the run user's processes. A grandchild that started its own process group is not reached; the
 * Chrome harnesses close their browsers on SIGTERM.
 */
function signalGroup(pgid: number, sig: "SIGTERM" | "SIGKILL", user: string): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // EPERM or ESRCH: fall through to the run user's route.
  }
  try {
    const k = spawn("sudo", sudoArgv(["/bin/kill", `-${sig.slice(3)}`, "--", `-${pgid}`], user, {}), { stdio: "ignore" });
    k.on("error", () => {});
  } catch {
    // nothing else to try
  }
}

/**
 * `sudo -n -u <user> /usr/bin/env -i <env> <argv>`, detached into its own process group.
 * Polls every 10 s: past `deadline` -> SIGTERM the group, SIGKILL 10 s later, `timedOut`.
 * Between polls, a wall-clock delta that exceeds the monotonic delta by more than 60 s means the
 * machine slept: `interrupted`. Never rejects; a spawn failure is an Exit with `code: null` (see
 * `launchFailed`).
 */
export function runAs(argv: readonly string[], opts: RunOpts): Promise<Exit> {
  const keep = opts.keepBytes ?? DEFAULT_KEEP;
  const out = new Tail(keep);
  const err = new Tail(keep);
  const t0 = performance.now();
  let lastWall = Date.now();
  let lastMono = t0;
  let timedOut = false;
  let interrupted = false;
  let killTimer: NodeJS.Timeout | null = null;

  return new Promise<Exit>((resolve) => {
    let settled = false;
    let poll: NodeJS.Timeout | null = null;
    let drain: NodeJS.Timeout | null = null;
    const finish = (code: number | null, signal: string | null, extraErr = ""): void => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (killTimer) clearTimeout(killTimer);
      if (drain) clearTimeout(drain);
      checkClock();
      resolve({
        code,
        signal,
        stdout: out.text(),
        stderr: err.text() + extraErr,
        seconds: Math.round((performance.now() - t0) / 100) / 10,
        timedOut,
        interrupted,
      });
    };
    const checkClock = (): void => {
      const wall = Date.now();
      const mono = performance.now();
      if (wall - lastWall - (mono - lastMono) > JUMP_MS) interrupted = true;
      lastWall = wall;
      lastMono = mono;
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("sudo", sudoArgv(argv, opts.user, opts.env), {
        cwd: opts.cwd,
        detached: true,
        stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (e) {
      finish(null, null, `spawn failed: ${(e as Error).message}`);
      return;
    }
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => finish(null, null, `spawn failed: ${e.message}`));
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // A grandchild may keep the pipes open; don't wait for it forever.
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode, exitSignal);
      }, DRAIN_MS);
    });
    child.on("close", (code, signal) => finish(code ?? exitCode, signal ?? exitSignal));
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // EPIPE when the command doesn't read stdin
      child.stdin.end(opts.stdin);
    }

    const pgid = child.pid;
    poll = setInterval(() => {
      checkClock();
      if (timedOut || pgid === undefined || Date.now() <= opts.deadline) return;
      timedOut = true;
      signalGroup(pgid, "SIGTERM", opts.user);
      killTimer = setTimeout(() => signalGroup(pgid, "SIGKILL", opts.user), KILL_AFTER_MS);
    }, POLL_MS);
  });
}

/**
 * Why the command never started, or null if it did: sudo refused (no sudoers rule, password needed),
 * the binary or the cwd is missing. That is the host's problem, never the PR's.
 */
export function launchFailed(exit: Exit): string | null {
  if (exit.code === null && exit.signal === null && !exit.timedOut && /^spawn failed:/m.test(exit.stderr)) return exit.stderr.trim();
  if (exit.code === 1 && /^sudo: (?:a password is required|.*is not allowed to execute|unable to change directory|.*: command not found)/m.test(exit.stderr)) {
    return exit.stderr.trim().split("\n")[0] ?? "sudo failed";
  }
  if (exit.code === 127 && /^env: .*No such file or directory/m.test(exit.stderr)) return exit.stderr.trim().split("\n")[0] ?? "not found";
  return null;
}
