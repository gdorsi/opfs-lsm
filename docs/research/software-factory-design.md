# Software factory: design sketch

Sketch only. Every body is `not implemented`. Builds on `software-factory.md` (same folder); read its sections 3, 5 and 6 first. Decisions taken in conversation: laptop daemon, GitHub App with webhooks relayed by smee (webhooks only, no periodic poll; the owner creates the App and holds its secrets), no self-hosted runner and no hosted-runner agents, Android phones over USB as a non-blocking proof.

## Problem

Automate review and merge, and triage and resolution of issues the owner opened or approved, for `gdorsi/opfs-lsm`, using Claude Code, the Grok CLI and OpenCode Go on a spare laptop. Constraints that shape the design:

- The repo is private on a free personal plan. The rulesets and branch-protection APIs return 403 and `allow_auto_merge` is false, so GitHub cannot enforce required checks. The daemon is the merge gate, so the gate must be one small, testable function. Revisit if the owner upgrades or goes public.
- smee.io is unauthenticated, development-only and drops events while the client is offline. Webhook payloads are therefore hints. Truth is always re-read from the GitHub API.
- Issue and PR text is untrusted input to agents. The author agent holds no GitHub token and no merge power.
- The owner's global rule forbids any trace of AI in commits and PR text. The daemon owns commit messages and PR bodies, not the agents.

## Usage (caller's view)

The owner's whole interface is GitHub plus one config file and one CLI.

```
# one-time
# owner creates the GitHub App by hand and puts its secrets under the `factory` user (mode 0600)
factory init --repo gdorsi/opfs-lsm        # writes ~/.factory/config.toml, no secrets
factory doctor                              # checks App perms, smee channel, CLIs, adb, secret file modes
launchctl load ~/Library/LaunchAgents/factory.plist   # runs: caffeinate -s factory run

# daily life, all on GitHub
open an issue as gdorsi                     # eligible immediately
label someone else's issue factory:approved # eligible only if the labeler is gdorsi
# the App opens a PR, a different-model reviewer comments, checks go green, the daemon merges

# control
factory status                              # one line per work item: state, attempts, spend
factory pause | resume                      # file ~/.factory/PAUSE
factory resync                              # owner-run: re-read every open issue/PR and wake it (recovers events missed while offline)
factory explain 123                         # why issue 123 is or isn't eligible, from the ledger
```

`config.toml`:

```toml
[repo]            name = "gdorsi/opfs-lsm"  owner = "gdorsi"
[roles.author]    runner = "claude"   budget_usd = 3
[roles.reviewer]  runner = "grok"     budget_usd = 1   # must differ from author's family
[merge]           mode = "daemon"     # "daemon" | "github-auto" (needs Pro or public)
[limits]          max_attempts = 3    claims_per_day = 3
[device_proof]    enabled = true      blocking = false
```

## Shape

Data flows one way: **wake -> facts -> decide -> effects**. Only `decide` contains policy, and it is pure.

