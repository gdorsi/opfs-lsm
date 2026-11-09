/**
 * github.ts — the only module that can read or write GitHub, and therefore the gatekeeper.
 *
 * Holds the App private key in a closure (boundaries.test.ts: no other module may read `app.keyFile`).
 * GitHub is the factory's only database: everything the factory knows about a PR is a check run the App
 * wrote on a commit, keyed by the content it judged. This module owns that encoding in both directions.
 *
 * Every write passes through here, so every rule that must not be bypassed is enforced here:
 *  - free text is `CleanText` (owner rule), commits are built by the factory from templates
 *  - fix patches are checked against PATHS, the fix bounds and the attribution scan before the push
 *  - every branch write is a lease on the exact commit that was read (owner always wins)
 *  - main only moves to a merge commit whose tree equals a MergeTicket's verified tree
 *
 * The pure half (wire format, snapshot parsing, message templates, fix bounds) is exported for tests;
 * nothing but main.ts should need more than `connect` and `checkApp`.
 */
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  World, Pr, Job, Step, Sha, MergeTicket, ReviewResult, VerifyResult, FixResult, Finding, StepResult,
  Run, History, Records, Base, ErrorWhy, JobKind, Trunk,
} from "./decide.ts";
import { render, isGreen, blockers } from "./decide.ts";
import type { Policy, CleanText } from "./policy.ts";
import { clean, findAttribution, fixerViolations, gatePaths } from "./policy.ts";
import type { AgentOutcome, ReviewOut, FixOut } from "./agents.ts";
import type { VerifyOut } from "./verify.ts";
import { openMirror, type Mirror, type Auth, type Identity, type GitFacts, type Delta } from "./workspace.ts";

// ───────────────────────────── public surface ─────────────────────────────

/** What `work` must return for each job kind. */
export type Output<J extends Job> =
  J extends { kind: "review" } ? AgentOutcome<ReviewOut> :
  J extends { kind: "verify" } ? VerifyOut :
  J extends { kind: "fix" } ? AgentOutcome<FixOut> & { tree: Sha | null } : never;

export type Work = <J extends Job>(job: J) => Promise<Output<J>>;

export interface Remote {
  /**
   * One tick's facts: git fetch + one GraphQL query + local git derivations. The only read path.
   * Also refreshes this module's private view of what each `factory` check run currently shows,
   * so `act` writes only on change and comments only once per (head, hand-off).
   * Unless read-only, it then completes records the facts just read prove finished: `factory` status
   * lines left in_progress on superseded heads (neutral), and PRs whose head is already in trunk (success).
   */
  snapshot(): Promise<World>;

  /**
   * Make GitHub show `step` for `pr`. Idempotent; safe to call every tick.
   *  status   -> create or PATCH the `factory` check run on head (only if title/summary/conclusion changed)
   *  handoff  -> conclusion action_required + one PR comment per (head, code)
   *  retarget -> PATCH /pulls/{n} { base }
   *  merge    -> land(ticket)
   */
  act(pr: Pr, step: Step & { kind: "track" }): Promise<void>;

  /**
   * Claim, run, record. Resolves as soon as the claim (an in_progress check run on the job's commit,
   * external_id = key) exists; `done` settles when the record is complete. A running record left by a
   * crash is completed as errored/abandoned here before the new claim.
   */
  start<J extends Job>(job: J, work: Work): Promise<{ done: Promise<void> }>;
}

export interface ConnectOptions {
  /** `plan` and `doctor`: snapshot works, every write throws, nothing is tidied. */
  readOnly?: boolean;
}

// ───────────────────────────── wire format (pure) ─────────────────────────────

/** Check-run names exist only here. decide.ts never sees them. */
export const CHECK = {
  status: "factory",
  review: "factory/review",
  verify: "factory/verify",
  fix: "factory/fix",
} as const;
type RecordKind = keyof typeof CHECK;

/** Label names exist only here. The factory reads them and never writes any label. */
const LABEL = { hold: "factory:hold", paused: "factory:paused" } as const;

/** Role words for posts. Never a vendor, model or CLI name. */
const ROLE: { readonly [K in JobKind]: string } = { review: "reviewer", verify: "suite", fix: "fixer" };

const GH_TEXT_MAX = 65_000;
const ERROR_WHYS: readonly ErrorWhy[] = ["unavailable", "timeout", "crashed", "bad-output", "interrupted", "abandoned", "infra"];

/** external_id = "v1 <kind> <key-sha>". */
export function externalId(kind: RecordKind, key: Sha): string {
  return `v1 ${kind} ${key}`;
}
export function parseExternalId(s: string | null | undefined): { kind: RecordKind; key: Sha } | null {
  const m = /^v1 (status|review|verify|fix) ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/.exec(s ?? "");
  return m ? { kind: m[1] as RecordKind, key: m[2] as Sha } : null;
}

/** The JSON stored in a record's data block. */
export type RecordData =
  | { v: 1; state: "done"; result: unknown; costUsd?: number | null; seconds?: number }
  | { v: 1; state: "errored"; why: ErrorWhy; detail?: string }
  | { v: 1; state: "status"; commented: readonly string[] };

const DATA_OPEN = "<!-- factory:data ";
const DATA_CLOSE = " -->";

/** Clean every string inside a JSON value, so the data block is as clean as the prose around it. */
function deepClean(v: unknown, max: number): unknown {
  if (typeof v === "string") return clean(v, max);
  if (Array.isArray(v)) return v.map((x) => deepClean(x, max));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepClean(x, max)]));
  return v;
}

