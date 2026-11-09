/**
 * decide.ts — every decision the factory makes, and nothing else.
 *
 * PURE: no I/O, no clock, no imports. `boundaries.test.ts` enforces it.
 * Input is a `World` (facts read from GitHub and the local git mirror in one tick); output is a `Plan`.
 * The merge conditions exist only in `mergeDecision`; `nextStep` maps unmet conditions to remedies.
 *
 * Read main.ts for the loop and github.ts for the effects. Nothing else holds flow.
 */

// ───────────────────────────── identities ─────────────────────────────

declare const shaBrand: unique symbol;
/** A git object id (commit or tree). Only the snapshot parser and the mirror mint these. */
export type Sha = string & { readonly [shaBrand]: true };

export type JobKind = "review" | "verify" | "fix";
type Lane = "read" | "exec";
/** `read` = an LLM over a read-only checkout; `exec` = anything that runs repo code or Chrome. */
const LANE: { readonly [K in JobKind]: Lane } = { review: "read", verify: "exec", fix: "exec" };

/** Trust dial. `review`: post reviews and checks, hand everything off. `fix`: also push fixes. `merge`: also land. */
export type Stage = "review" | "fix" | "merge";

// ───────────────────────────── records (what the factory wrote on GitHub) ─────────────────────────────

export interface Finding {
  id: string; // "R1", "R2", ... assigned by the factory, stable within one review
  path: string | null;
  line: number | null;
  severity: "blocker" | "nit"; // only blockers drive fixes or block merges
  title: string;
  detail: string;
}
/** A review passes iff it has no blocker. There is deliberately no "verdict" field to disagree with. */
export interface ReviewResult {
  findings: readonly Finding[];
}

export type StepOutcome = "pass" | "flaky" | "fail" | "timeout"; // flaky = failed once, passed on the re-run
export interface StepResult {
  name: string;
  outcome: StepOutcome;
  seconds: number;
  tail: string; // "" unless failed
}
/** Green iff every step is pass or flaky. */
export interface VerifyResult {
  steps: readonly StepResult[];
}

export type FixResult =
  | { outcome: "pushed"; commit: Sha }
  | { outcome: "no-change" }
  | { outcome: "disputed"; disputes: readonly { id: string; reason: string }[] }
  | { outcome: "rejected"; why: string } // protected path, bounds or attribution in the patch; nothing pushed
  | { outcome: "superseded" }; // lease lost: the branch moved while fixing

export type ErrorWhy = "unavailable" | "timeout" | "crashed" | "bad-output" | "interrupted" | "abandoned" | "infra";

/**
 * One factory run, as recorded by a check run on a commit. `key` is what exactly it judged:
 * review -> merge base, verify -> landing tree, fix -> head. A run whose key isn't the current one doesn't count.
 */
export type Run<R> =
  | { state: "running"; key: Sha; startedAt: number }
  | { state: "done"; key: Sha; at: number; result: R }
  | { state: "errored"; key: Sha; at: number; why: ErrorWhy };

export interface History<R> {
  latest: Run<R> | null;
  /** Errored runs on this commit with the same key as `latest`, excluding `unavailable` and `interrupted`. */
  errors: number;
}

export interface Records {
  review: History<ReviewResult>;
  verify: History<VerifyResult>;
  fix: History<FixResult>;
}

export const NO_RECORDS: Records = {
  review: { latest: null, errors: 0 },
  verify: { latest: null, errors: 0 },
  fix: { latest: null, errors: 0 },
};

// ───────────────────────────── the world (facts of one tick) ─────────────────────────────

export type Base =
  | { kind: "trunk" }
  | { kind: "stacked"; on: number } // base is the head branch of open PR #on
  | { kind: "landed"; pr: number; into: string } // base is the head branch of merged PR #pr; retarget to `into`
  | { kind: "other"; ref: string }; // not ours to merge

/** What `main` would become: `git merge-tree --write-tree <trunk head> <pr head>`. */
export type Landing = { kind: "clean"; tree: Sha } | { kind: "conflict"; paths: readonly string[] };

