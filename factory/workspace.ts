/**
 * workspace.ts — the local git mirror and job worktrees. Holds no credential: `fetch` and `push` take an
 * `Auth` that only github.ts can produce. Git objects are content-addressed, so the mirror is a cache
 * that can't be wrong; deleting ~factory/.factory/mirror.git loses nothing.
 *
 * Every git runs as the daemon's user with a scrubbed environment (no global or system config, no
 * credential helper, no prompts), hooks off (`core.hooksPath=/dev/null`) and signing off.
 * The token reaches git through GIT_CONFIG_* environment variables for that one process, never argv
 * and never a config file.
 *
 * Sharing with the run user: worktrees live under `worktreeRoot`, a directory owned by the daemon's user
 * with a group shared with the run user (mode 2770). After checkout the tree is chmod'ed group-readable
 * (and group-writable when `writable`), including the worktree's admin dir inside the mirror so the run
 * user's `git status`/`git diff` work. The mirror is created with `core.sharedRepository=group`.
 * The run user must create files with umask 007 (sandbox.ts) so `capture` can read them and `dispose`
 * can delete them. No sudo here: only sandbox.ts runs anything as another user.
 */
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Sha, Landing } from "./decide.ts";
import type { CleanText } from "./policy.ts";
import { hiddenFromAgents } from "./policy.ts";

declare const authBrand: unique symbol;
/** An installation-token header (`AUTHORIZATION: basic …`). Minted only inside github.ts. */
export type Auth = { readonly header: string; readonly [authBrand]: true };

export interface Identity {
  name: string;
  email: string;
}

/** One file in a diff. `added`/`removed` are null for binary files. */
export interface FileChange {
  path: string;
  status: "A" | "M" | "D" | "T" | "U" | "X";
  modeChanged: boolean;
  added: number | null;
  removed: number | null;
}

/** What changed between two commits: the input to every attribution and path check. */
export interface Delta {
  commits: readonly { sha: Sha; author: string; committer: string; message: string }[];
  paths: readonly string[] | "too-many"; // capped at MAX_PATHS
  /** Per-file status and line counts; empty when `paths` is "too-many". */
  files: readonly FileChange[];
  added: readonly { path: string; text: string }[]; // added lines, joined per path
}

/** Everything the snapshot needs from git for one PR, computed locally after a fetch. */
export interface GitFacts {
  mergeBase: Sha; // merge-base(base ref, head)
  landing: Landing; // git merge-tree --write-tree <trunk head> <head>
  delta: Delta; // mergeBase..head
  streak: number; // first-parent commits from head whose committer email is the factory's, until the first that isn't
  parent: Sha | null; // head^ when head is a factory commit, for the prior review
  headAt: number; // committer timestamp of head, epoch ms
}

export interface Worktree {
  readonly path: string;
  /**
   * After an agent edited the worktree: a fresh index from the starting commit, `git add -A` of everything
   * except the hidden paths, `git write-tree`. Commits the agent made (with their messages and trailers)
   * never matter; hidden paths keep the starting commit's content.
   */
  capture(): Promise<Sha>;
  dispose(): Promise<void>;
}

export interface Mirror {
  fetch(auth: Auth): Promise<void>; // +refs/heads/*:refs/remotes/origin/*, prune
  facts(trunkHead: Sha, baseRef: string, head: Sha, factory: Identity): Promise<GitFacts>;
  /**
   * A worktree the run user can use (shared group, setgid dir).
   * "agent": sparse checkout without `hiddenFromAgents()` paths. "full": everything (for the suite).
   * `target` may be a tree (landing trees): a throwaway local commit is made to check it out; it is never pushed.
   */
  checkout(target: Sha, view: "agent" | "full", writable: boolean): Promise<Worktree>;
  /** git commit-tree. Message and identity are the factory's; only github.ts calls it. */
  commit(tree: Sha, parents: readonly Sha[], message: CleanText, who: Identity): Promise<Sha>;
  /**
   * The only branch write: `git push --force-with-lease=<ref>:<expect> origin <sha>:<ref>`.
   * "moved" when the remote ref is no longer `expect` (owner pushed, main moved).
   */
  push(auth: Auth, ref: string, expect: Sha, sha: Sha): Promise<"ok" | "moved">;
  /** from..to, for pre-push validation in github.ts (same shape the snapshot scans). */
  inspect(from: Sha, to: Sha): Promise<Delta>;
  /** The tree of a commit (or the tree itself). */
  treeOf(rev: Sha): Promise<Sha>;
  /** Is this commit in the mirror? (GitHub can be a moment ahead of the last fetch.) */
  has(commit: Sha): Promise<boolean>;
  /** Is `a` reachable from `b`? */
  isAncestor(a: Sha, b: Sha): Promise<boolean>;
}