function dataBlock(data: RecordData): string {
  // `<` and `>` only occur inside JSON strings, where \u003c / \u003e are equivalent: the block can't close early.
  const json = JSON.stringify(deepClean(data, GH_TEXT_MAX)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `${DATA_OPEN}${json}${DATA_CLOSE}`;
}

/** Human markdown + the data block, as one CleanText of at most 65,000 characters. */
export function withData(human: string, data: RecordData): CleanText {
  const block = dataBlock(data);
  const room = GH_TEXT_MAX - block.length - 4;
  if (room < 0) throw new Error(`record data too large (${block.length} chars)`);
  const head = clean(human, Math.max(1, room));
  const text = clean(`${head}\n\n${block}`, GH_TEXT_MAX);
  if (!text.endsWith(block)) throw new Error("record data block did not survive cleaning");
  return text;
}

export function readData(text: string | null | undefined): RecordData | null {
  if (!text) return null;
  const at = text.lastIndexOf(DATA_OPEN);
  if (at < 0) return null;
  const end = text.indexOf(DATA_CLOSE, at + DATA_OPEN.length);
  if (end < 0) return null;
  try {
    const d = JSON.parse(text.slice(at + DATA_OPEN.length, end)) as RecordData;
    return d && d.v === 1 ? d : null;
  } catch {
    return null;
  }
}

// result validators: a record is only as good as its shape

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function asReview(v: unknown): ReviewResult | null {
  if (!isObj(v) || !Array.isArray(v.findings)) return null;
  const findings: Finding[] = [];
  for (const f of v.findings) {
    if (!isObj(f) || typeof f.id !== "string" || (f.severity !== "blocker" && f.severity !== "nit") || typeof f.title !== "string") return null;
    findings.push({
      id: f.id,
      path: typeof f.path === "string" ? f.path : null,
      line: typeof f.line === "number" ? f.line : null,
      severity: f.severity,
      title: f.title,
      detail: typeof f.detail === "string" ? f.detail : "",
    });
  }
  return { findings };
}
function asVerify(v: unknown): VerifyResult | null {
  if (!isObj(v) || !Array.isArray(v.steps)) return null;
  const steps: StepResult[] = [];
  for (const s of v.steps) {
    if (!isObj(s) || typeof s.name !== "string" || !["pass", "flaky", "fail", "timeout"].includes(s.outcome as string)) return null;
    steps.push({ name: s.name, outcome: s.outcome as StepResult["outcome"], seconds: typeof s.seconds === "number" ? s.seconds : 0, tail: typeof s.tail === "string" ? s.tail : "" });
  }
  return { steps };
}
function asFix(v: unknown): FixResult | null {
  if (!isObj(v)) return null;
  switch (v.outcome) {
    case "pushed":
      return typeof v.commit === "string" ? { outcome: "pushed", commit: v.commit as Sha } : null;
    case "no-change":
    case "superseded":
      return { outcome: v.outcome };
    case "rejected":
      return { outcome: "rejected", why: typeof v.why === "string" ? v.why : "" };
    case "disputed":
      return Array.isArray(v.disputes)
        ? { outcome: "disputed", disputes: v.disputes.filter(isObj).map((d) => ({ id: String(d.id ?? ""), reason: String(d.reason ?? "") })) }
        : null;
    default:
      return null;
  }
}
const RESULT: { readonly [K in JobKind]: (v: unknown) => unknown } = { review: asReview, verify: asVerify, fix: asFix };

/** A check run as the snapshot query returns it, normalised. Only the App's runs ever become one. */
export interface RawRun {
  id: number;
  name: string;
  externalId: string | null;
  status: string; // QUEUED | IN_PROGRESS | COMPLETED | ...
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  title: string | null;
  summary: string | null;
  text: string | null;
}

/** One check run -> one domain record of `kind`, or null if it isn't one. */
export function runOf<R>(run: RawRun, kind: JobKind): Run<R> | null {
  if (run.name !== CHECK[kind]) return null;
  const id = parseExternalId(run.externalId);
  if (!id || id.kind !== kind) return null;
  const startedAt = Date.parse(run.startedAt ?? "") || 0;
  if (run.status !== "COMPLETED") return { state: "running", key: id.key, startedAt };
  const at = Date.parse(run.completedAt ?? "") || startedAt;
  const data = readData(run.text);
  if (data?.state === "done") {
    const result = RESULT[kind](data.result) as R | null;
    return result ? { state: "done", key: id.key, at, result } : { state: "errored", key: id.key, at, why: "bad-output" };
  }
  if (data?.state === "errored" && ERROR_WHYS.includes(data.why)) return { state: "errored", key: id.key, at, why: data.why };
  return { state: "errored", key: id.key, at, why: "abandoned" }; // completed by someone else, or unreadable
}

/** All runs of `kind` on one commit -> latest + errors on the latest's key (excluding unavailable/interrupted). */
export function historyOf<R>(runs: readonly RawRun[], kind: JobKind): History<R> {
  const recs = runs
    .map((r) => ({ r, rec: runOf<R>(r, kind) }))
    .filter((x): x is { r: RawRun; rec: Run<R> } => x.rec !== null)
    .sort((a, b) => (Date.parse(a.r.startedAt ?? "") || 0) - (Date.parse(b.r.startedAt ?? "") || 0) || a.r.id - b.r.id);
  const latest = recs.at(-1)?.rec ?? null;
  if (!latest) return { latest: null, errors: 0 };
  const errors = recs.filter(({ rec }) => rec.state === "errored" && rec.key === latest.key && rec.why !== "unavailable" && rec.why !== "interrupted").length;
  return { latest, errors };
}

function recordsOf(runs: readonly RawRun[]): Records {
  return { review: historyOf<ReviewResult>(runs, "review"), verify: historyOf<VerifyResult>(runs, "verify"), fix: historyOf<FixResult>(runs, "fix") };
}

// encoders

export interface Encoded {
  conclusion: "success" | "failure" | "neutral" | "action_required";
  title: CleanText;
  summary: CleanText;
  text: CleanText;
  annotations: Annotation[];
}
export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "notice";
  title: CleanText;
  message: CleanText;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Findings numbered R1.. by the factory, every string cleaned. */
export function numberFindings(out: ReviewOut): ReviewResult {
  return {
    findings: out.findings.map((f, i) => ({
      id: `R${i + 1}`,
      path: f.path ? clean(f.path, 500) : null,
      line: typeof f.line === "number" && f.line > 0 ? Math.floor(f.line) : null,
      severity: f.severity === "blocker" ? "blocker" : "nit",
      title: clean(f.title, 300),
      detail: clean(f.detail ?? "", 4000),
    })),
  };
}

/** `inDiff(path)` decides which findings can be annotations; the rest live in the summary only. */
export function encodeReview(r: ReviewResult, inDiff: (path: string) => boolean, meta: { costUsd: number | null; seconds: number }): Encoded {
  const b = blockers(r).length;
  const nits = r.findings.length - b;
  const title = r.findings.length === 0 ? "no findings" : b > 0 ? `${plural(b, "blocker")}, ${plural(nits, "nit")}` : `no blockers, ${plural(nits, "nit")}`;
  const line = (f: Finding) => `- **${f.id}** ${f.severity}${f.path ? ` \`${f.path}${f.line ? `:${f.line}` : ""}\`` : ""}: ${f.title}`;
  const summary = r.findings.length === 0 ? "The reviewer found nothing to report on this diff." : r.findings.map(line).join("\n");
  const details = r.findings.map((f) => `### ${f.id} (${f.severity}) ${f.title}\n\n${f.path ? `\`${f.path}${f.line ? `:${f.line}` : ""}\`\n\n` : ""}${f.detail}`).join("\n\n");
  const annotations: Annotation[] = r.findings
    .filter((f) => f.path !== null && inDiff(f.path))
    .map((f) => ({
      path: f.path as string,
      start_line: f.line ?? 1,
      end_line: f.line ?? 1,
      annotation_level: f.severity === "blocker" ? "failure" : "notice",
      title: clean(`${f.id} ${f.title}`, 255),
      message: clean(f.detail || f.title, 60_000),
    }));
  return {
    conclusion: b > 0 ? "failure" : "success",
    title: clean(title, 255),
    summary: clean(summary, 60_000),
    text: withData(details, { v: 1, state: "done", result: r, costUsd: meta.costUsd, seconds: meta.seconds }),
    annotations,
  };
}