export interface Pr {
  number: number;
  branch: string;
  author: string;
  title: string; // untrusted: only ever placed in a data block of an agent prompt
  body: string; // untrusted
  draft: boolean;
  hold: boolean; // label factory:hold
  base: Base;
  head: Sha;
  /** Committer timestamp of `head` (epoch ms). A head younger than `settleMs` gets no job. */
  headAt: number;
  /** merge-base(base branch, head). The review covers exactly mergeBase..head. */
  mergeBase: Sha;
  landing: Landing;
  /** Paths changed in mergeBase..head; "too-many" when the list was truncated. */
  changed: readonly string[] | "too-many";
  /** Derived from PATHS by the snapshot: changed paths the owner must merge by hand. */
  gatePaths: readonly string[];
  /** Factory-authored commits on top of the last commit the factory did not make. Owner push -> 0. */
  streak: number;
  /** Where tool attribution was found: "commit:<sha>", "title", "body", "diff:<path>". */
  attribution: readonly string[];
  records: Records; // on `head`
  /** The review on head^ when head is a factory fix commit: what the re-review must confirm resolved. */
  priorReview: ReviewResult | null;
}

export interface Trunk {
  name: string;
  head: Sha;
  tree: Sha;
  verify: History<VerifyResult>; // on `head`, keyed by `tree`
}

export interface World {
  now: number; // the only clock decide.ts sees
  paused: boolean; // any open issue labeled factory:paused
  trunk: Trunk;
  prs: readonly Pr[];
  /** Factory runs started in the last 24 hours, per kind (derived from check runs, not counted locally). */
  usage: { readonly [K in JobKind]: number };
}

/** The part of the config decide.ts needs. policy.ts embeds it after validation. */
export interface Rules {
  owner: string;
  trunk: string;
  stage: Stage;
  maxFixes: number; // factory commits in a row before handing off
  maxErrors: number; // errored runs per (kind, key) before handing off
  runsPerDay: { readonly [K in JobKind]: number };
  timeoutMs: { readonly [K in JobKind]: number }; // a running record older than timeout + graceMs is abandoned
  graceMs: number;
  backoffMs: number; // after an `unavailable` run
  settleMs: number; // a new head must be this old before any job starts on it
}

// ───────────────────────────── the gate ─────────────────────────────

export interface MergeInput {
  owner: string;
  author: string;
  draft: boolean;
  hold: boolean;
  base: Base;
  head: Sha;
  mergeBase: Sha;
  trunkHead: Sha;
  landing: Landing;
  review: Run<ReviewResult> | null; // the latest factory/review on head
  verify: Run<VerifyResult> | null; // the latest factory/verify on head
  gatePaths: readonly string[];
  tooLarge: boolean;
  attribution: readonly string[];
}

export type Unmet =
  | { why: "not-owner" }
  | { why: "draft" }
  | { why: "hold" }
  | { why: "not-on-trunk"; base: Base }
  | { why: "conflict"; paths: readonly string[] }
  | { why: "attribution"; where: readonly string[] }
  | { why: "too-large" }
  | { why: "gate-paths"; paths: readonly string[] }
  | { why: "review-missing" } // none, or keyed to another merge base (a push or a base change happened)
  | { why: "review-running"; since: number }
  | { why: "review-errored"; cause: ErrorWhy }
  | { why: "review-blockers"; findings: readonly Finding[] }
  | { why: "verify-missing" } // none, or keyed to another landing tree (main or head moved)
  | { why: "verify-running"; since: number }
  | { why: "verify-errored"; cause: ErrorWhy }
  | { why: "verify-failed"; steps: readonly StepResult[] };

declare const ticketBrand: unique symbol;
/**
 * Permission to land exactly this head as exactly this tree on exactly this trunk commit.
 * Only `mergeDecision` constructs one; `github.ts` `land()` is its only consumer.
 */
export interface MergeTicket {
  readonly pr: number;
  readonly head: Sha;
  readonly trunk: Sha; // lease for the push to main
  readonly tree: Sha; // the verified landing tree; the merge commit must have this tree
  readonly [ticketBrand]: true;
}

export type MergeDecision = { ok: true; ticket: MergeTicket } | { ok: false; unmet: readonly [Unmet, ...Unmet[]] };

export function isGreen(r: VerifyResult): boolean {
  return r.steps.length > 0 && r.steps.every((s) => s.outcome === "pass" || s.outcome === "flaky");
}

export function blockers(r: ReviewResult): Finding[] {
  return r.findings.filter((f) => f.severity === "blocker");
}