```ts
// ---- domain ---------------------------------------------------------------

type Family = "anthropic" | "xai" | "other";           // reviewer family must differ from author's
type WorkId = `issue:${number}`;

type State =
  | { tag: "idle" }
  | { tag: "authoring"; attempt: number }
  | { tag: "in-review"; pr: number; headSha: string; attempt: number }
  | { tag: "merge-ready"; pr: number; headSha: string }
  | { tag: "done"; mergeSha: string }
  | { tag: "needs-human"; reason: HumanReason };

type HumanReason =
  | "gate-failed" | "attempts-exhausted" | "budget" | "policy-violation"
  | "issue-edited-after-approval" | "merge-conflict";

// What we learned from the API this tick. Built by `observe`, never from a webhook body.
interface Facts {
  issue: { number: number; authorLogin: string; bodyHash: string; updatedAt: string; state: "open" | "closed" };
  approval: { actor: string; at: string; bodyHashAtApproval: string } | null; // from events API
  pr: { number: number; headSha: string; authoredByApp: boolean; mergeable: boolean } | null;
  checks: Record<string, "pending" | "pass" | "fail">;   // required check names -> conclusion
  verdict: Verdict | null;                                // from the ledger, not from PR text
  diff: DiffSummary | null;
  budget: { claimsToday: number; spendUsd: Record<Role, number> };
  paused: boolean;
}

interface Verdict { headSha: string; verdict: "pass" | "block"; findings: Finding[]; runner: string }
interface Finding { path: string; line?: number; severity: "must" | "should"; text: string }
interface DiffSummary { paths: string[]; addedDeps: string[]; touchesScripts: boolean }

// ---- the one deep function ------------------------------------------------

type Effect =
  | { tag: "claim"; id: WorkId }
  | { tag: "run-author"; id: WorkId; feedback: Finding[] }
  | { tag: "open-pr"; id: WorkId }
  | { tag: "run-reviewer"; id: WorkId; headSha: string }
  | { tag: "run-device-proof"; id: WorkId; headSha: string }        // non-blocking
  | { tag: "set-status"; id: WorkId; headSha: string; name: "factory/review"; state: "success" | "failure" }
  | { tag: "merge"; id: WorkId; pr: number; headSha: string }
  | { tag: "label"; id: WorkId; label: `factory:${string}` }         // never `factory:approved`
  | { tag: "comment"; id: WorkId; body: string }
  | { tag: "halt"; id: WorkId; reason: HumanReason };

/** Pure. All policy lives here: the owner gate, attempt caps, merge conditions. Table-tested. */
declare function decide(cfg: Config, state: State, facts: Facts): { next: State; effects: Effect[] };

// ---- ingress: hints only --------------------------------------------------

interface Wake { id: WorkId; reason: "webhook" | "resync" }   // resync only via `factory resync`

interface Ingress {
  /** Localhost HTTP server behind smee-client. Verifies X-Hub-Signature-256 (constant-time),
   *  dedupes by X-GitHub-Delivery, maps the event to a WorkId, drops everything else. Body is not trusted. */
  listenWebhooks(onWake: (w: Wake) => void): Promise<Stop>;
  /** Owner-triggered only (`factory resync`): list open issues/PRs, emit Wake for each. No timer. */
  resync(onWake: (w: Wake) => void): Promise<void>;
}

// ---- effects boundary -----------------------------------------------------

interface GitHub {   // installation token minted per tick, 1h lifetime, repo-scoped
  observe(id: WorkId): Promise<Pick<Facts, "issue" | "approval" | "pr" | "checks" | "diff">>;
  openPr(branch: string, title: string, body: string): Promise<number>;
  setStatus(sha: string, name: string, state: "success" | "failure"): Promise<void>;
  merge(pr: number, expectSha: string): Promise<void>;     // fails if head moved
  comment(n: number, body: string): Promise<void>;
  setLabel(n: number, label: string): Promise<void>;
}

type Role = "author" | "reviewer";
interface AgentRunner {                       // adapters: claude | grok | opencode
  readonly family: Family;
  /** Fixed prompt template; issue text goes in a delimited data block. Config pinned outside the checkout.
   *  Author: read-write in a worktree, no network token. Reviewer: read-only, returns Verdict JSON. */
  run(role: Role, input: AgentInput): Promise<AgentResult>;
}
interface AgentInput { worktree: string; task: string; untrusted: string; budgetUsd: number; timeoutMs: number }
interface AgentResult { exit: number; costUsd: number | null; verdict?: Verdict; log: string }

interface Workspace {                         // one worktree per work item, under the `factory` user
  create(id: WorkId, baseSha: string): Promise<string>;
  commit(id: WorkId, message: string): Promise<string>;     // daemon writes the message; scrubs trailers
  remove(id: WorkId): Promise<void>;
}

interface DiffPolicy {                        // `factory:allow-infra` label unlocks the denied set
  check(diff: DiffSummary, allowInfra: boolean): "ok" | { violation: string };
}
// denied by default: .github/ .claude/ .agents/ .mcp.json AGENTS.md CLAUDE.md, new dependencies, package.json scripts

interface DeviceProof {                       // non-blocking; adb over USB; Playwright _android
  devices(): Promise<{ serial: string; chrome: string }[]>;
  run(headSha: string): Promise<{ serial: string; ok: boolean; log: string }[]>;
}

interface Ledger {                            // append-only JSONL + current state per WorkId
  state(id: WorkId): State;
  append(e: LedgerEvent): void;               // approval event id, actor, model, CLI version, cost, shas, verdict
}

// ---- the loop -------------------------------------------------------------

/** For each Wake: observe -> decide -> run effects -> persist. One item at a time per repo. Idempotent:
 *  every effect is keyed by (id, headSha) and skipped if the ledger already records it. */
declare function tick(wake: Wake, deps: Deps): Promise<void>;
```