/** The data block shares output.text's 65,000 characters with the human tails. */
const DATA_BUDGET = 40_000;

/** Shorten tails (keeping their ends) until the record's data block fits `budget` characters. */
function fitForData(r: VerifyResult, budget: number): VerifyResult {
  let steps = r.steps.map((s) => ({ ...s }));
  for (let i = 0; i < 30 && dataBlock({ v: 1, state: "done", result: { steps } }).length > budget; i++) {
    steps = steps.map((s) => ({ ...s, tail: s.tail.length > 200 ? s.tail.slice(-Math.floor(s.tail.length * 0.6)) : s.tail }));
  }
  if (dataBlock({ v: 1, state: "done", result: { steps } }).length > budget) steps = steps.map((s) => ({ ...s, tail: "" }));
  return { steps };
}

export function encodeVerify(r: VerifyResult, meta: { seconds: number | null; note?: string }): Encoded {
  const bad = r.steps.filter((s) => s.outcome === "fail" || s.outcome === "timeout");
  const flaky = r.steps.filter((s) => s.outcome === "flaky");
  const passed = r.steps.length - bad.length;
  let title = `${passed}/${r.steps.length} passed`;
  if (bad.length > 0) title += `: ${bad.map((s) => s.name).join(", ")} failed`;
  if (flaky.length > 0) title += ` (flaky: ${flaky.map((s) => s.name).join(", ")})`;
  if (r.steps.length === 0) title = "no steps ran";
  const table = ["| step | result | seconds |", "|---|---|---|", ...r.steps.map((s) => `| ${s.name} | ${s.outcome} | ${Math.round(s.seconds)} |`)].join("\n");
  const summary = `${meta.note ? `${meta.note}\n\n` : ""}${table}`;
  // Human tails: the data block already carries them; show each failing tail, shortened to fit.
  const data: RecordData = { v: 1, state: "done", result: fitForData(r, DATA_BUDGET), seconds: meta.seconds ?? undefined };
  const room = Math.max(0, GH_TEXT_MAX - dataBlock(data).length - 500);
  const per = bad.length > 0 ? Math.floor(room / bad.length) - 40 : 0;
  const tails = bad.map((s) => `### ${s.name} (${s.outcome})\n\n\`\`\`\n${per > 0 ? s.tail.slice(-per).replace(/```/g, "ʼʼʼ") : "(see data)"}\n\`\`\``).join("\n\n");
  return {
    conclusion: isGreen(r) ? "success" : "failure",
    title: clean(title, 255),
    summary: clean(summary, 60_000),
    text: withData(tails || "All steps passed.", data),
    annotations: [],
  };
}

export function encodeFix(r: FixResult, meta: { costUsd: number | null; seconds: number }): Encoded {
  let conclusion: Encoded["conclusion"] = "neutral";
  let title = "";
  let summary = "";
  switch (r.outcome) {
    case "pushed":
      conclusion = "success";
      title = `pushed ${r.commit.slice(0, 7)}`;
      summary = `The fixer's patch passed the checks and was pushed as ${r.commit}.`;
      break;
    case "no-change":
      title = "no change";
      summary = "The fixer made no change.";
      break;
    case "disputed":
      title = "disputed";
      summary = ["The fixer disputes findings; nothing was pushed.", ...r.disputes.map((d) => `- ${d.id}: ${d.reason}`)].join("\n");
      break;
    case "rejected":
      conclusion = "failure";
      title = "rejected";
      summary = `The fixer's patch was not pushed: ${r.why}`;
      break;
    case "superseded":
      title = "superseded";
      summary = "The branch moved while the fixer worked; the patch was dropped.";
      break;
  }
  return { conclusion, title: clean(title, 255), summary: clean(summary, 60_000), text: withData(summary, { v: 1, state: "done", result: r, costUsd: meta.costUsd, seconds: meta.seconds }), annotations: [] };
}

function encodeErrored(kind: JobKind, why: ErrorWhy, detail: string): Encoded {
  const summary = `The ${ROLE[kind]} run ended without a result (${why}).${detail ? `\n\n${detail}` : ""}`;
  return {
    conclusion: "neutral",
    title: clean(`${ROLE[kind]} errored: ${why}`, 255),
    summary: clean(summary, 4000),
    text: withData(summary, { v: 1, state: "errored", why, detail: detail.slice(0, 2000) }),
    annotations: [],
  };
}

// ───────────────────────────── snapshot parsing (pure) ─────────────────────────────