/**
 * THE merge gate. Pure, table-tested. Lists every unmet condition (not just the first) so the
 * status line and `factory plan --pr N` can show the whole picture.
 *
 * Merge iff: author == owner, not draft, no hold, base is trunk, landing is clean,
 *   review done && review.key == mergeBase && no blocker,
 *   verify done && verify.key == landing.tree && every step pass|flaky,
 *   no gate paths, path list complete, no attribution anywhere.
 *
 * Head equality is structural: `review` and `verify` are read from check runs on `head` itself.
 */
export function mergeDecision(input: MergeInput, pr = 0): MergeDecision {
  const unmet: Unmet[] = [];
  if (input.author !== input.owner) unmet.push({ why: "not-owner" });
  if (input.draft) unmet.push({ why: "draft" });
  if (input.hold) unmet.push({ why: "hold" });
  if (input.base.kind !== "trunk") unmet.push({ why: "not-on-trunk", base: input.base });
  if (input.landing.kind === "conflict") unmet.push({ why: "conflict", paths: input.landing.paths });
  if (input.attribution.length > 0) unmet.push({ why: "attribution", where: input.attribution });
  if (input.tooLarge) unmet.push({ why: "too-large" });
  if (input.gatePaths.length > 0) unmet.push({ why: "gate-paths", paths: input.gatePaths });

  const review = input.review;
  if (!review || review.key !== input.mergeBase) unmet.push({ why: "review-missing" });
  else if (review.state === "running") unmet.push({ why: "review-running", since: review.startedAt });
  else if (review.state === "errored") unmet.push({ why: "review-errored", cause: review.why });
  else {
    const b = blockers(review.result);
    if (b.length > 0) unmet.push({ why: "review-blockers", findings: b });
  }

  const verify = input.verify;
  if (input.landing.kind !== "clean" || !verify || verify.key !== input.landing.tree) unmet.push({ why: "verify-missing" });
  else if (verify.state === "running") unmet.push({ why: "verify-running", since: verify.startedAt });
  else if (verify.state === "errored") unmet.push({ why: "verify-errored", cause: verify.why });
  else if (!isGreen(verify.result)) unmet.push({ why: "verify-failed", steps: verify.result.steps.filter((s) => s.outcome === "fail" || s.outcome === "timeout") });

  if (unmet.length > 0) return { ok: false, unmet: unmet as [Unmet, ...Unmet[]] };
  const landing = input.landing as { kind: "clean"; tree: Sha };
  const ticket = { pr, head: input.head, trunk: input.trunkHead, tree: landing.tree } as MergeTicket;
  return { ok: true, ticket };
}

/** Projection from the world. Kept separate so tests can build a MergeInput directly. */
export function mergeInputOf(pr: Pr, trunk: Trunk, rules: Rules): MergeInput {
  return {
    owner: rules.owner,
    author: pr.author,
    draft: pr.draft,
    hold: pr.hold,
    base: pr.base,
    head: pr.head,
    mergeBase: pr.mergeBase,
    trunkHead: trunk.head,
    landing: pr.landing,
    review: pr.records.review.latest,
    verify: pr.records.verify.latest,
    gatePaths: pr.gatePaths,
    tooLarge: pr.changed === "too-many",
    attribution: pr.attribution,
  };
}

// ───────────────────────────── steps ─────────────────────────────

export type Job =
  | { kind: "review"; pr: number; head: Sha; mergeBase: Sha; prior: ReviewResult | null; title: string; body: string }
  | { kind: "verify"; on: { pr: number; head: Sha } | { trunk: Sha }; tree: Sha }
  | {
      kind: "fix";
      pr: number;
      branch: string;
      head: Sha; // lease for the push
      attempt: number; // streak + 1, for the status line and the commit body
      findings: readonly Finding[]; // review blockers on head
      failures: readonly StepResult[]; // failing steps of the verify on head (tails included)
      /** Paths the PR itself changed: the only files a fix may modify. */
      allowedPaths: readonly string[];
      title: string;
      body: string;
    };

export type HandOff =
  | "conflict"
  | "attribution"
  | "too-large"
  | "gate-paths"
  | "reviewer-failing"
  | "verify-failing"
  | "fix-exhausted"
  | "fix-no-change"
  | "fix-disputed"
  | "fix-rejected"
  | "fix-failing"
  | "autofix-off" // stage == review and there are problems
  | "ready"; // stage < merge and everything is clean: the owner merges

