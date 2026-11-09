/**
 * workspace.test.ts — the mirror against throwaway local repositories. No network: the "remote" is a
 * bare repo in a temp dir. `node --test factory/`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sha } from "./decide.ts";
import type { CleanText } from "./policy.ts";
import { openMirror, parseAddedLines, parseMergeTree, parseRaw, sparsePatterns, hiddenPathspecs, type Auth, type Mirror } from "./workspace.ts";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C" };
const OWNER = { name: "Owner", email: "owner@example.com" };
const BOT = { name: "factory[bot]", email: "1+factory[bot]@users.noreply.github.com" };
const AUTH = { header: "AUTHORIZATION: basic dGVzdA==" } as Auth;

let root = "";
let work = "";
let mirror: Mirror;
const sh = (args: string[], cwd = work, who = OWNER): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...ENV, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email },
    encoding: "utf8",
  }).trim();
const write = (p: string, text: string) => {
  mkdirSync(join(work, p, ".."), { recursive: true });
  writeFileSync(join(work, p), text);
};
const commitAll = (msg: string, who = OWNER) => {
  sh(["add", "-A"]);
  sh(["commit", "-q", "-m", msg], work, who);
  return sh(["rev-parse", "HEAD"]) as Sha;
};

let base: Sha, trunk: Sha, feat: Sha, fix1: Sha, fix2: Sha, conflicting: Sha;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const origin = join(root, "origin.git");
  work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: ENV });
  execFileSync("git", ["init", "-q", "-b", "main", work], { env: ENV });
  sh(["remote", "add", "origin", origin]);

  write("a.ts", "one\ntwo\nthree\n");
  write(".claude/settings.json", '{"hooks":"original"}\n');
  write(".mcp.json", "{}\n");
  base = commitAll("base");
  write("z.ts", "trunk moved\n");
  trunk = commitAll("trunk moves on");

  sh(["checkout", "-q", "-b", "feat", base]);
  appendFileSync(join(work, "a.ts"), "four\n");
  write("b.ts", "export const b = 1;\n");
  feat = commitAll("feat: add b");
  appendFileSync(join(work, "a.ts"), "five\n");
  fix1 = commitAll("fix one", BOT);
  appendFileSync(join(work, "a.ts"), "six\n");
  fix2 = commitAll("fix two", BOT);

  sh(["checkout", "-q", "-b", "clash", base]);
  write("z.ts", "a different z\n");
  conflicting = commitAll("clash");

  sh(["checkout", "-q", "main"]);
  sh(["push", "-q", "origin", "main", "feat", "clash"]);

  mirror = openMirror(join(root, "mirror.git"), join(root, "wt"), "nobody", origin);
  await mirror.fetch(AUTH);
});
after(() => rmSync(root, { recursive: true, force: true }));

test("facts: merge base, clean landing, delta, streak, parent, headAt", async () => {
  const f = await mirror.facts(trunk, "main", fix2, BOT);
  assert.equal(f.mergeBase, base);
  assert.equal(f.landing.kind, "clean");
  assert.deepEqual([...(f.delta.paths as string[])].sort(), ["a.ts", "b.ts"]);
  assert.equal(f.delta.commits.length, 3);
  assert.equal(f.streak, 2);
  assert.equal(f.parent, fix1);
  assert.ok(Math.abs(f.headAt - Date.now()) < 10 * 60_000);
  const a = f.delta.added.find((x) => x.path === "a.ts");
  assert.equal(a?.text, "four\nfive\nsix");
  const ab = f.delta.files.find((x) => x.path === "b.ts");
  assert.deepEqual([ab?.status, ab?.added, ab?.removed], ["A", 1, 0]);
  // The landing tree contains both main's z.ts and the branch's b.ts.
  if (f.landing.kind !== "clean") return;
  const ls = execFileSync("git", ["--git-dir", join(root, "mirror.git"), "ls-tree", "--name-only", f.landing.tree], { env: ENV, encoding: "utf8" });
  assert.ok(ls.includes("z.ts") && ls.includes("b.ts"));
});

test("facts: owner head -> streak 0, no parent", async () => {
  const f = await mirror.facts(trunk, "main", feat, BOT);
  assert.deepEqual([f.streak, f.parent], [0, null]);
});

test("facts: conflict with trunk is detected with its paths", async () => {
  const f = await mirror.facts(trunk, "main", conflicting, BOT);
  assert.deepEqual(f.landing, { kind: "conflict", paths: ["z.ts"] });
});

test("facts: a deleted base branch falls back to trunk", async () => {
  const f = await mirror.facts(trunk, "gone-branch", feat, BOT);
  assert.equal(f.mergeBase, base);
});

test("agent checkout hides .claude and .mcp.json; capture keeps them and ignores agent commits", async () => {
  const wt = await mirror.checkout(feat, "agent", true);
  try {
    assert.ok(existsSync(join(wt.path, "a.ts")));
    assert.ok(!existsSync(join(wt.path, ".claude")));
    assert.ok(!existsSync(join(wt.path, ".mcp.json")));
    appendFileSync(join(wt.path, "a.ts"), "edited\n");
    mkdirSync(join(wt.path, ".claude"), { recursive: true });
    writeFileSync(join(wt.path, ".claude/settings.json"), '{"hooks":"evil"}\n');
    writeFileSync(join(wt.path, ".mcp.json"), '{"evil":true}\n');
    // The agent commits with its own message; capture must not care.
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=x", "-c", "user.email=x@y", "commit", "-qam", "Co-Authored-By: someone"], { cwd: wt.path, env: ENV });
    const tree = await wt.capture();
    const show = (p: string) => execFileSync("git", ["--git-dir", join(root, "mirror.git"), "show", `${tree}:${p}`], { env: ENV, encoding: "utf8" });
    assert.equal(show("a.ts"), "one\ntwo\nthree\nfour\nedited\n");
    assert.equal(show(".claude/settings.json"), '{"hooks":"original"}\n');
    assert.equal(show(".mcp.json"), "{}\n");
  } finally {
    await wt.dispose();
  }
  assert.ok(!existsSync(wt.path));
});

test("capture with no edits returns the head's tree", async () => {
  const wt = await mirror.checkout(feat, "agent", true);
  try {
    assert.equal(await wt.capture(), await mirror.treeOf(feat));
  } finally {
    await wt.dispose();
  }
});

test("full checkout of a tree (landing tree) works", async () => {
  const f = await mirror.facts(trunk, "main", feat, BOT);
  assert.equal(f.landing.kind, "clean");
  if (f.landing.kind !== "clean") return;
  const wt = await mirror.checkout(f.landing.tree, "full", true);
  try {
    assert.equal(readFileSync(join(wt.path, "z.ts"), "utf8"), "trunk moved\n");
    assert.ok(existsSync(join(wt.path, "b.ts")));
    assert.ok(existsSync(join(wt.path, ".claude/settings.json")));
  } finally {
    await wt.dispose();
  }
});

test("commit + inspect + push with lease; a stale lease is 'moved'", async () => {
  const tree = await mirror.treeOf(trunk);
  const msg = "Merge pull request #1 from o/feat\n\nfeat" as CleanText;
  const f = await mirror.facts(trunk, "main", feat, BOT);
  if (f.landing.kind !== "clean") throw new Error("expected clean");
  const m = await mirror.commit(f.landing.tree, [trunk, feat], msg, BOT);
  assert.equal(await mirror.treeOf(m), f.landing.tree);
  const d = await mirror.inspect(trunk, m);
  assert.equal(d.commits[0]?.sha, m);
  assert.equal(d.commits[0]?.committer, `${BOT.name} <${BOT.email}>`);
  assert.equal(d.commits[0]?.message.trim(), msg);
  assert.ok(await mirror.isAncestor(feat, m));
  assert.ok(!(await mirror.isAncestor(m, feat)));

  assert.equal(await mirror.push(AUTH, "refs/heads/main", feat /* wrong lease */, m), "moved");
  assert.equal(await mirror.push(AUTH, "refs/heads/main", trunk, m), "ok");
  await mirror.fetch(AUTH);
  assert.ok(await mirror.has(m));
  void tree;
});

test("parsers", () => {
  assert.deepEqual(parseRaw(":100644 100755 aaa bbb M\0x.sh\0:000000 100644 000 ccc A\0new.ts\0"), [
    { path: "x.sh", status: "M", modeChanged: true },
    { path: "new.ts", status: "A", modeChanged: false },
  ]);
  assert.deepEqual(parseAddedLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,0 +2 @@\n+hello\n+++not a header\ndiff --git a/y b/y\n+++ /dev/null\n-gone\n"), [{ path: "x", text: "hello\n++not a header" }]);
  const t = "a".repeat(40);
  assert.deepEqual(parseMergeTree(0, `${t}\0`), { kind: "clean", tree: t });
  assert.deepEqual(parseMergeTree(1, `${t}\0x.ts\0y.ts\0\0`), { kind: "conflict", paths: ["x.ts", "y.ts"] });
  assert.deepEqual(sparsePatterns([".claude/**", ".mcp.json", "**/secret"]), ["/*", "!/.claude/", "!/.mcp.json", "!secret"]);
  assert.deepEqual(hiddenPathspecs([".claude/**"]), [":(exclude,glob).claude/**"]);
});