const SNAPSHOT_QUERY = `
query Snapshot($owner: String!, $name: String!, $appId: Int!, $paused: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name target { oid ... on Commit { ...Runs } } }
    pullRequests(states: OPEN, first: 40, orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes {
        number title body isDraft isCrossRepository headRefName headRefOid baseRefName
        author { login }
        labels(first: 20) { nodes { name } }
        commits(last: 2) { nodes { commit { oid ...Runs } } }
      }
    }
    issues(states: OPEN, labels: [$paused], first: 1) { totalCount }
  }
}
fragment Runs on Commit {
  checkSuites(first: 5, filterBy: { appId: $appId }) {
    nodes {
      app { databaseId }
      checkRuns(first: 40, filterBy: { checkType: ALL }) {
        nodes { databaseId name externalId status conclusion startedAt completedAt title summary text }
      }
    }
  }
}`;

const MERGED_QUERY = (n: number) => `
query Merged($owner: String!, $name: String!${Array.from({ length: n }, (_, i) => `, $h${i}: String!`).join("")}) {
  repository(owner: $owner, name: $name) {${Array.from({ length: n }, (_, i) => `
    m${i}: pullRequests(headRefName: $h${i}, states: MERGED, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number baseRefName } }`).join("")}
  }
}`;

export interface RawPr {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  crossRepo: boolean;
  branch: string;
  head: Sha;
  baseRef: string;
  author: string;
  labels: readonly string[];
  /** The App's check runs on the PR's last two commits, by commit oid. */
  runs: ReadonlyMap<string, readonly RawRun[]>;
}
export interface RawSnapshot {
  trunk: { name: string; head: Sha; runs: readonly RawRun[] };
  prs: readonly RawPr[];
  paused: boolean;
}

type Json = Record<string, unknown>;
const get = (v: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Json)[k as string] : undefined), v);
const nodes = (v: unknown): unknown[] => (Array.isArray(get(v, "nodes")) ? (get(v, "nodes") as unknown[]) : []);

function runsOfCommit(commit: unknown, appId: number): RawRun[] {
  const out: RawRun[] = [];
  for (const suite of nodes(get(commit, "checkSuites"))) {
    if (get(suite, "app", "databaseId") !== appId) continue; // only the App's own records are records
    for (const r of nodes(get(suite, "checkRuns"))) {
      out.push({
        id: Number(get(r, "databaseId")),
        name: String(get(r, "name") ?? ""),
        externalId: (get(r, "externalId") as string | null) ?? null,
        status: String(get(r, "status") ?? ""),
        conclusion: (get(r, "conclusion") as string | null) ?? null,
        startedAt: (get(r, "startedAt") as string | null) ?? null,
        completedAt: (get(r, "completedAt") as string | null) ?? null,
        title: (get(r, "title") as string | null) ?? null,
        summary: (get(r, "summary") as string | null) ?? null,
        text: (get(r, "text") as string | null) ?? null,
      });
    }
  }
  return out;
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
function sha(v: unknown): Sha {
  if (typeof v !== "string" || !SHA_RE.test(v)) throw new Error(`snapshot: not an object id: ${String(v).slice(0, 80)}`);
  return v as Sha;
}

/** The GraphQL `data` object -> RawSnapshot. The only place the snapshot query's shape is known. */
export function parseSnapshot(data: unknown, appId: number): RawSnapshot {
  const repo = get(data, "repository");
  if (!repo) throw new Error("snapshot: repository not found (is the App installed?)");
  const target = get(repo, "defaultBranchRef", "target");
  const trunk = { name: String(get(repo, "defaultBranchRef", "name") ?? ""), head: sha(get(target, "oid")), runs: runsOfCommit(target, appId) };
  const prs: RawPr[] = nodes(get(repo, "pullRequests")).map((n) => {
    const runs = new Map<string, RawRun[]>();
    for (const c of nodes(get(n, "commits"))) runs.set(String(get(c, "commit", "oid")), runsOfCommit(get(c, "commit"), appId));
    return {
      number: Number(get(n, "number")),
      title: String(get(n, "title") ?? ""),
      body: String(get(n, "body") ?? ""),
      draft: get(n, "isDraft") === true,
      crossRepo: get(n, "isCrossRepository") === true,
      branch: String(get(n, "headRefName") ?? ""),
      head: sha(get(n, "headRefOid")),
      baseRef: String(get(n, "baseRefName") ?? ""),
      author: String(get(n, "author", "login") ?? ""),
      labels: nodes(get(n, "labels")).map((l) => String(get(l, "name") ?? "")),
      runs,
    };
  });
  return { trunk, prs, paused: Number(get(repo, "issues", "totalCount") ?? 0) > 0 };
}

/**
 * baseRef == trunk -> trunk; == the head branch of an open PR -> stacked; == the head branch of a merged PR
 * -> landed (retarget to that PR's base); anything else -> other.
 */
export function resolveBase(baseRef: string, trunk: string, openHeads: ReadonlyMap<string, number>, merged: ReadonlyMap<string, { pr: number; into: string }>): Base {
  if (baseRef === trunk) return { kind: "trunk" };
  const open = openHeads.get(baseRef);
  if (open !== undefined) return { kind: "stacked", on: open };
  const m = merged.get(baseRef);
  if (m) return { kind: "landed", pr: m.pr, into: m.into };
  return { kind: "other", ref: baseRef };
}

/** Build one `Pr` from the parsed node and the mirror's facts. The only place a GitHub or git shape becomes a domain type. */
export function toPr(raw: RawPr, facts: GitFacts, base: Base): Pr {
  const paths = facts.delta.paths;
  const attribution = findAttribution([
    ...facts.delta.commits.map((c) => ({ where: `commit:${c.sha.slice(0, 12)}`, text: c.message })),
    { where: "title", text: raw.title },
    { where: "body", text: raw.body },
    ...facts.delta.added.map((a) => ({ where: `diff:${a.path}`, text: a.text })),
  ]);
  const prior = facts.parent ? historyOf<ReviewResult>(raw.runs.get(facts.parent) ?? [], "review").latest : null;
  return {
    number: raw.number,
    branch: raw.branch,
    author: raw.author,
    title: raw.title,
    body: raw.body,
    draft: raw.draft,
    hold: raw.labels.includes(LABEL.hold),
    base,
    head: raw.head,
    headAt: facts.headAt,
    mergeBase: facts.mergeBase,
    landing: facts.landing,
    changed: paths,
    gatePaths: paths === "too-many" ? [] : gatePaths(paths),
    streak: facts.streak,
    attribution,
    records: recordsOf(raw.runs.get(raw.head) ?? []),
    priorReview: prior?.state === "done" ? prior.result : null,
  };
}

/**
 * Factory runs started in the last 24 h, per kind. APPROXIMATION: counted from the runs this snapshot
 * already holds (open PRs' last two commits and trunk's head). Runs on closed PRs, on commits pushed over
 * within the day, or on trunk commits other than the head are missed, so the cap can admit a few more
 * runs than `runsPerDay` after force-pushes or landings. Good enough for a spend cap; no extra query.
 */
export function usageOf(snap: RawSnapshot, now: number): World["usage"] {
  const seen = new Set<number>();
  const usage = { review: 0, verify: 0, fix: 0 };
  const all = [snap.trunk.runs, ...snap.prs.flatMap((p) => [...p.runs.values()])].flat();
  for (const r of all) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const id = parseExternalId(r.externalId);
    if (!id || id.kind === "status" || r.name !== CHECK[id.kind]) continue;
    if (now - (Date.parse(r.startedAt ?? "") || 0) <= 24 * 3600_000) usage[id.kind]++;
  }
  return usage;
}