export type Status =
  | { phase: "working"; note: string; unmet: readonly Unmet[] }
  | { phase: "waiting"; note: string; unmet: readonly Unmet[] }
  | { phase: "handed-off"; code: HandOff; unmet: readonly Unmet[]; detail: FixResult | null }
  | { phase: "landing" };

export type Act = { kind: "retarget"; to: string } | { kind: "merge"; ticket: MergeTicket };

export type Step =
  | { kind: "ignore" } // not the factory's PR: write nothing
  | { kind: "track"; status: Status; act: Act | null; want: readonly Job[] };

type Tracked = Step & { kind: "track" };

const working = (note: string, unmet: readonly Unmet[]): Tracked => ({ kind: "track", status: { phase: "working", note, unmet }, act: null, want: [] });
const waiting = (note: string, unmet: readonly Unmet[]): Tracked => ({ kind: "track", status: { phase: "waiting", note, unmet }, act: null, want: [] });
const handOff = (code: HandOff, unmet: readonly Unmet[], detail: FixResult | null = null): Tracked => ({
  kind: "track",
  status: { phase: "handed-off", code, unmet, detail },
  act: null,
  want: [],
});

/** What `nextStep` concludes about one record kind on the current key. */
type Need =
  | { need: "none" } // done and usable
  | { need: "run" } // missing, stale, abandoned, or errored below the cap
  | { need: "running"; since: number }
  | { need: "backoff"; until: number } // unavailable recently
  | { need: "give-up"; cause: ErrorWhy }; // errored at the cap

function needOf<R>(h: History<R>, key: Sha, kind: JobKind, rules: Rules, now: number): Need {
  const r = h.latest;
  if (!r || r.key !== key) return { need: "run" };
  if (r.state === "done") return { need: "none" };
  if (r.state === "running") {
    const stale = now - r.startedAt > rules.timeoutMs[kind] + rules.graceMs;
    return stale ? (h.errors + 1 >= rules.maxErrors ? { need: "give-up", cause: "abandoned" } : { need: "run" }) : { need: "running", since: r.startedAt };
  }
  if (r.why === "unavailable" || r.why === "interrupted") {
    const until = r.at + rules.backoffMs;
    return now < until ? { need: "backoff", until } : { need: "run" };
  }
  return h.errors >= rules.maxErrors ? { need: "give-up", cause: r.why } : { need: "run" };
}

/**
 * What to do with one PR. Remedy order (first match wins), after `mergeDecision` says no:
 *  0. ineligible (not-owner | draft | base other)                 -> ignore
 *  1. hold                                                        -> waiting (status only)
 *  2. paused                                                      -> waiting
 *  3. base landed                                                 -> retarget
 *  4. conflict | attribution | too-large                          -> hand off (before any spend)
 *  5. head younger than settleMs                                  -> waiting
 *  6. review missing/stale/errored, verify missing/stale/errored  -> want review and/or verify
 *     (errors >= maxErrors -> hand off; unavailable within backoff -> waiting; running && stale -> want again)
 *  7. review or verify still running                              -> working
 *  8. blockers or failed steps:
 *       trunk red && verify failed  -> waiting ("main is red")
 *       stage == review             -> hand off autofix-off
 *       fix on head: running -> working; done(no-change|disputed|rejected) -> hand off; superseded -> waiting
 *       fix errors >= maxErrors     -> hand off fix-failing
 *       streak >= maxFixes          -> hand off fix-exhausted
 *       otherwise                   -> want fix
 *  9. stacked                                                     -> waiting ("stacked on #N")
 * 10. gate paths                                                  -> hand off gate-paths
 * When `mergeDecision` says yes: stage == merge -> act merge; otherwise hand off "ready".
 */