const MAX_PATHS = 3000;
const MAX_ADDED_BYTES = 16 * 1024 * 1024;

// ───────────────────────────── the one git helper ─────────────────────────────

interface GitOpts {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  /** Exit codes that are not errors. Default [0]. */
  ok?: readonly number[];
}
interface GitOut {
  code: number;
  stdout: string;
  stderr: string;
}

const GIT_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "credential.helper=", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false"];

function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: process.env.HOME ?? "/",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    ...extra,
  };
}

function git(args: readonly string[], opts: GitOpts = {}): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...GIT_FLAGS, ...args], { cwd: opts.cwd, env: scrubbedEnv(opts.env), stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      const res = { code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
      if ((opts.ok ?? [0]).includes(res.code)) resolve(res);
      else reject(new Error(`git ${args.filter((a) => !a.startsWith("AUTHORIZATION")).join(" ")} -> ${res.code}: ${res.stderr.trim().slice(0, 2000)}`));
    });
    child.stdin.end(opts.input ?? "");
  });
}

/** `git --version` as the daemon runs it, e.g. "2.55.0". For `doctor`. */
export async function gitVersion(): Promise<string> {
  const { stdout } = await git(["--version"]);
  return stdout.trim().replace(/^git version\s+/, "");
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
function asSha(s: string): Sha {
  const t = s.trim();
  if (!SHA_RE.test(t)) throw new Error(`not an object id: ${JSON.stringify(t.slice(0, 80))}`);
  return t as Sha;
}

function authEnv(auth: Auth): Record<string, string> {
  // Scoped to github.com; lives only in this child's environment.
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: auth.header };
}

// ───────────────────────────── diff parsing (pure; exported for tests) ─────────────────────────────

/** `git diff --raw -z --no-renames` output. */
export function parseRaw(out: string): { path: string; status: FileChange["status"]; modeChanged: boolean }[] {
  const parts = out.split("\0");
  const res: { path: string; status: FileChange["status"]; modeChanged: boolean }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    if (!meta.startsWith(":")) break;
    const [oldMode, newMode, , , status] = meta.slice(1).split(" ");
    const s = (status ?? "X").charAt(0);
    res.push({
      path: parts[i + 1]!,
      status: (["A", "M", "D", "T", "U"].includes(s) ? s : "X") as FileChange["status"],
      modeChanged: oldMode !== "000000" && newMode !== "000000" && oldMode !== newMode,
    });
  }
  return res;
}

/** `git diff --numstat -z --no-renames` output. */
function parseNumstat(out: string): Map<string, { added: number | null; removed: number | null }> {
  const m = new Map<string, { added: number | null; removed: number | null }>();
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const [a, r, ...p] = rec.split("\t");
    const path = p.join("\t");
    m.set(path, { added: a === "-" ? null : Number(a), removed: r === "-" ? null : Number(r) });
  }
  return m;
}

/** Added lines per path from `git diff --unified=0`. */
export function parseAddedLines(diff: string): { path: string; text: string }[] {
  const byPath = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) current = null;
    else if (line.startsWith("+++ ")) {
      let p = line.slice(4);
      if (p === "/dev/null") {
        current = null;
        continue;
      }
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (p.startsWith("b/")) p = p.slice(2);
      current = byPath.get(p) ?? [];
      byPath.set(p, current);
    } else if (current && line.startsWith("+")) current.push(line.slice(1));
  }
  return [...byPath].filter(([, ls]) => ls.length > 0).map(([path, ls]) => ({ path, text: ls.join("\n") }));
}

/** `git merge-tree --write-tree --name-only --no-messages -z`: exit 0 clean, 1 conflict. */
export function parseMergeTree(code: number, out: string): Landing {
  const parts = out.split("\0").filter((p) => p.length > 0);
  const tree = asSha(parts[0] ?? "");
  if (code === 0) return { kind: "clean", tree };
  return { kind: "conflict", paths: [...new Set(parts.slice(1))] };
}

/** Pathspecs that exclude the hidden paths, from the PATHS globs. */
export function hiddenPathspecs(globs: readonly string[] = hiddenFromAgents()): string[] {
  return globs.map((g) => `:(exclude,glob)${g}`);
}

/** Non-cone sparse-checkout patterns that hide the hidden paths. */
export function sparsePatterns(globs: readonly string[] = hiddenFromAgents()): string[] {
  const out = ["/*"];
  for (const g of globs) {
    if (g.endsWith("/**")) out.push(`!/${g.slice(0, -3)}/`);
    else if (g.startsWith("**/")) out.push(`!${g.slice(3)}`);
    else out.push(`!/${g}`);
  }
  return out;
}