// ───────────────────────────── commit templates and fix bounds (pure) ─────────────────────────────

/** The factory's git identity: the App's bot account, so GitHub links the commits to it. */
function factoryIdentity(policy: Policy): Identity {
  return { name: policy.app.botLogin, email: policy.app.botEmail };
}

export function landMessage(pr: Pick<Pr, "number" | "branch" | "title">, owner: string): CleanText {
  return clean(`Merge pull request #${pr.number} from ${owner}/${pr.branch}\n\n${pr.title}`);
}

/** Cleaned one-line subject + "Addresses R1, R2, test." No trailers, ever. */
export function fixMessage(subject: string, addressed: readonly string[], job: Pick<Job & { kind: "fix" }, "findings" | "failures">): CleanText {
  const first = (subject.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  const subj = clean(first, 72) || clean("Address review findings");
  const known = [...job.findings.map((f) => f.id), ...job.failures.map((s) => s.name)];
  const ids = known.filter((k) => addressed.includes(k));
  return clean(`${subj}\n\nAddresses ${(ids.length > 0 ? ids : known).join(", ")}.`);
}

/**
 * Why a fix patch may not be pushed, or null. Checks, all listed when several fail: within the PR's own
 * files, no added/deleted/renamed/retyped files or mode changes, no binary changes, added + removed lines
 * <= maxLines, no fixer-denied paths, no attribution in added lines or the message, exactly one commit by
 * the factory.
 */
export function fixBounds(delta: Delta, allowed: readonly string[], maxLines: number, who: Identity, message: string): string | null {
  const why: string[] = [];
  if (delta.paths === "too-many") return "the patch touches too many files";
  const list = (xs: readonly string[]) => `${xs.slice(0, 10).join(", ")}${xs.length > 10 ? `, and ${xs.length - 10} more` : ""}`;
  const outside = delta.paths.filter((p) => !allowed.includes(p));
  if (outside.length > 0) why.push(`changes files the PR does not change: ${list(outside)}`);
  const structural = delta.files.filter((f) => f.status !== "M" || f.modeChanged);
  if (structural.length > 0) why.push(`adds, deletes, renames or retypes files: ${list(structural.map((f) => `${f.path} (${f.modeChanged && f.status === "M" ? "mode" : f.status})`))}`);
  const binary = delta.files.filter((f) => f.added === null || f.removed === null);
  if (binary.length > 0) why.push(`binary changes: ${list(binary.map((f) => f.path))}`);
  const lines = delta.files.reduce((n, f) => n + (f.added ?? 0) + (f.removed ?? 0), 0);
  if (lines > maxLines) why.push(`changes ${lines} lines (limit ${maxLines})`);
  const denied = fixerViolations(delta.paths);
  if (denied.length > 0) why.push(`touches paths the fixer may not change: ${list(denied)}`);
  const attribution = findAttribution([...delta.added.map((a) => ({ where: `diff:${a.path}`, text: a.text })), { where: "message", text: message }]);
  if (attribution.length > 0) why.push(`attribution in ${list(attribution)}`);
  const ident = `${who.name} <${who.email}>`;
  if (delta.commits.length !== 1 || delta.commits[0]?.committer !== ident || delta.commits[0]?.author !== ident) why.push("the fix is not exactly one commit by the factory");
  return why.length > 0 ? why.join("; ") : null;
}

// ───────────────────────────── App auth ─────────────────────────────

interface Token {
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
}

const API = "https://api.github.com";
const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** RS256 JWT with node:crypto -> installation token (1 h). The key is read here and nowhere else. */
async function mintInstallationToken(policy: Policy): Promise<Token> {
  const key = await readFile(policy.app.keyFile, "utf8");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: policy.app.id }))}`;
  const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")}`;
  const res = await fetch(`${API}/app/installations/${policy.app.installation}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "factory" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`installation token: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { token: string; expires_at: string; permissions: Record<string, string> };
  return { token: j.token, expiresAt: Date.parse(j.expires_at), permissions: j.permissions ?? {} };
}