export function nextStep(pr: Pr, world: World, rules: Rules): Step {
  const decision = mergeDecision(mergeInputOf(pr, world.trunk, rules), pr.number);
  if (decision.ok) {
    if (world.paused) return waiting("paused", []);
    if (rules.stage === "merge") return { kind: "track", status: { phase: "landing" }, act: { kind: "merge", ticket: decision.ticket }, want: [] };
    return handOff("ready", []);
  }
  const unmet = decision.unmet;
  const has = <W extends Unmet["why"]>(why: W): Extract<Unmet, { why: W }> | undefined =>
    unmet.find((u): u is Extract<Unmet, { why: W }> => u.why === why);

  // 0. not ours
  if (has("not-owner") || has("draft") || pr.base.kind === "other") return { kind: "ignore" };
  // 1-2. owner switches
  if (has("hold")) return waiting("on hold (factory:hold)", unmet);
  if (world.paused) return waiting("paused", unmet);
  // 3. base landed
  if (pr.base.kind === "landed") return { kind: "track", status: { phase: "working", note: `retargeting to ${pr.base.into}`, unmet }, act: { kind: "retarget", to: pr.base.into }, want: [] };
  // 4. hand off before any spend
  if (has("conflict")) return handOff("conflict", unmet);
  if (has("attribution")) return handOff("attribution", unmet);
  if (has("too-large")) return handOff("too-large", unmet);
  // 5. settle
  if (world.now - pr.headAt < rules.settleMs) return waiting("settling: head is new", unmet);

  // 6-7. evidence
  const want: Job[] = [];
  const reviewNeed = needOf(pr.records.review, pr.mergeBase, "review", rules, world.now);
  const verifyNeed: Need = pr.landing.kind === "clean" ? needOf(pr.records.verify, pr.landing.tree, "verify", rules, world.now) : { need: "none" };
  if (reviewNeed.need === "give-up") return handOff("reviewer-failing", unmet);
  if (verifyNeed.need === "give-up") return handOff("verify-failing", unmet);
  if (reviewNeed.need === "run") want.push({ kind: "review", pr: pr.number, head: pr.head, mergeBase: pr.mergeBase, prior: pr.priorReview, title: pr.title, body: pr.body });
  if (verifyNeed.need === "run" && pr.landing.kind === "clean") want.push({ kind: "verify", on: { pr: pr.number, head: pr.head }, tree: pr.landing.tree });
  if (want.length > 0) return { kind: "track", status: { phase: "working", note: `starting ${want.map((j) => j.kind).join(" and ")}`, unmet }, act: null, want };
  const running = [reviewNeed, verifyNeed].filter((n) => n.need === "running");
  if (running.length > 0) return working(`${reviewNeed.need === "running" ? "review" : ""}${running.length === 2 ? " and " : ""}${verifyNeed.need === "running" ? "verification" : ""} running`, unmet);
  const backoff = [reviewNeed, verifyNeed].find((n) => n.need === "backoff");
  if (backoff && backoff.need === "backoff") return waiting(`agent unavailable; retrying after ${new Date(backoff.until).toISOString()}`, unmet);

  // 8. problems in the evidence
  const blocked = has("review-blockers");
  const failed = has("verify-failed");
  if (blocked || failed) {
    const trunkRed = world.trunk.verify.latest?.state === "done" && world.trunk.verify.latest.key === world.trunk.tree && !isGreen(world.trunk.verify.latest.result);
    if (failed && trunkRed) return waiting("main is red on this host; not fixing", unmet);
    if (rules.stage === "review") return handOff("autofix-off", unmet);
    const fix = pr.records.fix;
    const f = fix.latest && fix.latest.key === pr.head ? fix.latest : null;
    if (f?.state === "running") {
      const stale = world.now - f.startedAt > rules.timeoutMs.fix + rules.graceMs;
      if (!stale) return working(`fix ${pr.streak + 1} of ${rules.maxFixes} running`, unmet);
    }
    if (f?.state === "done") {
      switch (f.result.outcome) {
        case "no-change":
          return handOff("fix-no-change", unmet, f.result);
        case "disputed":
          return handOff("fix-disputed", unmet, f.result);
        case "rejected":
          return handOff("fix-rejected", unmet, f.result);
        case "superseded":
          return waiting("branch moved while fixing; re-reading", unmet);
        case "pushed":
          return waiting("fix pushed; waiting for the new head", unmet);
      }
    }
    if (f?.state === "errored" && (f.why === "unavailable" || f.why === "interrupted") && world.now < f.at + rules.backoffMs) {
      return waiting("fixer unavailable; retrying later", unmet);
    }
    if (fix.errors >= rules.maxErrors || (f?.state === "running" && fix.errors + 1 >= rules.maxErrors)) return handOff("fix-failing", unmet);
    if (pr.streak >= rules.maxFixes) return handOff("fix-exhausted", unmet);
    const allowedPaths = pr.changed === "too-many" ? [] : pr.changed;
    return {
      kind: "track",
      status: { phase: "working", note: `starting fix ${pr.streak + 1} of ${rules.maxFixes}`, unmet },
      act: null,
      want: [
        {
          kind: "fix",
          pr: pr.number,
          branch: pr.branch,
          head: pr.head,
          attempt: pr.streak + 1,
          findings: blocked ? blocked.findings : [],
          failures: failed ? failed.steps : [],
          allowedPaths,
          title: pr.title,
          body: pr.body,
        },
      ],
    };
  }

  // 9-10. clean evidence, but not landable
  if (pr.base.kind === "stacked") return waiting(`stacked on #${pr.base.on}`, unmet);
  const gate = has("gate-paths");
  if (gate) return handOff("gate-paths", unmet);
  // Every Unmet kind is handled above; reaching here means a new kind was added without a remedy.
  return waiting(`unhandled: ${unmet.map((u) => u.why).join(", ")}`, unmet);
}