Load-bearing decisions:

- **`decide` is the only policy.** The owner gate, the attempt cap and the merge condition are cases in one pure function, so the security-critical logic is table-testable with no network. Per `boundary-discipline`.
- **Facts come from the API, never from the webhook body.** A forged or replayed smee event can at most cause an extra re-read. Without a reconciler this is also what keeps the HMAC check from being the only defence.
- **Merge condition** (in `decide`): `state = merge-ready` AND required checks all `pass` AND `verdict.headSha == pr.headSha` AND `verdict = pass` AND `DiffPolicy = ok` AND `paused = false`. `GitHub.merge` passes `expectSha`, so a push after review cannot merge.
- **`MergeGate` is not a separate interface.** `merge.mode = "github-auto"` changes the `merge` effect to enable auto-merge and rely on rulesets. Nothing else changes.
- **Interface depth.** Callers see `tick(wake)`. Hidden behind it: HMAC, dedupe, token minting, worktrees, three CLIs' flags and permissions, budget accounting and the ledger.
- **Reviewer family check** is validated in `Config` at startup: author and reviewer runners must have different `family`.
- **The factory never sets `factory:approved`.** The type of `label` excludes it.

## Synthesis decision

No arena run; I judged the candidates directly (see conversation and `software-factory.md` section 3.5). The base is the daemon shape with the following changes: (1) a GitHub App replaces the PAT, (2) smee webhooks are the only trigger (the owner chose this over a webhook-plus-reconcile hybrid), (3) `decide` is separated from effects, taken from `orch`'s idea of an orchestrator that holds the merge decision while the worker has no token. Rejected: adopting `orch` or `herdr-orchestrator` wholesale (young, single-author), a long-lived Claude session (no real gate).

## Tradeoffs accepted

- We accept a daemon-held merge decision in exchange for working on a free private repo. If the owner moves to Pro or public, switch `merge.mode`.
- We accept smee as ingress in exchange for no tunnel setup. Private issue text transits smee.io, and the channel URL is a secret. The HMAC check covers forgery. Loss is not covered automatically: smee returns success to GitHub even when no client is connected, so GitHub will not mark those deliveries failed and will not offer them for redelivery [I, not verified]. Events sent while the laptop is asleep or the daemon is down are lost until the owner runs `factory resync`.
- We accept one work item at a time in exchange for a trivial lock and a readable ledger.
- We accept a non-blocking device proof in exchange for not gating on experimental Playwright Android support.
- We accept that the author agent cannot see the CI logs directly in exchange for no token. The daemon forwards a trimmed failure summary as `feedback`.

## Alternatives considered

- **Webhooks plus a periodic reconcile poll (A3).** Closes the lost-event gap. Not chosen by the owner; `resync` is the manual substitute, and a timer around it is a one-line addition if lost events turn out to matter.
- **Orchestration in YAML on a self-hosted or hosted runner.** Removed by the owner. It would also have given worse isolation for agents.
- **One agent that authors, reviews and merges, with a session-long prompt.** Smallest interface, but the policy would live in a prompt. Rejected.

## Open questions and risks

- Which merge mode do you want to start with? The sketch defaults to `daemon`. Upgrading to Pro enables `github-auto` and a non-bypassable `factory/review` required check.
- Is `smee-client` forwarding the original `X-Hub-Signature-256` and `X-GitHub-Delivery` headers unchanged? I expect so, but I have not tested it. The first integration test should assert it.
- Does the App's lack of the `workflows` permission actually block pushes touching `.github/workflows`? I believe so; test it with a throwaway branch.
- Does the Claude sandbox apply under `claude -p`? Still unverified (research note, open question 5). The separate macOS user is the real boundary.
- xAI and OpenCode terms for unattended subscription use are still unverified. Using `XAI_API_KEY` removes the xAI doubt.
- Does the owner want a startup resync (run `resync` when the daemon boots, e.g. after the laptop wakes)? It is cheap and covers the most likely loss window, but it is a step towards A3.
- Device proof: do the phones' Chrome versions meet Playwright's minimum (Chrome 105)? The owner will report them later.

## Next implementation step

Write `decide` and its table tests (owner gate, attempt cap, merge condition, stale verdict) against the types above, with no I/O, before touching GitHub, smee or any CLI.