function gitAuth(token: string): Auth {
  return { header: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` } as Auth;
}

/** For `doctor`: mint a token and report what the installation can do, and the bot account's user id. */
export async function checkApp(policy: Policy): Promise<{ permissions: Record<string, string>; botUserId: number | null }> {
  const t = await mintInstallationToken(policy);
  const res = await fetch(`${API}/users/${encodeURIComponent(policy.app.botLogin)}`, {
    headers: { authorization: `token ${t.token}`, accept: "application/vnd.github+json", "user-agent": "factory" },
    signal: AbortSignal.timeout(30_000),
  });
  const botUserId = res.ok ? Number(((await res.json()) as { id?: number }).id ?? 0) || null : null;
  return { permissions: t.permissions, botUserId };
}

// ───────────────────────────── the remote ─────────────────────────────

interface StatusView {
  head: Sha;
  run: { id: number; status: string; conclusion: string | null; title: string; summary: string } | null;
  commented: Set<string>;
}

export async function connect(policy: Policy, opts: ConnectOptions = {}): Promise<Remote> {
  const { owner, name } = policy.repo;
  const repoPath = `/repos/${owner}/${name}`;
  const trunkName = policy.rules.trunk;
  const me = factoryIdentity(policy);
  const mirror: Mirror = openMirror(policy.mirrorDir, policy.worktreeRoot, policy.runUser, `https://github.com/${owner}/${name}.git`);
  const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

  let cached: Token | null = null;
  const token = async (): Promise<string> => {
    if (!cached || cached.expiresAt - 5 * 60_000 < Date.now()) cached = await mintInstallationToken(policy);
    return cached.token;
  };
  const auth = async (): Promise<Auth> => gitAuth(await token());

  const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    if (opts.readOnly && method !== "GET" && path !== "/graphql") throw new Error(`read-only: refusing ${method} ${path}`);
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `token ${await token()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "factory", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
    return (res.status === 204 ? null : await res.json()) as T;
  };
  const graphql = async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
    const j = await api<{ data?: unknown; errors?: { message: string }[] }>("POST", "/graphql", { query, variables });
    if (j.errors?.length) throw new Error(`graphql: ${j.errors.map((e) => e.message).join("; ").slice(0, 500)}`);
    return j.data;
  };

  // ── private view, refreshed by every snapshot ──
  let statusView = new Map<number, StatusView>();
  let runningRuns = new Map<string, number[]>(); // "<commit> <check name>" -> in_progress run ids
  let staleStatus: number[] = []; // `factory` runs in_progress on commits that are no longer the head
  let landedOpen: { pr: number; head: Sha; trunk: Sha }[] = [];

  // ── check-run writes ──
  const createRun = (body: Record<string, unknown>) => api<{ id: number }>("POST", `${repoPath}/check-runs`, body);
  const patchRun = (id: number, body: Record<string, unknown>) => api("PATCH", `${repoPath}/check-runs/${id}`, body);

  const complete = async (id: number, enc: Encoded, extra: Record<string, unknown> = {}) => {
    const first = enc.annotations.slice(0, 50);
    await patchRun(id, {
      status: "completed",
      conclusion: enc.conclusion,
      completed_at: new Date().toISOString(),
      output: { title: enc.title, summary: enc.summary, text: enc.text, ...(first.length > 0 ? { annotations: first } : {}) },
      ...extra,
    });
    for (let i = 50; i < enc.annotations.length; i += 50) {
      await patchRun(id, { output: { title: enc.title, summary: enc.summary, annotations: enc.annotations.slice(i, i + 50) } });
    }
  };

  const prUrl = (n: number) => `https://github.com/${owner}/${name}/pull/${n}`;

  /** Make the `factory` check run on `head` show exactly this. Writes only on change. */
  const writeStatus = async (pr: number, head: Sha, want: { status: "in_progress" | "completed"; conclusion: string | null; title: CleanText; summary: CleanText }, commented: Set<string>) => {
    const view = statusView.get(pr);
    const cur = view && view.head === head ? view.run : null;
    const prevCommented = view && view.head === head ? view.commented : new Set<string>();
    const same =
      cur &&
      cur.title === want.title &&
      cur.summary === want.summary &&
      (want.status === "completed" ? cur.status === "COMPLETED" && cur.conclusion?.toLowerCase() === want.conclusion : cur.status !== "COMPLETED") &&
      [...commented].every((c) => prevCommented.has(c));
    if (same) return;
    const text = withData("Status line of the factory for this head.", { v: 1, state: "status", commented: [...commented] });
    const output = { title: want.title, summary: want.summary, text };
    const fields: Record<string, unknown> =
      want.status === "completed"
        ? { status: "completed", conclusion: want.conclusion, completed_at: new Date().toISOString(), details_url: prUrl(pr), output }
        : { status: "in_progress", details_url: prUrl(pr), output };
    let id: number;
    if (cur && cur.status !== "COMPLETED") {
      id = cur.id;
      await patchRun(id, fields);
    } else {
      id = (await createRun({ name: CHECK.status, head_sha: head, external_id: externalId("status", head), started_at: new Date().toISOString(), ...fields })).id;
    }
    statusView.set(pr, {
      head,
      run: { id, status: want.status === "completed" ? "COMPLETED" : "IN_PROGRESS", conclusion: want.conclusion?.toUpperCase() ?? null, title: want.title, summary: want.summary },
      commented: new Set(commented),
    });
  };

  // ── the read path ──

  async function snapshot(): Promise<World> {
    const now = Date.now();
    await mirror.fetch(await auth());
    const snap = parseSnapshot(await graphql(SNAPSHOT_QUERY, { owner, name, appId: policy.app.id, paused: LABEL.paused }), policy.app.id);
    if (snap.trunk.name !== trunkName) throw new Error(`default branch is ${snap.trunk.name}, config says ${trunkName}`);

    // GitHub can be a moment ahead of the fetch: fetch once more, then skip what is still missing.
    const ours = snap.prs.filter((p) => !p.crossRepo && p.author === policy.rules.owner);
    const missing = async () => (await Promise.all([snap.trunk.head, ...ours.map((p) => p.head)].map(async (s) => ((await mirror.has(s)) ? null : s)))).filter((s) => s !== null);
    if ((await missing()).length > 0) await mirror.fetch(await auth());
    const stillMissing = new Set(await missing());
    if (stillMissing.has(snap.trunk.head)) throw new Error(`trunk head ${snap.trunk.head} not in the mirror after fetch`);

    // Bases that are neither trunk nor an open PR's head: ask whether a merged PR had that head.
    const openHeads = new Map(snap.prs.filter((p) => !p.crossRepo).map((p) => [p.branch, p.number] as const));
    const unknownBases = [...new Set(ours.map((p) => p.baseRef).filter((b) => b !== trunkName && !openHeads.has(b)))];
    const merged = new Map<string, { pr: number; into: string }>();
    if (unknownBases.length > 0) {
      const vars: Record<string, unknown> = { owner, name };
      unknownBases.forEach((b, i) => (vars[`h${i}`] = b));
      const d = await graphql(MERGED_QUERY(unknownBases.length), vars);
      unknownBases.forEach((b, i) => {
        const n = nodes(get(d, "repository", `m${i}`))[0];
        if (n) merged.set(b, { pr: Number(get(n, "number")), into: String(get(n, "baseRefName") ?? "") });
      });
    }

    const trunkHead = snap.trunk.head;
    const trunk: Trunk = { name: trunkName, head: trunkHead, tree: await mirror.treeOf(trunkHead), verify: historyOf<VerifyResult>(snap.trunk.runs, "verify") };

    const prs: Pr[] = [];
    const landed: { pr: number; head: Sha; trunk: Sha }[] = [];
    for (const raw of ours) {
      if (stillMissing.has(raw.head)) {
        log(`#${raw.number}: head ${raw.head.slice(0, 7)} not fetched yet; skipped this tick`);
        continue;
      }
      try {
        if (await mirror.isAncestor(raw.head, trunkHead)) {
          landed.push({ pr: raw.number, head: raw.head, trunk: trunkHead });
          continue;
        }
        const facts = await mirror.facts(trunkHead, raw.baseRef, raw.head, me);
        prs.push(toPr(raw, facts, resolveBase(raw.baseRef, trunkName, openHeads, merged)));
      } catch (e) {
        log(`#${raw.number}: skipped this tick: ${String(e)}`);
      }
    }

    // Private view for act/start.
    statusView = new Map();
    runningRuns = new Map();
    staleStatus = [];
    const indexRunning = (commit: string, runs: readonly RawRun[]) => {
      for (const r of runs) {
        if (r.status === "COMPLETED") continue;
        const k = `${commit} ${r.name}`;
        runningRuns.set(k, [...(runningRuns.get(k) ?? []), r.id]);
      }
    };
    indexRunning(trunkHead, snap.trunk.runs);
    for (const raw of snap.prs) {
      for (const [commit, runs] of raw.runs) {
        indexRunning(commit, runs);
        const statusRuns = runs.filter((r) => r.name === CHECK.status && parseExternalId(r.externalId)?.kind === "status").sort((a, b) => a.id - b.id);
        const latest = statusRuns.at(-1);
        if (commit === raw.head) {
          // Older in_progress status runs on the head are leftovers; only the latest is the status line.
          staleStatus.push(...statusRuns.slice(0, -1).filter((r) => r.status !== "COMPLETED").map((r) => r.id));
          const d = readData(latest?.text);
          statusView.set(raw.number, {
            head: raw.head,
            run: latest ? { id: latest.id, status: latest.status, conclusion: latest.conclusion, title: latest.title ?? "", summary: latest.summary ?? "" } : null,
            commented: new Set(d?.state === "status" ? d.commented : []),
          });
        } else {
          staleStatus.push(...statusRuns.filter((r) => r.status !== "COMPLETED").map((r) => r.id));
        }
      }
    }
    landedOpen = landed;
    if (!opts.readOnly) await tidy();

    return { now, paused: snap.paused, trunk, prs, usage: usageOf(snap, now) };
  }

  /** Writes the facts just read already decided. Idempotent. */
  async function tidy(): Promise<void> {
    for (const id of staleStatus) {
      await patchRun(id, { status: "completed", conclusion: "neutral", completed_at: new Date().toISOString(), output: { title: clean("superseded"), summary: clean("A newer head replaced this commit.") } }).catch((e) => log(`tidy ${id}: ${String(e)}`));
    }
    for (const l of landedOpen) {
      log(`#${l.pr}: head ${l.head.slice(0, 7)} is in ${trunkName} but the PR is still open; completing its status`);
      await writeStatus(l.pr, l.head, { status: "completed", conclusion: "success", title: clean("merged"), summary: clean(`This head is in ${trunkName} (${l.trunk.slice(0, 7)}).`) }, statusView.get(l.pr)?.commented ?? new Set()).catch((e) => log(`tidy #${l.pr}: ${String(e)}`));
    }
  }

  // ── the write paths ──

  async function act(pr: Pr, step: Step & { kind: "track" }): Promise<void> {
    if (opts.readOnly) throw new Error("read-only remote");
    const r = render(step.status, pr);
    const view = statusView.get(pr.number);
    const commented = new Set(view && view.head === pr.head ? view.commented : []);
    if (step.status.phase === "handed-off" && r.comment) {
      const code = step.status.code;
      if (!commented.has(code)) {
        await api("POST", `${repoPath}/issues/${pr.number}/comments`, { body: clean(r.comment) });
        commented.add(code);
      }
    }
    const handedOff = step.status.phase === "handed-off";
    await writeStatus(pr.number, pr.head, { status: handedOff ? "completed" : "in_progress", conclusion: handedOff ? "action_required" : null, title: clean(r.title, 255), summary: clean(r.summary, 60_000) }, commented);

    if (step.act?.kind === "retarget") {
      log(`#${pr.number}: retarget to ${step.act.to}`);
      await api("PATCH", `${repoPath}/pulls/${pr.number}`, { base: step.act.to });
    } else if (step.act?.kind === "merge") {
      await land(step.act.ticket, pr);
    }
  }

  /**
   * Land a PR. The only code that writes to trunk.
   *  1. message from the template, cleaned; 2. merge commit = ticket.tree with parents [trunk, head];
   *  3. re-validate (tree equality, attribution in the message); 4. push trunk with a lease on ticket.trunk;
   *  5. copy the head's verify record onto the merge commit (trunk is verified by construction);
   *  6. complete the `factory` check on the head: "Merged as <sha>".
   * If GitHub does not mark the PR merged, the next snapshot sees its head in trunk and completes it.
   */
  async function land(ticket: MergeTicket, pr: Pr): Promise<void> {
    if (ticket.pr !== pr.number || ticket.head !== pr.head) throw new Error(`ticket for #${ticket.pr}@${ticket.head} does not match #${pr.number}@${pr.head}`);
    const message = landMessage(pr, owner);
    const hits = findAttribution([{ where: "message", text: message }]);
    if (hits.length > 0) throw new Error(`land #${pr.number}: attribution in the merge message`);
    const m = await mirror.commit(ticket.tree, [ticket.trunk, ticket.head], message, me);
    if ((await mirror.treeOf(m)) !== ticket.tree) throw new Error(`land #${pr.number}: merge commit tree differs from the verified tree`);
    const pushed = await mirror.push(await auth(), `refs/heads/${trunkName}`, ticket.trunk, m);
    if (pushed === "moved") {
      log(`#${pr.number}: ${trunkName} moved during landing; re-planning next tick`);
      return;
    }
    log(`#${pr.number}: landed as ${m}`);
    const v = pr.records.verify.latest;
    if (v?.state === "done" && v.key === ticket.tree) {
      const enc = encodeVerify(v.result, { seconds: null, note: `Verified before landing, as the landing tree of #${pr.number} (head ${pr.head.slice(0, 7)}).` });
      await createRun({ name: CHECK.verify, head_sha: m, external_id: externalId("verify", ticket.tree), status: "completed", conclusion: enc.conclusion, started_at: new Date().toISOString(), completed_at: new Date().toISOString(), output: { title: enc.title, summary: enc.summary, text: enc.text } });
    }
    const view = statusView.get(pr.number);
    await writeStatus(pr.number, pr.head, { status: "completed", conclusion: "success", title: clean("merged"), summary: clean(`Merged as ${m}.`) }, view?.commented ?? new Set());
  }

  /** Validate, commit and push one fix. Never pushes anything but a single factory commit on the leased head. */
  async function recordFix(job: Job & { kind: "fix" }, out: FixOut, tree: Sha | null): Promise<FixResult> {
    if (out.disputed.length > 0) return { outcome: "disputed", disputes: out.disputed.map((d) => ({ id: clean(d.id, 40), reason: clean(d.reason, 2000) })) };
    if (tree === null || tree === (await mirror.treeOf(job.head))) return { outcome: "no-change" };
    if (policy.rules.stage === "review") return { outcome: "rejected", why: "autofix is off (stage: review)" };
    const message = fixMessage(out.subject, out.addressed, job);
    const f = await mirror.commit(tree, [job.head], message, me);
    const why = fixBounds(await mirror.inspect(job.head, f), job.allowedPaths, policy.maxFixLines, me, message);
    if (why) return { outcome: "rejected", why: clean(why, 4000) };
    const pushed = await mirror.push(await auth(), `refs/heads/${job.branch}`, job.head, f);
    return pushed === "moved" ? { outcome: "superseded" } : { outcome: "pushed", commit: f };
  }

  /** Commit, record key and check name for a job. */
  const targetOf = (job: Job): { commit: Sha; key: Sha } => {
    switch (job.kind) {
      case "review":
        return { commit: job.head, key: job.mergeBase };
      case "verify":
        return "trunk" in job.on ? { commit: job.on.trunk, key: job.tree } : { commit: job.on.head, key: job.tree };
      case "fix":
        return { commit: job.head, key: job.head };
    }
  };
  const describe = (job: Job) => ("pr" in job ? `#${job.pr}` : "trunk" in job.on ? trunkName : `#${job.on.pr}`);

  async function record(job: Job, id: number, out: Output<Job>): Promise<void> {
    switch (job.kind) {
      case "review": {
        const o = out as AgentOutcome<ReviewOut>;
        if (!o.ok) return complete(id, encodeErrored("review", o.why, o.detail));
        const result = numberFindings(o.out);
        const d = await mirror.inspect(job.mergeBase, job.head);
        const inDiff = (p: string) => d.paths !== "too-many" && d.paths.includes(p);
        log(`${describe(job)} review: ${result.findings.length} findings, cost ${o.costUsd ?? "?"} USD`);
        return complete(id, encodeReview(result, inDiff, { costUsd: o.costUsd, seconds: o.seconds }));
      }
      case "verify": {
        const o = out as VerifyOut;
        if (o.kind === "infra") return complete(id, encodeErrored("verify", "infra", o.detail));
        await complete(id, encodeVerify(o.result, { seconds: o.result.steps.reduce((s, x) => s + x.seconds, 0) }));
        log(`${describe(job)} verify: ${isGreen(o.result) ? "green" : "red"}`);
        if ("trunk" in job.on && !isGreen(o.result)) {
          const failed = o.result.steps.filter((s) => s.outcome === "fail" || s.outcome === "timeout").map((s) => s.name);
          await api("POST", `${repoPath}/commits/${job.on.trunk}/comments`, {
            body: clean(`The factory suite failed on ${trunkName} at ${job.on.trunk.slice(0, 7)} on its host: ${failed.join(", ")}. Fixes are paused everywhere until ${trunkName} is green; details are in the factory/verify check on this commit.`),
          });
        }
        return;
      }
      case "fix": {
        const o = out as AgentOutcome<FixOut> & { tree: Sha | null };
        if (!o.ok) return complete(id, encodeErrored("fix", o.why, o.detail));
        const result = await recordFix(job, o.out, o.tree);
        log(`${describe(job)} fix: ${result.outcome}${result.outcome === "rejected" ? ` (${result.why})` : ""}, cost ${o.costUsd ?? "?"} USD`);
        return complete(id, encodeFix(result, { costUsd: o.costUsd, seconds: o.seconds }));
      }
    }
  }

  async function start<J extends Job>(job: J, work: Work): Promise<{ done: Promise<void> }> {
    if (opts.readOnly) throw new Error("read-only remote");
    const { commit, key } = targetOf(job);
    const checkName = CHECK[job.kind];
    for (const stale of runningRuns.get(`${commit} ${checkName}`) ?? []) {
      await complete(stale, encodeErrored(job.kind, "abandoned", "The daemon stopped while this run was in progress.")).catch((e) => log(`abandon ${stale}: ${String(e)}`));
    }
    runningRuns.delete(`${commit} ${checkName}`);
    const { id } = await createRun({
      name: checkName,
      head_sha: commit,
      external_id: externalId(job.kind, key),
      status: "in_progress",
      started_at: new Date().toISOString(),
      output: { title: clean("running"), summary: clean(`The ${ROLE[job.kind]} is running.`) },
    });
    log(`${describe(job)} ${job.kind}: started (check run ${id})`);
    const done = (async () => {
      try {
        const out = await work(job);
        await record(job, id, out as Output<Job>);
      } catch (e) {
        log(`${describe(job)} ${job.kind}: crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        await complete(id, encodeErrored(job.kind, "crashed", "")).catch((e2) => log(`record ${id}: ${String(e2)}`));
      }
    })();
    return { done };
  }

  return { snapshot, act, start };
}

export type { RecordKind };