export interface Plan {
  /** One entry per PR the factory tracks (ignored PRs are absent). */
  steps: readonly { pr: Pr; step: Tracked }[];
  /** At most one job per lane, admitted against lane occupancy and daily caps. */
  start: readonly Job[];
}

function isFreshRunning<R>(h: History<R>, kind: JobKind, rules: Rules, now: number): boolean {
  const r = h.latest;
  return !!r && r.state === "running" && now - r.startedAt <= rules.timeoutMs[kind] + rules.graceMs;
}

/**
 * Whole-world plan. Pure.
 *  - trunk: if trunk.verify has no done/running run keyed by trunk.tree -> verify job (top priority)
 *  - per PR: nextStep; drop `ignore`
 *  - lane busy := some fresh running record (review -> read; verify/fix -> exec) anywhere in the world
 *  - admit candidates: lane free, usage[kind] < runsPerDay[kind]; priority trunk, then lowest PR number
 *  - rewrite the status note of wanted-but-not-started jobs to "queued: <lane> busy" or "daily cap reached"
 */
export function plan(world: World, rules: Rules): Plan {
  const busy: Record<Lane, boolean> = { read: false, exec: false };
  for (const pr of world.prs) {
    if (isFreshRunning(pr.records.review, "review", rules, world.now)) busy.read = true;
    if (isFreshRunning(pr.records.verify, "verify", rules, world.now)) busy.exec = true;
    if (isFreshRunning(pr.records.fix, "fix", rules, world.now)) busy.exec = true;
  }
  if (isFreshRunning(world.trunk.verify, "verify", rules, world.now)) busy.exec = true;

  const candidates: Job[] = [];
  const t = world.trunk.verify.latest;
  const trunkCovered = !!t && t.key === world.trunk.tree && (t.state === "done" || isFreshRunning(world.trunk.verify, "verify", rules, world.now));
  if (!trunkCovered && !world.paused) candidates.push({ kind: "verify", on: { trunk: world.trunk.head }, tree: world.trunk.tree });

  const steps: { pr: Pr; step: Tracked }[] = [];
  const sorted = [...world.prs].sort((a, b) => a.number - b.number);
  for (const pr of sorted) {
    const step = nextStep(pr, world, rules);
    if (step.kind === "ignore") continue;
    steps.push({ pr, step });
    candidates.push(...step.want);
  }

  const start: Job[] = [];
  const used = { ...world.usage };
  const started = new Set<Job>();
  for (const job of candidates) {
    const lane = LANE[job.kind];
    if (busy[lane]) continue;
    if (used[job.kind] >= rules.runsPerDay[job.kind]) continue;
    busy[lane] = true;
    used[job.kind]++;
    start.push(job);
    started.add(job);
  }

  // Explain queued jobs in the status note.
  const explained = steps.map(({ pr, step }) => {
    const queued = step.want.filter((j) => !started.has(j));
    if (queued.length === 0 || step.status.phase !== "working") return { pr, step };
    const notes = queued.map((j) => (used[j.kind] >= rules.runsPerDay[j.kind] ? `${j.kind}: daily cap reached` : `${j.kind}: queued, ${LANE[j.kind]} lane busy`));
    const status: Status = { phase: "waiting", note: notes.join("; "), unmet: step.status.unmet };
    return { pr, step: { ...step, status } };
  });
  return { steps: explained, start };
}

// ───────────────────────────── rendering ─────────────────────────────

const FOOTER = "To continue: push a commit (an empty commit retries), merge by hand, or add the factory:hold label.";

