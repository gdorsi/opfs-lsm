# PR factory: GitHub is the only database

Design package for automating review, autofix and merge of the owner's PRs on `gdorsi/opfs-lsm`. Supersedes the issue-to-PR sketch in `software-factory-design.md`; the research behind both is `software-factory.md`. Code lives in `factory/`.

A stateless reconciler on the laptop. Every minute it reads GitHub, computes one step per open PR with a pure function, and writes the outcome back to GitHub as a check run on the exact commit it judged. The laptop keeps no state: no ledger, no cursor, no queue. Review, verification and fix records live on commits, keyed by the content they cover, so a push makes them disappear on its own. The factory runs the repo's checks itself and lands a PR by pushing a merge commit whose tree it has already tested.

## Problem

Today on `gdorsi/opfs-lsm`, the owner's interactive agent sessions open PRs, CI goes green, nobody reviews, and the owner merges by hand. The goal: a reviewer from a different model family reviews every owner PR. Blocking findings and failing checks get fixed on the PR branch automatically. The PR merges when the content that was reviewed and verified is clean, with no human action for routine PRs and a clear hand-off when the loop gives up.

Constraints that shape the design:

- **GitHub can't gate.** The repo is private and user-owned on Free. The rulesets and branch-protection APIs return 403, `allow_auto_merge` is false, and merge queues need an org. Whatever writes to `main` is the gate.
- **No GitHub Actions (owner constraint).** Actions runs no agents and is not the source of "green". The laptop runs the repo's checks (`docs/verification.md`, the jobs in `m1-smoke.yml`), and the gate consumes only those local results. If `m1-smoke.yml` keeps running, the factory neither waits for it nor reads it.
- **The fixer uses the owner's Claude subscription (owner constraint).** The fixer is the unmodified `claude -p` binary with `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. No API key, and no other harness carries the subscription. So the reviewer is non-Anthropic: `grok -p`, or an OpenCode Go model from another family. `--bare` ignores OAuth, so `claude -p` runs without it, and without `--bare` it loads the checkout's `.claude/settings.json` hooks and `.mcp.json`.
- **Stacks are normal.** The open PRs 88←89←90←91 form a four-deep stack, and 88 conflicts with `main`. The owner has squash-merged single PRs and used merge commits for stacks (#82, #83).
- **A PR defines its own CI.** `pull_request` workflows run the PR's own workflow file: `main` runs a `bench` job, while older PR heads run `gate` and `rust`. A gate that trusts "the checks that showed up" lets the PR pick its own checks.
- **Owner rule.** No trace of Claude, Anthropic or AI assistance in commit messages, PR titles and bodies, code comments, or anything the factory posts. By default, Claude Code adds a `Co-Authored-By` trailer when it commits.
- **The laptop sleeps.** Whatever runs there has to be correct after any gap, without a manual resync.

## Usage (caller's view)

### The owner

One-time setup. The owner does these steps by hand; `doctor` checks them.

```sh
# 1. Create a GitHub App "opfs-lsm-factory", installed on gdorsi/opfs-lsm only.
#    Permissions: contents write, pull requests write, checks write, issues read, metadata read.
#    Leave these off: workflows, actions, administration.
# 2. Create two standard macOS users:
#    factory     runs the daemon and holds the App key (~factory/.factory/app.pem, 0600). Never runs PR code.
#    factoryrun  runs every agent CLI and every check. Holds the model credentials and no GitHub credential.
sudo -u factoryrun -i claude setup-token          # -> CLAUDE_CODE_OAUTH_TOKEN in ~factoryrun/.factory-env (0600)
sudo -u factoryrun -i sh -c 'echo XAI_API_KEY=... >> ~/.factory-env'
# 3. As factory: clone the repo once to ~factory/opfs-lsm (the pinned factory code) and write the config.
node factory/main.ts doctor     # App perms, git >= 2.38, sudo -> factoryrun, CLIs, Chrome, Rust,
                                # reviewer family != fixer family, a canary hook that `claude -p` must NOT run,
                                # then one full suite run on main with per-step durations
launchctl bootstrap gui/$(id -u factory) ~factory/Library/LaunchAgents/factory.plist   # caffeinate -s node factory/main.ts run
```

`~factory/.factory/config.json`:

```json
{
  "repo": "gdorsi/opfs-lsm", "owner": "gdorsi", "trunk": "main",
  "stage": "merge",
  "reviewers": [ { "cli": "grok", "model": "grok-4.7" },
                 { "cli": "opencode", "model": "opencode-go/gpt-6-luna" } ],
  "fixer":    { "cli": "claude", "model": "opus", "maxBudgetUsd": 3, "maxTurns": 60 },
  "maxFixes": 2,
  "maxFixLines": 200,
  "settleMinutes": 5,
  "runsPerDay": { "review": 30, "verify": 40, "fix": 12 },
  "app": { "id": 0, "installation": 0, "keyFile": "~/.factory/app.pem" },
  "runUser": "factoryrun"
}
```

`stage` is the trust dial. `review` posts reviews and checks and hands everything to the owner. `fix` also pushes fixes. `merge` also lands PRs. Start at `review` for a week.

`reviewers` is a fallback chain: the first entry reviews; on an infrastructure failure (timeout, crash, unusable output, quota) the next one is tried inside the same run. Every entry must be non-Anthropic, and the record names only "reviewer".

Day to day, everything happens on GitHub. Each PR head shows four checks from the App:

| Check run | What it says |
|---|---|
| `factory` | The status line: what the factory is doing or waiting for, or why it handed off. |
| `factory/review` | The reviewer's findings on this head, as annotations in "Files changed". Red if there is a blocker. |
| `factory/verify` | The local check suite on the tree that would land (`main` + this branch): a table of steps, plus the tail of each failing step. |
| `factory/fix` | The outcome of the one fix attempt allowed on this head. |

| You do | The factory does |
|---|---|
| Open a PR (any base) | Within a minute: reviews it and runs the suite on `main` merged with your branch. Both run in parallel. |
| Nothing | It fixes blockers and failing steps with a commit authored by `opfs-lsm-factory[bot]` on your branch, then re-reviews and re-verifies. At most 2 fix commits in a row. |
| Nothing | When review and suite are clean on the current head and `main`, it pushes a merge commit (tree already tested) to `main`. GitHub marks the PR merged. |
| Stack PRs (base = another PR's branch) | It reviews and fixes them now. It merges bottom-up. When a base lands, it retargets the next PR to `main`. |
| Push to the branch at any time | Your push wins. Records for the old head stop counting, the fix counter resets, and an in-flight fix push loses its lease and is dropped. |
| Label a PR `factory:hold` | The factory leaves that PR alone. |
| Label any open issue `factory:paused` | Everything stops, and every status line says "paused". This works from a phone. |
| After a hand-off: push any commit (an empty one is fine) | A fresh round with a fresh fix budget. |

A hand-off is a PR comment, which notifies you, plus the `factory` check concluding `action_required` with the full explanation:

```
The factory stopped on 3f9c2e1 and needs you.

Two fix commits in a row did not clear the review. Remaining blocker:
- packages/kv/src/recover.ts:212  Recovery accepts a manifest older than the installed generation.
The fixer disputes R2: "installGeneration() already rejects older generations".

Checks on main@812545b + this branch: 7 of 8 passed. bench-smoke failed (tail in factory/verify).

To continue: push a commit (an empty commit retries), merge by hand, or add factory:hold.
```

On the laptop:

```sh
node factory/main.ts plan            # dry run: the step and the merge decision for every open PR; writes nothing
node factory/main.ts plan --pr 91    # why 91 is or isn't merging, condition by condition
```

### Call sites in the factory's own code

The loop (`factory/main.ts`) is the whole flow:

```ts
const policy = loadPolicy(configPath);
const remote = await connect(policy);
for (;;) {
  const world = await remote.snapshot();            // git fetch + one GraphQL query; facts only
  const { steps, start } = plan(world, policy.rules); // pure
  for (const { pr, step } of steps) await remote.act(pr, step); // status lines, hand-offs, retargets, landings
  for (const job of start) inflight.add(await remote.start(job, work)); // claim on GitHub first, then run in background
  await sleep(policy.pollSeconds * 1000);
}
```

The gate is table-tested with no I/O (`factory/decide.test.ts`):

```ts
test("a push after review invalidates the review", () => {
  const d = mergeDecision({ ...clean, review: done(reviewOf(OLD_MERGE_BASE), noFindings) });
  assert.deepEqual(unmetOf(d), ["review-missing"]);
});
test("verify must cover the tree that lands, not the head", () => {
  const d = mergeDecision({ ...clean, landing: { kind: "clean", tree: T2 }, verify: done(T1, allGreen) });
  assert.deepEqual(unmetOf(d), ["verify-missing"]);
});
```

Landing takes a ticket that only `mergeDecision` can mint (`factory/github.ts`):

```ts
case "merge": return land(step.act.ticket);
// land(): commit-tree(ticket.tree, [ticket.trunk, ticket.head], cleanMessage)
//         push main with --force-with-lease=main:ticket.trunk; "moved" means main moved, so re-plan next tick
```

## Shape

### Data: records on commits, nothing on disk

There is one shared representation, the domain `World` that `snapshot()` builds (`decide.ts`), and one store, GitHub. The factory writes four kinds of check run, each owned by the App. Only GitHub Apps can create check runs, so neither the owner's token nor any agent can forge one.

| Record | Lives on | Key (in `external_id`) | Result (JSON in `output.text`) | Valid for the merge iff |
|---|---|---|---|---|
| `factory/review` | PR head | `mergeBase` (the diff it read is exactly `mergeBase..head`) | findings | key == current `merge-base(base, head)` |
| `factory/verify` | PR head, or `main` head | landing tree, `git merge-tree --write-tree main head` | per-step results | key == current landing tree |
| `factory/fix` | PR head | head | pushed / no-change / disputed / rejected / superseded | at most one per head |
| `factory` | PR head | hand-off code | status line | display, plus comment de-duplication |

Two keys, chosen to make the invariant structural:

- **The review covers a diff, so it is keyed by the two commits that fix that diff.** The record sits on the head and stores the merge base. A push creates a new head with no records, so the review is invalidated without any code comparing anything. A retarget that leaves the merge base unchanged keeps the review, which is what lets stacks land without re-review.
- **Verification covers what lands, so it is keyed by the landing tree.** `main` is only ever moved to a merge commit whose tree equals a verified key. Any move of `main` or of the head changes the landing tree and invalidates the result.

Everything else is derived on each tick. Nothing is counted locally:

- Fix attempts (`streak`): factory-authored commits on top of the last commit the factory did not make (`git log --first-parent`). An owner push resets it.
- Errored attempts: errored records for the same kind and key on the same commit.
- Lane occupancy: fresh `in_progress` records.
- Daily caps: factory records started in the last 24 hours.
- Retry backoff: the `completed_at` of the last "unavailable" record.

### Flow

`snapshot()` → `plan()` → `act()` / `start()`. Only `plan` holds policy, and it is pure. `start(job, work)` creates the `in_progress` record before any work begins, which acts as a write-ahead claim on GitHub. It then runs `work` in the background and completes the record with the outcome. If the daemon crashes, a record stays `in_progress`. Once it is older than the job timeout plus 10 minutes, it counts as an errored attempt (`abandoned`) and the next tick re-plans.

Jobs run in two lanes, at most one job per lane. The `read` lane runs reviews (an LLM over a read-only checkout). The `exec` lane runs verification and fixes (anything that executes repo code or Chrome). The lanes run in parallel. Priority is a `main` verification first, then the lowest PR number, so stacks drain bottom-up.

### The merge decision (rubric 1)

`mergeDecision(input: MergeInput): MergeDecision` in `factory/decide.ts` is pure and about 40 lines. Its inputs are exactly:

| Input | Condition |
|---|---|
| `author`, `owner` | equal |
| `draft`, `hold` | both false |
| `base` | `trunk` (stacked PRs wait for their base to land) |
| `landing` | `clean` (no conflict with current `main`) |
| `review` | done, `key == mergeBase`, zero `blocker` findings. Pass is derived from the findings, never from a model's "verdict" field. |
| `verify` | done, `key == landing.tree`, every step `pass` or `flaky` |
| `touchesGate` | false (`.github/`, `factory/`, `.claude/`, `.mcp.json`) |
| `tooLarge` | false (path list truncated) |
| `attribution` | empty: no AI attribution in any PR commit message, the title, the body, or any added line |
| `head`, `mergeBase`, `trunkHead` | carried into the ticket |

It returns either `{ ok: true, ticket }` or `{ ok: false, unmet: [Unmet, ...Unmet[]] }`, listing every unmet condition by name. The ticket is a branded type that only this function constructs, carrying `{ pr, head, trunk, tree }`. `land(ticket)` is the only code that writes to `main`. It builds the merge commit from `ticket.tree` with parents `[ticket.trunk, ticket.head]` and pushes with a lease on `ticket.trunk`. Three effects follow:

- No agent output reaches the gate except through findings that the factory itself recorded.
- A push after review can't merge: the review record is per head, and the merge commit's parent is the reviewed head.
- A concurrent push to `main` makes the lease fail, and the next tick re-plans.

If the owner pushes to the PR branch while landing is in progress, the merge contains the reviewed head and nothing newer. The newer commits stay in the PR for the next round.

The planner never re-checks merge conditions. `nextStep` calls `mergeDecision` first and maps the unmet list to a remedy: start a review, verification or fix job, retarget, wait, or hand off. So the merge conditions exist in one place. A new `Unmet` kind fails the build until the exhaustive remedy switch handles it.

### Loop termination (rubric 2)

| Situation | Bound or behaviour |
|---|---|
| Review/fix ping-pong | Only `blocker` findings drive fixes; nits never do. One fix per head, at most `maxFixes` (2) factory commits in a row, then a hand-off listing the remaining blockers. The re-review gets the previous findings and is told to confirm they are resolved and to raise new blockers only for regressions. |
| Fixer disagrees | The fixer's JSON can dispute findings. Any dispute means nothing is pushed and the factory hands off with both positions shown. The owner breaks the tie. |
| Fixer makes no change, edits a protected path, or writes attribution | Hand-off (`fix-no-change`, `fix-rejected`). Nothing is pushed. |
| Fixer sprawls | A fix may only modify files the PR itself changed, may not add, delete or rename files, and may not exceed `maxFixLines` added plus removed lines. Anything larger is not routine and is a `fix-rejected` hand-off with the patch described in the comment. |
| Owner is still pushing | A head younger than `settleMinutes` gets no job. A series of pushes costs no agent runs until it stops. |
| Agent crash, timeout or bad JSON | At most 2 errored runs per (kind, key), then a hand-off (`reviewer-failing`, `fix-failing`). |
| Quota exhausted (Claude 5-hour window, Go caps) | `unavailable` doesn't count as an attempt. The kind backs off for 30 minutes. |
| Flaky check | Each failing step is re-run once inside the same verification. Passing on the re-run counts as `flaky`: green, and flagged in the table. |
| Verification infrastructure broken | At most 2 errored verifications per landing tree, then a hand-off (`verify-failing`) that names the laptop, not the PR. |
| `main` red (its own verification failed) | No fix jobs anywhere, since the fixer would chase `main`'s bug. Reviews and verification continue. A PR whose landing tree is green may still land and fix `main`. The owner gets one commit comment on the red `main` head. |
| Stacked PR | Reviewed, verified and fixed now; waits for its base to land. When the base PR has merged, the factory retargets it to that PR's base. With merge commits the merge base doesn't change, so the review survives. |
| Conflict with `main` | Hand-off (`conflict`) before any agent spend. |
| Owner pushes mid-loop | New head: old records stop counting, `streak` restarts at 0, and in-flight fix pushes lose their lease (`superseded`). |
| Daily caps | `runsPerDay` per kind. When a cap is reached, the status says so and jobs wait. |

Every hand-off is derived from facts, not stored. It persists only while the facts hold, and the owner clears it with a push.

### Trigger and truth (rubric 3)

The factory polls every 60 seconds with `git fetch` plus one GraphQL query: open PRs, labels, the App's check runs on the last two commits of each PR and on `main`, and recent runs for the caps. It uses no webhooks, no smee and no inbound port. Everything it decides on is a fact read in that tick. CAS writes catch anything that changes between the read and the write:

- the lease on the PR branch for fix commits
- the lease on `main` for landings
- check runs keyed per commit

After the laptop sleeps, the next tick is an ordinary tick. Nothing was missed, because the factory reconciles current state and never consumes events. It has nothing to resync.

### Agent boundary (rubric 4)

`agents.ts` exports `review(brief, cfg)` and `fix(brief, cfg)`, which return `AgentOutcome<ReviewOut | FixOut>`, plus `familyOf(cfg)`. A private `ADAPTERS: Record<Cli, Adapter>` table is the only place that knows CLI flags. Each adapter maps role, prompt, model, budget and schema to argv and env. It parses stdout into `{ final, structured, costUsd }` and classifies quota errors as `unavailable`.

| | Read-only review | Fix (edits, may run the suite's commands, no network tools) | Structured output |
|---|---|---|---|
| `claude` (fixer only, by config type) | n/a | `-p --output-format json --permission-mode acceptEdits --allowedTools ... --disallowedTools WebFetch,WebSearch,Bash(git push:*),Bash(gh:*) --max-turns --max-budget-usd --setting-sources user --strict-mcp-config` | `--json-schema` |
| `grok` | `-p --output-format json --sandbox read-only --always-approve --no-auto-update -m` | (not configured) | last fenced JSON block, then the same validator |
| `opencode` | `run --format json --model p/m --agent factory-review`, env `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_CONFIG_CONTENT` with edit/bash denied except `git diff/log/show` | (not configured) | same |

Several parts are uniform across the three CLIs:

- **Prompts:** a fixed template, with untrusted text in nonce-fenced data blocks. The untrusted text is PR title and body, finding text, and step logs.
- **Timeouts:** a wall-clock deadline in `sandbox.runAs`, which kills the process group. Because the deadline is wall-clock, it fires after sleep. A detected clock jump reports `interrupted`, which doesn't count as an attempt.
- **Execution:** everything runs as `factoryrun` via `sudo -n -u factoryrun env -i ...`, so no GitHub credential is reachable.
- **Hidden config:** agent worktrees are sparse checkouts that leave out `.claude/` and `.mcp.json` (the `agents: hidden` column in `PATHS`). Even if `--setting-sources` doesn't behave as documented, `claude -p` has no project hooks to run, and `doctor` checks this with a canary hook.
- **Agents never commit:** `Worktree.capture()` soft-resets to the head and returns the working tree as a tree object. The factory writes every commit object itself.

Config types encode the owner constraints. `FixerConfig` is `{ cli: "claude", ... }` only, and `ReviewerConfig` is `grok | opencode` only. `loadPolicy` rejects a reviewer whose family is `anthropic`, for example an OpenCode Go Claude model.

### Local verification

- **What runs:** a fixed suite, in `verify.ts` `SUITE`: `install` (`pnpm install --frozen-lockfile --prefer-offline`), `static` (`pnpm static`), `rust` (`cargo test -p engine-core`), `formal` (`pnpm --filter @opfs-lsm/kv formal:kv`), `two-tab`, `bench-size` (`pnpm bench:size --check`), `bench-smoke` (`pnpm bench:smoke`), `test` (`pnpm test`). This is the union of `m1-smoke.yml` across `main` and the PR branches. It is the full suite every time, with no diff-based selection. Selecting by diff would need a second copy of `docs/verification.md`'s routing table, and the full suite is a superset of every row.
- **On what:** the landing tree (`main` merged with the head), checked out fresh as `factoryrun`. The same tree becomes `main`'s tree on landing, so `main` is green by construction, modulo flaky tests. After a landing the factory copies the result onto the new `main` commit. If `main` moves for another reason (an owner push), `main` itself is verified first, in the exec lane.
- **Gate definition comes from trunk, not the PR:** the suite is code in the pinned `factory/` install, and `factory/**` is a gate path (owner merges by hand). A PR can't drop a step. A PR can still weaken a test or a script it touches. The review rubric treats weakened tests, budgets (`bench/size/rows.ts`) and scripts as blockers, and the fixer is denied those paths.
- **Caching:** the pnpm content-addressed store and `CARGO_TARGET_DIR` are shared per `factoryrun`. That makes `install` take seconds and warm `cargo test` take about a minute. There is no cache for `dist` or worktrees: each run builds from a clean checkout, so the tested tree is exactly the landing tree. Per `AGENTS.md`, measure before adding a cache. The committed `packages/kv/wasm/*` means no `wasm-pack` in the suite.
- **Time budget:** per-step deadlines (5 to 15 minutes) and 45 minutes for the whole suite. The typical run is an estimated 10 to 20 minutes; it has not been measured. Every step runs even after a failure, so one fix attempt sees every failure. The exception is `install`: if it fails, nothing else can run.
- **Feeding the fixer:** `factory/verify` stores each failing step's last 150 lines (ANSI stripped, 64 KB total across the run) in its data block. The fix brief reads the failures from that record, not from local files, so it survives a restart. The fixer may re-run any `SUITE` command in its own worktree.
- **What the owner sees:** the `factory/verify` check on the PR head shows a title (`7/8 passed: bench-smoke failed`), a step table with durations, and the failing tails. A check run, not a commit status: only an App can write it, and it carries 64 KB of output instead of a 140-character description.
- **Drift guard:** `verify.test.ts` fails if any `SUITE` command is missing verbatim from `docs/verification.md`. Today `cargo test -p engine-core` and the install line are missing, so the factory's first PR adds a "What the factory runs" table to that page.

### Owner-rule enforcement (rubric 5)

- **Only `github.ts` can write.** It holds the App key in a closure. The boundary test fails if any other module reads `app.keyFile`. `factoryrun` has no GitHub credential at all.
- **`CleanText`:** every free-text field that `github.ts` writes is typed `CleanText`. That covers check-run titles, summaries and annotations, comments, and commit messages. The only constructor is `policy.clean()`, which redacts attribution phrases and vendor and model names outside path context and enforces length limits. Agents' prose is cleaned. Factory templates are cleaned too, and the tests assert that cleaning them is a no-op.
- **Commits:** the factory builds every commit with `git commit-tree`, using its own identity and a message from a template. For fixes the template takes the fixer's cleaned one-line subject. Agents' commits and trailers are discarded by `capture()`. Before any push, `github.ts` re-validates every factory-made commit in `expect..new`: identity, cleaned message, `PATHS` fixer policy on the changed paths, and the strict attribution scan on added lines.
- **Merges:** `mergeDecision` refuses a PR that carries attribution anywhere: a commit message, the title, the body, or an added line. A leak from an interactive session is handed off instead of landed on `main`.
- **No model names in GitHub text:** posts say "reviewer" and "fixer". The model and CLI used for each run go only to the local log.

### Module map and depth (rubric 6)

```
factory/                 not a pnpm workspace member; zero dependencies; node 24 runs .ts directly
  main.ts        ~80     CLI (run | plan | doctor) + the loop + `work`: checkout -> agent/suite -> capture
  decide.ts      ~300    PURE. Domain types, mergeDecision, nextStep, plan, render. Imports nothing.
  github.ts      ~400    The only reader/writer of GitHub: snapshot, act, start. App JWT, GraphQL, record encoding,
                         CAS pushes, landing, and validation at the write boundary.
  workspace.ts   ~150    Local mirror without credentials: facts(), checkout() sparse/full, commit(), inspect(), fetch/push(auth).
  agents.ts      ~250    review(), fix(), familyOf(). ADAPTERS table, prompt templates, schema validation.
  verify.ts      ~100    SUITE and verify(worktree).
  policy.ts      ~150    loadPolicy (validated config), PATHS (one table: fixer / merge / agents columns),
                         clean() -> CleanText, findAttribution().
  sandbox.ts     ~60     runAs(): the only way to execute anything as factoryrun.
  decide.test.ts, verify.test.ts, boundaries.test.ts
  rubric.md              the reviewer's rubric (AGENTS.md principles; weakened tests, budgets or scripts are blockers)
```

The whole flow is visible in three files: `main.ts` (loop), `decide.ts` (every decision) and `github.ts` (every effect). The public surfaces are small:

| Module | Public surface | What it hides |
|---|---|---|
| `Remote` | 3 methods | App auth, GraphQL shapes, check-run names and `external_id` encoding, label names, comment de-duplication, CAS, merge-commit construction, every validation |
| `agents` | `review`, `fix`, plus `familyOf` for config validation | three CLIs |
| `verify` | 1 function | the suite, retries, deadlines |
| `Mirror` | 6 methods (`fetch`, `facts`, `checkout`, `commit`, `push`, `inspect`) | git plumbing |

`boundaries.test.ts` asserts the import DAG:

- `decide.ts` has only `import type`.
- Only `main.ts` imports `github.ts` and `agents.ts`.
- Only `github.ts` touches the key file and mints `Auth`, which `Mirror.fetch` and `Mirror.push` require. Only `decide.ts` mints a `MergeTicket`.
- Only `sandbox.ts` imports `node:child_process` for `factoryrun` execution. `workspace.ts` runs git as `factory` through its own helper, the single other caller.

There are no hand-synced lists:

- Check names exist once, in `github.ts`.
- `PATHS` and `SUITE` exist once each, with a drift test for the docs.
- `Unmet → remedy` and `HandOff → render` are exhaustive switches.
- Required checks are a typed constant, not "whatever reported".

### What it deliberately does not do

- It does not read Actions results.
- It does not read comments as commands. The only owner inputs are pushes and two labels.
- It does not touch PRs by other authors.
- It does not resolve conflicts or rebase.
- It never force-pushes over a commit it didn't expect: every write is a lease.
- It never squashes.
- It does not open PRs or issues.
- It does not label anything.

### Red-flag screen

- **Shallow module:** passed. Each public surface is 1 to 3 calls hiding a whole concern. `main.ts`'s `work` composes checkout, agent and capture, about 15 lines; it is glue in the composition root, not a coordination burden pushed onto callers.
- **Information leakage:** passed. Wire formats live in `github.ts` (GraphQL, check names, `external_id` and data blocks, labels), CLI flags in `agents.ts`, and commands in `verify.ts`. `decide.ts` sees only domain types. The comment de-duplication state is kept inside `Remote`, filled by `snapshot()`, rather than leaked as a field on `Pr`.
- **Temporal decomposition:** considered and accepted. snapshot, plan and act look like load, decide and save, but each module owns knowledge, not a phase. `github.ts` owns the GitHub representation in both directions, and `decide.ts` owns policy. `World` is the only shared representation.
- **Pass-through:** passed. `Remote.start` adds the claim, recording, abandonment and validation; it is not a forwarder.
- **Split ownership:** this is the real risk, and it is handled. PR branches and `main` have two writers, the owner and the factory. The rule is "the owner always wins": every factory write is a compare-and-swap on the exact commit it read. Records have one writer, the App.
- **Two ways to do one task:** passed. There is one way to merge (`land(ticket)`), one way to write GitHub (`Remote`), one way to execute (`runAs`), one way to retry (push), and one way to pause (the label).
- **Importable internals:** passed. `factory/` is a leaf directory nothing imports, and the boundary test pins the DAG.
- **Hand-synced lists:** passed, as above. The one cross-file list, `SUITE` against `docs/verification.md`, has a failing test.

## Synthesis decision

Two candidates ran in the arena, both on Claude Opus at the highest reasoning setting (the second default seat, a Grok model, is not available in this harness, so it ran on Opus too). The cross-judge seat requires a non-Claude model and was skipped for the same reason; the pick below is the orchestrator's alone.

- **Candidate 1, "land a verified candidate":** build the PR head plus a merge of `main` plus fix commits locally, prove it, and touch the PR branch once, at landing; evidence in an append-only JSONL ledger keyed by tree SHA and by an exact content hash of the change; squash merges.
- **Candidate 2, "GitHub is the only database":** this document's shape.

Both converged on: a 60-second poll with no webhooks, a GitHub App, a pure merge gate, agents without any GitHub credential, the full suite on every PR with no diff-based selection, a path table that protects the gate, typed clean text for everything written, and a hand-off that the owner clears with a push. That agreement is taken as settled.

Candidate 2 became the base because it stores nothing twice. Candidate 1's ledger holds facts that GitHub also holds (which head is current, how many attempts), so a hand merge, a crash or a force-push leaves two stores to reconcile. Candidate 2 also keeps every fix and verdict visible on the PR instead of in a local file and on a side branch, hides `.claude/` and `.mcp.json` from agents structurally rather than by trusting `main`'s copy, and refuses to land a PR that already carries attribution from an interactive session.

Grafted from candidate 1:

- Fix bounds: only the PR's own files, no added, deleted or renamed files, `maxFixLines` lines. Candidate 2 only denied protected paths.
- The settle period on a fresh head.
- The reviewer fallback chain presented as one reviewer.
- `doctor` runs the suite once on `main` and prints durations, so step deadlines rest on a measurement.
- Candidate 1's broader redaction list for `clean()` (model names, CLI names, "as an AI", the robot marker).

Rejected from candidate 1: the content-hash review key. It lets a review survive a rebase, but candidate 2's merge-commit landing already keeps the merge base stable across a stack, which was the case that mattered, and the merge-base key needs no code of its own. Also rejected: squash merges and local candidates, for the reasons under Alternatives.

## Tradeoffs accepted

- We accept one GraphQL query per minute, an estimated 15 points (roughly 900 of 5,000 per hour, unmeasured), in exchange for having no local state and nothing to recover.
- We accept merge commits on `main` in exchange for stacks landing without restacking or force-pushes, and reviews surviving a retarget. The factory's fix commits become visible in `main`'s history.
- We accept running the full suite on every landing tree, an estimated 10 to 20 minutes, in exchange for no second copy of the `verification.md` routing table and a `main` that is green by construction.
- We accept re-verifying open PRs whenever `main` moves in exchange for "only verified trees reach `main`". Only PRs that are otherwise ready get re-verified first, and stacks drain one at a time.
- We accept that the factory may land an older head than the branch tip if the owner pushes during landing, in exchange for "nothing unreviewed lands". The newer commits stay in the PR.
- We accept that PR code can read `factoryrun`'s model credentials during verification and fixes, in exchange for one execution user. Today the same code runs as the owner with every credential. GitHub write power stays out of reach.
- We accept a 1-to-2-minute reaction time from polling in exchange for no inbound surface.
- We accept that a weakened test or script inside an owner PR is caught only by the reviewer, in exchange for not hand-merging every PR that touches a `package.json`. PR 88 does.
- We accept `factory` check runs left `in_progress` on superseded heads, which is cosmetic, until a later tick completes them as `neutral`.

## Alternatives considered

- **Event-driven daemon with a local ledger and a pure `decide(cfg, state, facts)` (the prior sketch).** Lost on split ownership. The ledger's `State`, attempt counters and verdicts duplicate facts GitHub already holds, so an owner push, a manual merge or a lost smee event leaves two stores to reconcile, and `factory resync` exists to patch that. The verdict also sits in a JSONL file the owner never sees. Reused from it: the pure decision function, facts re-read from the API, no GitHub token for agents, the path denylist, and the attempt cap.
- **Git-native ledger in `refs/notes/factory`.** Keeps everything in git, but anyone with push access can write notes, including the owner's interactive agents. Notes are invisible in GitHub's UI, have no `in_progress` state for claims, and need a notes-merge story. App check runs give unforgeable authorship, per-commit keying and visibility for free.
- **Commit statuses through a PAT instead of an App.** Saves creating an App. But the owner's interactive agents hold the same token and could set `factory/review=success`. A status carries 140 characters, so findings and step tails would need another store. There is also no distinct committer identity to derive `streak` from.
- **Landing through `PUT /pulls/{n}/merge` instead of pushing a tested merge commit.** Simpler, and GitHub marks the PR merged. But the endpoint has no expected-base parameter, so GitHub can merge onto a `main` that moved after verification, landing an untested tree. Pushing the commit we tested, with a lease on `main`, makes "only verified trees reach `main`" a compare-and-swap rather than a hope.
- **Squash merges, matching the owner's habit for single PRs.** The tested tree is identical. But after squashing 88, PR 89's merge base falls back to old `main`: its review covers 88's diff again, and its branch needs a rebase and force-push. That means restack machinery the merge-commit shape doesn't need.
- **Diff-selected checks from `docs/verification.md`'s routing table.** Faster for docs-only PRs, but it needs a second copy of the routing table that drifts. A wrong row silently skips a check, and a skipped check is exactly the failure a gate must not have.
- **Reviewer as loop driver: one session that reviews, fixes and re-reviews.** Fewest moving parts, but the reviewer approves its own fixes and the policy lives in a prompt.

## Open questions and risks

- Does GitHub mark a PR merged when a pushed merge commit makes its head reachable from `main`? I expect so, from GitHub's "manually merged" detection, but it is unverified. Test on a throwaway PR. The fallback is to call the merge endpoint after the push; it should be a no-op.
- Does an App installation token without `workflows` permission get refused when pushing a merge commit to `main` that contains workflow changes? That is expected and desired, since it makes `.github/` server-enforced, but it is unverified.
- Do `--setting-sources user` and `--strict-mcp-config` stop project hooks and MCP servers under `claude -p` with OAuth? The sparse checkout makes this belt-and-braces, and `doctor`'s canary checks it. Verify before the first fix run.
- Are merge commits on `main` acceptable to you, given the single-PR squash habit? If not, the alternative is squash plus a restack step (rebase the dependents onto `main` and force-push with a lease), which costs one more mechanism and one more way to write a branch.
- Should owner PRs that touch `.agents/**`, `AGENTS.md` or `**/package.json` auto-merge? This sketch says yes: the reviewer sees them and the fixer can't touch them. Say no to move them to the gate list.
- How long does the suite take on the spare laptop, and is `bench-smoke` stable under load? Measure 10 runs before choosing step deadlines and the flaky policy.
- Grok subscription automation terms are still unverified. `XAI_API_KEY` is the safe route. Does a Claude fixer at 12 runs a day leave enough of your 5-hour and weekly windows?
- Does the snapshot query (the App's check runs on the last two commits of up to 20 PRs, plus the last 24 hours of runs for the caps) stay near the roughly 15 points I estimated? This is unmeasured. If not, split the usage count into a query that runs only before starting a job, or poll every 2 minutes.
- Should `m1-smoke.yml` stay? The factory ignores it. Keeping it costs private-repo minutes and shows a second, possibly disagreeing, set of checks.

## Next implementation step

Write `factory/decide.ts` (`mergeDecision`, `nextStep`, `plan`) and `decide.test.ts`, with table rows for push-after-review, stale landing tree, stacked base, landed base, conflict, fix streak, dispute, red `main`, and lane and cap admission. No I/O, against the types in the sketch.
