/**
 * github.test.ts — the wire format and the write-boundary checks, with no network. `node --test factory/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Sha, ReviewResult, VerifyResult, FixResult, Job } from "./decide.ts";
import type { Delta, GitFacts } from "./workspace.ts";
import {
  externalId, parseExternalId, withData, readData, runOf, historyOf, parseSnapshot, resolveBase, toPr, usageOf,
  landMessage, fixMessage, fixBounds, encodeReview, encodeVerify, encodeFix, numberFindings, CHECK, type RawRun,
} from "./github.ts";

const sha = (s: string) => s.padEnd(40, "0") as Sha;
const APP = 4242;
const BOT = { name: "factory[bot]", email: "1+factory[bot]@users.noreply.github.com" };
const H = sha("a1"), P = sha("a0"), MB = sha("b1"), T = sha("c1"), TREE = sha("d1");

// ───────────────────────────── records ─────────────────────────────

test("external_id round-trips; anything else is not a record", () => {
  assert.deepEqual(parseExternalId(externalId("review", MB)), { kind: "review", key: MB });
  assert.equal(parseExternalId("v2 review " + MB), null);
  assert.equal(parseExternalId("v1 review deadbeef"), null);
  assert.equal(parseExternalId(null), null);
});

test("data block round-trips through clean, even with hostile strings", () => {
  const result: ReviewResult = {
    findings: [{ id: "R1", path: "a.ts", line: 3, severity: "blocker", title: "closes --> early <!-- x", detail: "line one\n\n\n\nline two" }],
  };
  const text = withData("Human text", { v: 1, state: "done", result, costUsd: 0.5, seconds: 12 });
  const back = readData(text);
  assert.equal(back?.state, "done");
  assert.deepEqual(back?.state === "done" ? back.result : null, { findings: [{ ...result.findings[0], detail: "line one\n\nline two" }] });
  assert.ok(text.startsWith("Human text"));
});

test("data block strings are cleaned like the prose (owner rule)", () => {
  const text = withData("Claude found it", { v: 1, state: "done", result: { findings: [{ id: "R1", path: ".claude/settings.json", line: null, severity: "nit", title: "Anthropic style", detail: "Generated with a tool\nok" }] } });
  assert.ok(!/claude found|anthropic|generated with/i.test(text), text);
  const back = readData(text);
  const f = back?.state === "done" ? (back.result as ReviewResult).findings[0] : null;
  assert.equal(f?.path, ".claude/settings.json"); // path context survives
  assert.equal(f?.title, "the tool style");
});

const run = (p: Partial<RawRun>): RawRun => ({
  id: 1, name: CHECK.review, externalId: externalId("review", MB), status: "COMPLETED", conclusion: "success",
  startedAt: "2026-11-08T10:00:00Z", completedAt: "2026-11-08T10:05:00Z", title: "", summary: "", text: null, ...p,
});
const doneText = (result: unknown) => withData("x", { v: 1, state: "done", result });
const errText = (why: string) => withData("x", { v: 1, state: "errored", why: why as "crashed" });

test("check run -> record: running, done, errored, unreadable, wrong name", () => {
  assert.deepEqual(runOf(run({ status: "IN_PROGRESS" }), "review"), { state: "running", key: MB, startedAt: Date.parse("2026-11-08T10:00:00Z") });
  const done = runOf<ReviewResult>(run({ text: doneText({ findings: [] }) }), "review");
  assert.deepEqual(done, { state: "done", key: MB, at: Date.parse("2026-11-08T10:05:00Z"), result: { findings: [] } });
  assert.equal(runOf(run({ text: errText("timeout") }), "review")?.state, "errored");
  assert.deepEqual(runOf(run({ text: "no data" }), "review"), { state: "errored", key: MB, at: Date.parse("2026-11-08T10:05:00Z"), why: "abandoned" });
  assert.deepEqual(runOf(run({ text: doneText({ findings: "nope" }) }), "review"), { state: "errored", key: MB, at: Date.parse("2026-11-08T10:05:00Z"), why: "bad-output" });
  assert.equal(runOf(run({ name: CHECK.verify }), "review"), null);
  assert.equal(runOf(run({ externalId: externalId("verify", MB) }), "review"), null);
});

test("history: latest by start time; errors count only the latest key, not unavailable", () => {
  const h = historyOf(
    [
      run({ id: 1, startedAt: "2026-11-08T09:00:00Z", text: errText("crashed") }),
      run({ id: 2, startedAt: "2026-11-08T09:10:00Z", text: errText("unavailable") }),
      run({ id: 3, startedAt: "2026-11-08T09:20:00Z", text: errText("crashed"), externalId: externalId("review", sha("old")) }),
      run({ id: 4, startedAt: "2026-11-08T09:30:00Z", text: errText("timeout") }),
    ],
    "review",
  );
  assert.equal(h.latest?.state, "errored");
  assert.equal(h.errors, 2);
});

// ───────────────────────────── snapshot ─────────────────────────────

const suite = (appId: number, runs: unknown[]) => ({ nodes: [{ app: { databaseId: appId }, checkRuns: { nodes: runs } }] });
const gqlRun = (p: Record<string, unknown>) => ({
  databaseId: 7, name: CHECK.review, externalId: externalId("review", MB), status: "COMPLETED", conclusion: "failure",
  startedAt: new Date(Date.now() - 3600_000).toISOString(), completedAt: new Date().toISOString(), title: "t", summary: "s", text: null, ...p,
});
const FIXTURE = {
  repository: {
    defaultBranchRef: { name: "main", target: { oid: T, checkSuites: suite(APP, [gqlRun({ databaseId: 1, name: CHECK.verify, externalId: externalId("verify", TREE), text: doneText({ steps: [{ name: "test", outcome: "pass", seconds: 1, tail: "" }] }) })]) } },
    pullRequests: {
      nodes: [
        {
          number: 91, title: "Add b", body: "Body", isDraft: false, isCrossRepository: false, headRefName: "feat", headRefOid: H, baseRefName: "main",
          author: { login: "gdorsi" }, labels: { nodes: [{ name: "factory:hold" }] },
          commits: {
            nodes: [
              { commit: { oid: P, checkSuites: suite(APP, [gqlRun({ databaseId: 2, text: doneText({ findings: [{ id: "R1", path: "a.ts", line: 1, severity: "blocker", title: "bad", detail: "" }] }) })]) } },
              {
                commit: {
                  oid: H,
                  checkSuites: {
                    nodes: [
                      ...suite(APP, [gqlRun({ databaseId: 3, status: "IN_PROGRESS", completedAt: null })]).nodes,
                      ...suite(999, [gqlRun({ databaseId: 4, text: doneText({ findings: [] }) })]).nodes, // forged by another app: ignored
                    ],
                  },
                },
              },
            ],
          },
        },
        {
          number: 92, title: "Stacked", body: "", isDraft: true, isCrossRepository: false, headRefName: "feat2", headRefOid: sha("e1"), baseRefName: "feat",
          author: { login: "gdorsi" }, labels: { nodes: [] }, commits: { nodes: [] },
        },
      ],
    },
    issues: { totalCount: 1 },
  },
};

const delta = (p: Partial<Delta> = {}): Delta => ({
  commits: [{ sha: H, author: "O <o@x>", committer: "O <o@x>", message: "Add b" }],
  paths: ["a.ts", "factory/x.ts"],
  files: [],
  added: [{ path: "a.ts", text: "const x = 1;" }],
  ...p,
});
const facts = (p: Partial<GitFacts> = {}): GitFacts => ({ mergeBase: MB, landing: { kind: "clean", tree: TREE }, delta: delta(), streak: 1, parent: P, headAt: 123, ...p });

test("snapshot fixture -> Pr: only the App's runs count, hold label, gate paths, prior review from head^", () => {
  const snap = parseSnapshot(FIXTURE, APP);
  assert.equal(snap.paused, true);
  assert.equal(snap.trunk.head, T);
  const raw = snap.prs[0]!;
  const pr = toPr(raw, facts(), { kind: "trunk" });
  assert.equal(pr.hold, true);
  assert.equal(pr.records.review.latest?.state, "running"); // app 999's "done, no findings" is ignored
  assert.deepEqual(pr.gatePaths, ["factory/x.ts"]);
  assert.deepEqual(pr.attribution, []);
  assert.equal(pr.priorReview?.findings[0]?.id, "R1");
  assert.equal(pr.headAt, 123);
  assert.equal(pr.streak, 1);
});

test("snapshot: attribution in a commit, the body or an added line is found", () => {
  const raw = { ...parseSnapshot(FIXTURE, APP).prs[0]!, body: "Generated with a tool" };
  const pr = toPr(raw, facts({ delta: delta({ commits: [{ sha: H, author: "", committer: "", message: "x\n\nCo-Authored-By: Bot <noreply@anthropic.com>" }], added: [{ path: "b.ts", text: "// written with Claude Code" }] }) }), { kind: "trunk" });
  assert.deepEqual(pr.attribution, [`commit:${H.slice(0, 12)}`, "body", "diff:b.ts"]);
});

test("snapshot: too many paths -> changed too-many, no gate paths", () => {
  const pr = toPr(parseSnapshot(FIXTURE, APP).prs[0]!, facts({ delta: delta({ paths: "too-many" }) }), { kind: "trunk" });
  assert.deepEqual([pr.changed, pr.gatePaths], ["too-many", []]);
});

test("base resolution: trunk, stacked, landed, other", () => {
  const open = new Map([["feat", 91]]);
  const merged = new Map([["old", { pr: 80, into: "main" }]]);
  assert.deepEqual(resolveBase("main", "main", open, merged), { kind: "trunk" });
  assert.deepEqual(resolveBase("feat", "main", open, merged), { kind: "stacked", on: 91 });
  assert.deepEqual(resolveBase("old", "main", open, merged), { kind: "landed", pr: 80, into: "main" });
  assert.deepEqual(resolveBase("release", "main", open, merged), { kind: "other", ref: "release" });
});

test("usage counts the App's job runs of the last 24 h, once each", () => {
  const snap = parseSnapshot(FIXTURE, APP);
  assert.deepEqual(usageOf(snap, Date.now()), { review: 2, verify: 1, fix: 0 });
  assert.deepEqual(usageOf(snap, Date.now() + 48 * 3600_000), { review: 0, verify: 0, fix: 0 });
});

// ───────────────────────────── commits ─────────────────────────────

test("land message: template, cleaned, no trailers", () => {
  assert.equal(landMessage({ number: 91, branch: "feat", title: "Add b" }, "gdorsi"), "Merge pull request #91 from gdorsi/feat\n\nAdd b");
  assert.equal(landMessage({ number: 9, branch: "x", title: "Port the Claude loop" }, "o"), "Merge pull request #9 from o/x\n\nPort the tool loop");
});

const fixJob = { findings: [{ id: "R1", path: "a.ts", line: 1, severity: "blocker" as const, title: "t", detail: "" }, { id: "R2", path: null, line: null, severity: "blocker" as const, title: "u", detail: "" }], failures: [{ name: "test", outcome: "fail" as const, seconds: 1, tail: "" }] } satisfies Pick<Job & { kind: "fix" }, "findings" | "failures">;

test("fix message: first line of the subject, cleaned, then the addressed ids", () => {
  assert.equal(fixMessage("Guard the manifest generation\nmore words", ["R2", "test", "bogus"], fixJob), "Guard the manifest generation\n\nAddresses R2, test.");
  assert.equal(fixMessage("", [], fixJob), "Address review findings\n\nAddresses R1, R2, test.");
  assert.ok(!/claude|co-authored/i.test(fixMessage("Fix by Claude\nCo-Authored-By: x", ["R1"], fixJob)));
});

const ident = `${BOT.name} <${BOT.email}>`;
const fixDelta = (p: Partial<Delta> = {}): Delta => ({
  commits: [{ sha: H, author: ident, committer: ident, message: "m" }],
  paths: ["a.ts"],
  files: [{ path: "a.ts", status: "M", modeChanged: false, added: 3, removed: 1 }],
  added: [{ path: "a.ts", text: "x" }],
  ...p,
});

test("fix bounds: a small edit of the PR's own file passes", () => {
  assert.equal(fixBounds(fixDelta(), ["a.ts", "b.ts"], 200, BOT, "Fix\n\nAddresses R1."), null);
});

const reasons: [string, Partial<Delta>, readonly string[], number, string, RegExp][] = [
  ["file outside the PR", { paths: ["c.ts"], files: [{ path: "c.ts", status: "M", modeChanged: false, added: 1, removed: 0 }] }, ["a.ts"], 200, "m", /does not change: c\.ts/],
  ["added file", { paths: ["a.ts"], files: [{ path: "a.ts", status: "A", modeChanged: false, added: 1, removed: 0 }] }, ["a.ts"], 200, "m", /adds, deletes.*a\.ts \(A\)/],
  ["mode change", { files: [{ path: "a.ts", status: "M", modeChanged: true, added: 0, removed: 0 }] }, ["a.ts"], 200, "m", /a\.ts \(mode\)/],
  ["binary", { files: [{ path: "a.ts", status: "M", modeChanged: false, added: null, removed: null }] }, ["a.ts"], 200, "m", /binary changes: a\.ts/],
  ["too many lines", {}, ["a.ts"], 3, "m", /changes 4 lines \(limit 3\)/],
  ["protected path", { paths: ["packages/kv/package.json"], files: [{ path: "packages/kv/package.json", status: "M", modeChanged: false, added: 1, removed: 0 }] }, ["packages/kv/package.json"], 200, "m", /may not change: packages\/kv\/package\.json/],
  ["attribution in an added line", { added: [{ path: "a.ts", text: "// Generated with a tool" }] }, ["a.ts"], 200, "m", /attribution in diff:a\.ts/],
  ["attribution in the message", {}, ["a.ts"], 200, "Fix\n\nGenerated with a tool", /attribution in message/],
  ["someone else's commit", { commits: [{ sha: H, author: "x <x@y>", committer: "x <x@y>", message: "m" }] }, ["a.ts"], 200, "m", /not exactly one commit by the factory/],
  ["too many paths", { paths: "too-many" }, ["a.ts"], 200, "m", /too many files/],
];
for (const [name, patch, allowed, max, msg, re] of reasons) {
  test(`fix bounds reject: ${name}`, () => assert.match(fixBounds(fixDelta(patch), allowed, max, BOT, msg) ?? "", re));
}

// ───────────────────────────── encoders ─────────────────────────────

test("review encoding: numbered findings, annotations only for paths in the diff, conclusion from blockers", () => {
  const r = numberFindings({ findings: [
    { path: "a.ts", line: 4, severity: "blocker", title: "Claude wrote a bug", detail: "d" },
    { path: "not-in-diff.ts", line: 1, severity: "nit", title: "n", detail: "" },
    { path: null, line: null, severity: "nit", title: "general", detail: "" },
  ] });
  assert.deepEqual(r.findings.map((f) => f.id), ["R1", "R2", "R3"]);
  assert.equal(r.findings[0]?.title, "the tool wrote a bug");
  const e = encodeReview(r, (p) => p === "a.ts", { costUsd: 0.1, seconds: 3 });
  assert.equal(e.conclusion, "failure");
  assert.equal(e.title, "1 blocker, 2 nits");
  assert.deepEqual(e.annotations.map((a) => [a.path, a.start_line, a.annotation_level]), [["a.ts", 4, "failure"]]);
  assert.match(e.summary, /R2.*not-in-diff\.ts/);
  const back = readData(e.text);
  assert.deepEqual(back?.state === "done" ? back.result : null, r);
});

test("verify encoding: huge tails still fit GitHub's 65k text limit and stay parseable", () => {
  const big = "x".repeat(40_000);
  const r: VerifyResult = { steps: [{ name: "install", outcome: "pass", seconds: 3, tail: "" }, { name: "test", outcome: "fail", seconds: 9, tail: `${big}\nlast line` }, { name: "two-tab", outcome: "timeout", seconds: 900, tail: big }] };
  const e = encodeVerify(r, { seconds: 912 });
  assert.ok(e.text.length <= 65_000, String(e.text.length));
  assert.equal(e.conclusion, "failure");
  assert.equal(e.title, "1/3 passed: test, two-tab failed");
  const back = readData(e.text);
  const steps = back?.state === "done" ? (back.result as VerifyResult).steps : [];
  assert.deepEqual(steps.map((s) => s.outcome), ["pass", "fail", "timeout"]);
  assert.ok(steps[1]?.tail.endsWith("last line"));
});

test("fix encoding round-trips every outcome", () => {
  const outcomes: FixResult[] = [{ outcome: "pushed", commit: H }, { outcome: "no-change" }, { outcome: "disputed", disputes: [{ id: "R1", reason: "already handled" }] }, { outcome: "rejected", why: "binary changes: a.png" }, { outcome: "superseded" }];
  for (const o of outcomes) {
    const e = encodeFix(o, { costUsd: null, seconds: 1 });
    const rec = runOf<FixResult>(run({ name: CHECK.fix, externalId: externalId("fix", H), text: e.text }), "fix");
    assert.deepEqual(rec?.state === "done" ? rec.result : null, o);
  }
});