const HAND_OFF_TEXT: { readonly [K in HandOff]: string } = {
  conflict: "This branch conflicts with main. The factory does not resolve conflicts.",
  attribution: "A commit message, the title, the body or an added line carries tool attribution, which this repository does not allow on main.",
  "too-large": "The change touches more files than the factory inspects.",
  "gate-paths": "The change touches paths only the owner may land.",
  "reviewer-failing": "The reviewer failed repeatedly on this head.",
  "verify-failing": "The verification suite could not run on this host. This is the laptop's problem, not the change's.",
  "fix-exhausted": "The allowed number of fix commits in a row did not clear the review and the suite.",
  "fix-no-change": "The fixer made no change.",
  "fix-disputed": "The fixer disputes a finding. Nothing was pushed; break the tie.",
  "fix-rejected": "The fixer's patch was rejected before pushing.",
  "fix-failing": "The fixer failed repeatedly on this head.",
  "autofix-off": "Autofix is off (stage: review). The review and the suite are posted; the rest is yours.",
  ready: "Review and suite are clean. Merging is off (stage below merge), so the merge is yours.",
};

function describeUnmet(u: Unmet): string {
  switch (u.why) {
    case "not-owner":
      return "author is not the owner";
    case "draft":
      return "draft";
    case "hold":
      return "factory:hold";
    case "not-on-trunk":
      return u.base.kind === "stacked" ? `stacked on #${u.base.on}` : u.base.kind === "landed" ? `base landed (#${u.base.pr})` : "base is not main";
    case "conflict":
      return `conflicts with main: ${u.paths.slice(0, 5).join(", ")}${u.paths.length > 5 ? ", …" : ""}`;
    case "attribution":
      return `attribution in ${u.where.join(", ")}`;
    case "too-large":
      return "too many changed paths";
    case "gate-paths":
      return `owner-only paths: ${u.paths.join(", ")}`;
    case "review-missing":
      return "review: none for this head and base";
    case "review-running":
      return "review: running";
    case "review-errored":
      return `review: errored (${u.cause})`;
    case "review-blockers":
      return `review: ${u.findings.length} blocker${u.findings.length === 1 ? "" : "s"}`;
    case "verify-missing":
      return "suite: none for the tree that would land";
    case "verify-running":
      return "suite: running";
    case "verify-errored":
      return `suite: errored (${u.cause})`;
    case "verify-failed":
      return `suite: ${u.steps.map((s) => s.name).join(", ")} failed`;
  }
}

function findingLine(f: Finding): string {
  const where = f.path ? `${f.path}${f.line ? `:${f.line}` : ""}  ` : "";
  return `- ${f.id} ${where}${f.title}`;
}

/** Text of the `factory` check run and of a hand-off comment. Pure; github.ts cleans it before posting. */
export function render(status: Status, pr: Pr): { title: string; summary: string; comment: string | null } {
  const short = pr.head.slice(0, 7);
  if (status.phase === "landing") return { title: "landing", summary: `Merging ${short} into main.`, comment: null };
  const conditions = status.unmet.map((u) => `- ✗ ${describeUnmet(u)}`).join("\n");
  if (status.phase === "working" || status.phase === "waiting") {
    return { title: `${status.phase}: ${status.note}`, summary: conditions ? `Unmet before merge:\n${conditions}` : "All conditions met.", comment: null };
  }
  const lines: string[] = [`The factory stopped on ${short} and needs you.`, "", HAND_OFF_TEXT[status.code]];
  const blockersUnmet = status.unmet.find((u): u is Extract<Unmet, { why: "review-blockers" }> => u.why === "review-blockers");
  if (blockersUnmet) lines.push("", "Remaining blockers:", ...blockersUnmet.findings.map(findingLine));
  const failedUnmet = status.unmet.find((u): u is Extract<Unmet, { why: "verify-failed" }> => u.why === "verify-failed");
  if (failedUnmet) lines.push("", `Failing steps: ${failedUnmet.steps.map((s) => s.name).join(", ")} (tails in the factory/verify check).`);
  if (status.detail) {
    if (status.detail.outcome === "disputed") lines.push("", "Disputes:", ...status.detail.disputes.map((d) => `- ${d.id}: ${d.reason}`));
    if (status.detail.outcome === "rejected") lines.push("", `Rejected because: ${status.detail.why}`);
  }
  if (conditions) lines.push("", "Unmet before merge:", conditions);
  if (status.code !== "ready") lines.push("", FOOTER);
  const comment = lines.join("\n");
  return { title: `needs you: ${status.code}`, summary: comment, comment };
}