// ───────────────────────────── permissions ─────────────────────────────

/** Give the shared group read (and write, if `writable`) on everything under `root`. Symlinks untouched. */
async function shareWithGroup(root: string, writable: boolean): Promise<void> {
  const walk = async (p: string): Promise<void> => {
    const st = await lstat(p);
    if (st.isSymbolicLink()) return;
    const exec = st.isDirectory() || (st.mode & 0o100) !== 0;
    const add = (writable ? 0o060 : 0o040) | (exec ? 0o010 : 0);
    const mode = (st.mode & 0o7777 & ~(writable ? 0 : 0o020)) | add;
    if ((st.mode & 0o7777) !== mode) await chmod(p, mode);
    if (st.isDirectory()) for (const e of await readdir(p)) await walk(join(p, e));
  };
  await walk(root);
}

// ───────────────────────────── the mirror ─────────────────────────────

/**
 * Open (creating on first use) the bare mirror at `dir`, fetching from `remoteUrl`
 * (https://github.com/<owner>/<name>.git in production; a local path in tests).
 */
export function openMirror(dir: string, worktreeRoot: string, runUser: string, remoteUrl: string): Mirror {
  const g = (args: readonly string[], opts: GitOpts = {}) => git(["--git-dir", dir, ...args], opts);
  const factsCache = new Map<string, GitFacts>();

  let readyP: Promise<void> | null = null;
  const ready = () =>
    (readyP ??= (async () => {
      if (!existsSync(join(dir, "HEAD"))) {
        await mkdir(dir, { recursive: true });
        await git(["init", "--quiet", "--bare", dir]);
      }
      await g(["config", "core.sharedRepository", "group"]);
      await g(["config", "remote.origin.url", remoteUrl]);
      await g(["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
      await g(["config", "gc.auto", "0"]); // objects a running job still needs must not vanish under it
      if (!existsSync(worktreeRoot)) {
        await mkdir(worktreeRoot, { recursive: true });
        await chmod(worktreeRoot, 0o2770);
      }
      // A crash can leave worktrees behind; a fresh daemon owns none of them.
      for (const e of await readdir(worktreeRoot)) {
        if (e.startsWith("wt-")) await rm(join(worktreeRoot, e), { recursive: true, force: true }).catch(() => {});
      }
      await g(["worktree", "prune"]);
    })());

  const isTree = async (sha: Sha) => (await g(["cat-file", "-t", sha])).stdout.trim() === "tree";

  const inspect = async (from: Sha, to: Sha): Promise<Delta> => {
    await ready();
    const log = await g(["log", "-z", "--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B", `${from}..${to}`]);
    const commits = log.stdout
      .split("\0")
      .filter((r) => r.length > 0)
      .map((r) => {
        const [sha = "", author = "", committer = "", ...msg] = r.split("\x1f");
        return { sha: asSha(sha.replace(/^\n/, "")), author, committer, message: msg.join("\x1f") };
      });
    const raw = parseRaw((await g(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", from, to])).stdout);
    if (raw.length > MAX_PATHS) return { commits, paths: "too-many", files: [], added: [] };
    const num = parseNumstat((await g(["diff", "--numstat", "-z", "--no-renames", from, to])).stdout);
    const files = raw.map((r) => ({ ...r, ...(num.get(r.path) ?? { added: null, removed: null }) }));
    const diff = (await g(["diff", "--unified=0", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv", from, to])).stdout;
    const added = parseAddedLines(diff.length > MAX_ADDED_BYTES ? diff.slice(0, MAX_ADDED_BYTES) : diff);
    return { commits, paths: raw.map((r) => r.path), files, added };
  };

  const mirror: Mirror = {
    async fetch(auth) {
      await ready();
      await g(["fetch", "--quiet", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"], { env: authEnv(auth) });
    },

    async facts(trunkHead, baseRef, head, factory) {
      await ready();
      const baseRes = await g(["rev-parse", "--verify", "-q", `refs/remotes/origin/${baseRef}^{commit}`], { ok: [0, 1] });
      const baseSha = baseRes.code === 0 ? asSha(baseRes.stdout) : trunkHead; // base branch deleted: measure against trunk
      const cacheKey = `${trunkHead} ${baseSha} ${head} ${factory.email}`;
      const hit = factsCache.get(cacheKey);
      if (hit) return hit;

      const mergeBase = asSha((await g(["merge-base", baseSha, head])).stdout);
      const mt = await g(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", trunkHead, head], { ok: [0, 1] });
      const landing = parseMergeTree(mt.code, mt.stdout);
      const delta = await inspect(mergeBase, head);
      const lines = (await g(["log", "--first-parent", "-n", "64", "--format=%ct%x1f%ce", head])).stdout.split("\n").filter(Boolean);
      const headAt = Number(lines[0]?.split("\x1f")[0] ?? 0) * 1000;
      let streak = 0;
      for (const l of lines) {
        if ((l.split("\x1f")[1] ?? "").toLowerCase() !== factory.email.toLowerCase()) break;
        streak++;
      }
      const parent = streak > 0 ? asSha((await g(["rev-parse", `${head}^1`])).stdout) : null;
      const facts: GitFacts = { mergeBase, landing, delta, streak, parent, headAt };
      if (factsCache.size > 500) factsCache.clear();
      factsCache.set(cacheKey, facts);
      return facts;
    },

    async checkout(target, view, writable) {
      await ready();
      let commit = target;
      if (await isTree(target)) {
        // Fixed identity and date: the same tree always gives the same throwaway commit. Never pushed.
        const fixed = { GIT_AUTHOR_NAME: "factory", GIT_AUTHOR_EMAIL: "factory@localhost", GIT_COMMITTER_NAME: "factory", GIT_COMMITTER_EMAIL: "factory@localhost", GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000" };
        commit = asSha((await g(["commit-tree", target, "-F", "-"], { env: fixed, input: "landing tree\n" })).stdout);
      }
      const path = join(worktreeRoot, `wt-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`);
      await g(["worktree", "add", "--quiet", "--detach", "--no-checkout", path, commit]);
      try {
        if (view === "agent") await git(["sparse-checkout", "set", "--no-cone", ...sparsePatterns()], { cwd: path });
        await git(["checkout", "--quiet", "--detach", commit], { cwd: path });
        await shareWithGroup(path, writable);
        const adminDir = (await git(["rev-parse", "--absolute-git-dir"], { cwd: path })).stdout.trim();
        await shareWithGroup(adminDir, true);
      } catch (e) {
        await g(["worktree", "remove", "--force", path], { ok: [0, 128] }).catch(() => {});
        throw e;
      }

      const start = commit;
      const hidden = hiddenPathspecs();
      return {
        path,
        async capture() {
          // A fresh index outside the worktree, explicit git dir and work tree: whatever the agent did to
          // `.git`, the index or HEAD inside the worktree has no effect here.
          const index = join(dir, `capture-${randomBytes(6).toString("hex")}.idx`);
          const env = { GIT_INDEX_FILE: index };
          try {
            await g(["read-tree", start], { env });
            await g(["--work-tree", path, "add", "-A", "--", ".", ...hidden], { env, cwd: path });
            return asSha((await g(["write-tree"], { env })).stdout);
          } finally {
            await rm(index, { force: true });
          }
        },
        async dispose() {
          await g(["worktree", "remove", "--force", "--force", path], { ok: [0, 128] }).catch(() => {});
          await rm(path, { recursive: true, force: true }).catch((e: unknown) => console.error(`worktree ${path}: ${String(e)}`));
          await g(["worktree", "prune"]).catch(() => {});
        },
      };
    },

    async commit(tree, parents, message, who) {
      await ready();
      const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
      const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"];
      return asSha((await g(args, { env, input: message.endsWith("\n") ? message : `${message}\n` })).stdout);
    },

    async push(auth, ref, expect, sha) {
      await ready();
      if (!ref.startsWith("refs/heads/")) throw new Error(`push: ${ref} is not a branch ref`);
      const res = await g(["push", "--porcelain", `--force-with-lease=${ref}:${expect}`, "origin", `${sha}:${ref}`], { env: authEnv(auth), ok: [0, 1] });
      if (res.code === 0) return "ok";
      const all = `${res.stdout}\n${res.stderr}`;
      if (/stale info|fetch first|non-fast-forward|cannot lock ref/.test(all)) return "moved";
      throw new Error(`push ${ref} rejected: ${all.trim().slice(0, 2000)}`);
    },

    inspect,

    async treeOf(rev) {
      await ready();
      return asSha((await g(["rev-parse", `${rev}^{tree}`])).stdout);
    },

    async has(commit) {
      await ready();
      return (await g(["cat-file", "-e", `${commit}^{commit}`], { ok: [0, 1, 128] })).code === 0;
    },

    async isAncestor(a, b) {
      await ready();
      return (await g(["merge-base", "--is-ancestor", a, b], { ok: [0, 1] })).code === 0;
    },
  };
  void runUser; // ownership is by group (see the header); the run user's name is only for messages
  return mirror;
}

/** For `doctor`: the worktree root exists and its group has rwx. */
export async function isSharedRoot(root: string): Promise<boolean> {
  const st = await stat(root).catch(() => null);
  return !!st && st.isDirectory() && (st.mode & 0o070) === 0o070;
}
