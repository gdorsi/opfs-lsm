# A software factory for @opfs-lsm on a spare laptop: tools, subscription terms, and a safe approval gate

Question: what tools and strategies can automate PR review and merge, and triage and resolution of owner-approved issues, for `gdorsi/opfs-lsm` (an OPFS LSM key-value store, `@opfs-lsm/kv` and `@opfs-lsm/collections`, verified in real Chrome), using three subscriptions (Claude Code, Grok, OpenCode Go) on the owner's spare laptop? The riskiest unknown is what each subscription permits when run headlessly, so that part was checked against vendor terms and docs first. All pages were read on 2026-11-08.

## Answer in ten lines

1. Claude subscription, headless: permitted for your own use through the unmodified `claude` binary. Anthropic documents `claude setup-token` (a one-year OAuth token, `CLAUDE_CODE_OAUTH_TOKEN`) "for CI pipelines and scripts", and documents `claude -p` and `claude-code-action` with that token (3.1). The Consumer Terms ban "automated or non-human means" except via API key "or where we otherwise explicitly permit it", so stay inside the documented paths (3.1).
2. Claude subscription, what is not permitted: routing your plan credentials through another harness or product. Anthropic says third parties may not "route requests through Free, Pro, Max, or Ultra plan credentials", and that developers building on the Agent SDK "should use API key authentication" (3.1). So do not put the Claude subscription behind OpenCode or a home-made wrapper. Use `claude` itself.
3. A June 2026 plan to bill Agent SDK and `claude -p` from a separate credit pool was paused. As of the help article's 2026-10-07 update, these "still draw from your subscription limits" (3.1). Third-party blogs still describe the cancelled change. Re-check before relying on this; it has already changed once.
4. OpenCode Go is the lowest-risk subscription for automation. It is an API key ($10, $40 or $20/seat per month), meant for "OpenCode and other coding agents", with per-model monthly dollar caps and 5-hour, weekly and monthly windows (3.3). The page does not mention headless or CI use at all, so that is "not prohibited, not blessed" (unverified).
5. Grok: the official `grok` CLI (xai-org/grok-build, Apache-2.0, 27.7k stars) has a documented headless mode (`grok -p`, `--always-approve`, `--output-format`) and two auth routes: browser login or `XAI_API_KEY` (3.2). xAI's own Claude Code plugin requires "a logged-in Grok CLI session". The subscription and the API are separate billing lines. I could not read xAI's Terms of Service (HTTP 403), so automation terms for the subscription route are unverified.
6. Your repo is user-owned and currently PRIVATE (`gdorsi/opfs-lsm`, `isInOrganization: false`). GitHub merge queue needs an organization-owned repo (4.4). Auto-merge plus rulesets plus required checks work without it. A public repo changes the threat model (section 6), a private one makes GitHub-hosted macOS minutes costly (4.5).
7. Recommended shape: a polling daemon on the laptop (launchd), not a self-hosted Actions runner and not a webhook tunnel. CI stays on GitHub-hosted `ubuntu-latest` (your existing `m1-smoke.yml` already runs real Chrome there). The laptop only runs agents, as a separate macOS user, in git worktrees, with API-token-scoped `gh` credentials (section 5).
8. Approval gate: act only on issues that are authored by the owner's login, or that carry an approval label whose last `labeled` event was applied by the owner (checked through the issue events API, not the label's mere presence). Treat all other text as data, never as instructions. Re-check the gate at every state transition (5.3).
9. Merge gate: GitHub decides, not an agent. A different-model reviewer posts a structured verdict; the daemon merges with `gh pr merge --auto` only when the required checks are green, the verdict matches the head SHA, and the diff stays inside an allowed path set. Use a ruleset that even the daemon identity cannot bypass (5.4).
10. Existing orchestrators with this shape exist but are small and young (herdr-orchestrator 6 stars, orch 0 stars, issue-orchestrator 11). The big ones are broader (Symphony, agent-orchestrator, OpenHands). Read one for design, but a 300-line daemon you own is probably the right size (3.5).

---

Conventions. **[E]** external fact with the owner's URL. **[R]** repo fact from this checkout. **[I]** my inference. **[U]** unverified: I could not reach a primary source or the source is silent. Pages fetched through a summarising fetch tool are marked "(summary)"; raw HTML or `gh api` reads are not. Re-read any quote marked "(summary)" before you rely on it.

---

## 1. Summary and recommendation

Build the factory in three layers, cheapest and safest first.

1. **Layer 0, no laptop needed**: required status checks, a ruleset on `main`, auto-merge allowed, CODEOWNERS. Nothing the agents do can land without these.
2. **Layer 1, review**: a reviewer agent from a different model family than the author, run on the laptop or through `claude-code-action` on a GitHub-hosted runner when the PR comes from a branch in the repo. It outputs a machine-readable verdict.
3. **Layer 2, resolution**: a launchd polling daemon that claims owner-approved issues, runs the author agent in a worktree and opens a PR. The author agent has no merge power.

Which model does what, given the terms below:

| Role | Suggested | Why |
|---|---|---|
| Author (hard issues) | `claude -p` with `CLAUDE_CODE_OAUTH_TOKEN` | Documented, permitted path (3.1) |
| Author (cheap issues) and spare capacity | OpenCode Go via `opencode run` | API-key based, many models, explicit "coding agents" scope (3.3) |
| Reviewer | A different family than the author: Grok 4.7 through `grok -p` or through Go, or a Go model | Cross-model review (5.5) |
| Merge decision | GitHub: ruleset plus auto-merge | Deterministic (5.4) |

If the owner wants zero ToS ambiguity, put the Claude role on an API key instead of the subscription. That is a billing choice, not a technical one.

---

## 2. What this repo already has [R]

- `gh` is logged in with `ADMIN` on `gdorsi/opfs-lsm`; visibility is `PRIVATE`; the owner is a user, not an organization (`gh repo view --json nameWithOwner,visibility,isInOrganization,viewerPermission`).
- One workflow, `.github/workflows/m1-smoke.yml`, runs on `pull_request` and `push` to `main`, on `ubuntu-latest`, with `browser-actions/setup-chrome@v1` and `pnpm bench:smoke`, plus a `two-tab` job. So real-Chrome verification already runs on a GitHub-hosted runner [R: `m1-smoke.yml:1-40`].
- Verification is documented in `docs/verification.md` and in two project skills (`verify-kv`, `verify-opfs-lsm`), and `AGENTS.md` points agents at them [R: `AGENTS.md`, "Verification"]. `pnpm static` (oxlint plus fallow) exists as a script and `AGENTS.md` says CI runs it in a `static` job; `m1-smoke.yml` has no `static` job in the part I read, so check whether another workflow exists on `main` [U].
- The owner's global rule: no trace of Claude, Anthropic or AI assistance in commits, PR titles, bodies or code comments [R: `~/.claude/CLAUDE.md`]. The factory must enforce this itself, for every agent, because Claude Code's own default adds a co-author trailer and PR footer (see the attribution reminder in this session). Add a `commit-msg` hook and a PR-body check in the daemon [I].

---

## 3. Subscription by subscription

### 3.0 Table

| | Claude (Pro/Max/Ultra via Claude Code) | Grok (xAI) | OpenCode Go |
|---|---|---|---|
| Credential | OAuth token from `claude setup-token`, valid one year, model requests only; or `ANTHROPIC_API_KEY` | Browser OIDC login (cached token) or `XAI_API_KEY` | API key from the OpenCode Console |
| Official headless entry | `claude -p`, Agent SDK, `claude-code-action` | `grok -p`, `grok agent stdio` (ACP) | `opencode run`, `opencode serve`, `opencode github run` |
| Harness it may be used with | Claude Code itself (unmodified). Not other harnesses | The official `grok` CLI; Warp documents its own OAuth bridge | OpenCode, plus validated Hermes, Claude Code, Codex, ZCode, Pi, jcode, Kilo Code CLI; direct endpoints documented |
| CI or automation stated? | Yes, explicitly (setup-token "for CI pipelines and scripts") | CLI docs say "scripts, automations"; API key listed for "Scripts, CI/CD, headless automation"; subscription terms silent | `opencode run` "designed for scripts, CI jobs"; the Go page itself is silent on CI |
| Limits | 5-hour and weekly windows shared with Claude, separate weekly Fable limit on Max/Ultra; `--max-budget-usd` and `--max-turns` per run | One weekly pool shared across Grok, Build, API usage by seat; tiers 4x/15x/50x; extra usage credits at higher rates | Per-model monthly dollar caps; 5-hour = 20%, weekly = 50%, monthly = 100%; optional pay-as-you-go overage |
| Price | Plan price | X Subscription: Plus $8, Premium $30, Super $100, Ultra $200 (existing SuperGrok plans continue) | Go $10, Go Plus $40, Go Teams $20/seat |
| ToS caveats | Consumer Terms forbid automation "except ... API Key or where we otherwise explicitly permit it"; limits "assume ordinary, individual usage"; no third-party plan-credential routing | xAI ToS unreadable (403) so [U]; one shared pool means a CI loop can starve your chat use | "Traffic is monitored for abuse"; client should send its own user agent and a stable `x-opencode-session`; Go and Go Plus are single-member workspaces; some models need privacy toggles |
| Fit for the factory | Author and judge for hard work | Reviewer (second family) | Cheap bulk work, second reviewer |

### 3.1 Claude

- **What is permitted.** Anthropic's own Claude Code page lists `claude setup-token` as the CI route: "generate a one-year OAuth token ... For CI pipelines, scripts, or other environments where interactive browser login isn't available", "This token authenticates with your Claude subscription and requires a Pro, Max, Ultra, Team, or Enterprise plan. It can only make model requests". [E] https://code.claude.com/docs/en/authentication (read 2026-11-08, raw)
- **GitHub Actions with the subscription.** "`CLAUDE_CODE_OAUTH_TOKEN`: an OAuth token that authenticates with your Claude subscription"; "If you authenticate with an OAuth token, runs use your Claude subscription instead of API billing." For a secret shared across repos, Anthropic recommends an API key "since an OAuth token is tied to the subscription of the person who ran `claude setup-token`". [E] https://code.claude.com/docs/en/github-actions (read 2026-11-08, summary)
- **What is not permitted.** "Developers building products or services ... should use API key authentication ... Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens." Nothing "prevent[s] an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". [E] https://code.claude.com/docs/en/legal-and-compliance (read 2026-11-08, summary). Consequence [I]: your own `claude -p` on your own laptop with your own token is the documented case. A daemon that hands the token to OpenCode, to a hosted service, or to other people is not.
- **Ordinary use.** "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK." Same URL. [I] A daemon that keeps `claude -p` busy around the clock is outside "ordinary" in spirit even if not in letter, so budget it (section 7).
- **Consumer Terms.** The prohibited-conduct list includes: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." Effective Oct 8, 2025. [E] https://www.anthropic.com/legal/consumer-terms (read 2026-11-08, raw HTML). The legal-and-compliance and authentication pages above are the "explicit permission" for Claude Code, `claude -p` and the Action [I].
- **Billing change, paused.** Press in May 2026 reported that Agent SDK, `claude -p` and Actions usage would move to a separate monthly credit pool from June 15, 2026 (e.g. https://www.theregister.com/ai-ml/2026/05/14/anthropic-tosses-agents-into-the-api-billing-pool/5240748, not fetched, search snippet only). Anthropic's own help article says: "Update June 15, 2026: We've paused the previously-announced changes to Claude Agent SDK usage ... still draw from your subscription limits", and "Update October 7, 2026: Claude Max, Ultra, and Team plans now include monthly API credits ... when you run them with an API key from your linked Claude Console organization ... when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits." [E] https://support.claude.com/en/articles/15036540 (read 2026-11-08, raw HTML). Practical reading [I]: Max/Ultra owners can run the factory on the included API credits by using an API key, and keep the OAuth token for the cases where they prefer plan limits.
- **Limits.** "Pro and Max plans have a five-hour session limit and a weekly limit ... Max and Ultra plans also have a separate weekly limit for Fable. These limits are shared across Claude and Claude Code". [E] https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan (read 2026-11-08, raw). The factory shares this budget with your interactive use.
- **Headless controls.** `claude -p`, `--output-format json` (returns `total_cost_usd`), `--output-format stream-json`, `--allowedTools`, `--permission-mode` (`auto`, `dontAsk`, `acceptEdits`), `--permission-prompts none`, `--max-budget-usd`, `--json-schema`, exit code 0 or non-zero, SIGTERM gives 143. "`--bare` is the recommended mode for scripted and SDK calls", but "In bare mode, Claude Code never reads OAuth credentials", so `--bare` needs an API key. Without `--bare`, `-p` "runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted". [E] https://code.claude.com/docs/en/headless (read 2026-11-08, summary). [I] Consequence: a daemon that runs agents on PR branches from untrusted authors must not use plain `-p` in the PR checkout, because the checkout's own `.claude/settings.json` hooks would run.
- **`claude-code-action` (v1.0.269, 2026-11-06, MIT, 9.8k stars).** Write access is required for the triggering user on issue and PR events, bots are rejected unless in `allowed_bots`, secrets are scrubbed from subprocess environments when `allowed_non_write_users` is set, and it restores `.claude/`, `.mcp.json`, `CLAUDE.md` and `.husky/` from the PR base branch before running. It does not create PRs by default; it gives a link. "On public repositories, GitHub withholds secrets from runs triggered by fork pull requests." Content is sanitised (HTML comments, invisible characters, hidden attributes) but "new bypass techniques may emerge". [E] https://github.com/anthropics/claude-code-action/blob/main/docs/security.md (read via `gh api`, raw) and https://code.claude.com/docs/en/github-actions. Repo state from `gh repo view anthropics/claude-code-action` and `gh release list` on 2026-11-08.
- **Managed Code Review product** is "Team and Enterprise" only, runs on Anthropic infrastructure, and "A review never approves or blocks the pull request", with a check run that "doesn't conclude as a failure". Not a fit for a gate and not available on an individual plan. [E] https://code.claude.com/docs/en/code-review (read 2026-11-08, summary).
- **Sandbox.** The Bash sandbox is off by default, uses Seatbelt on macOS, writes limited to the working directory, reads allowed for "Most of the machine, including credential files such as `~/.ssh`", network through a proxy with an empty allowlist. Built-in Read/Edit tools, hooks and MCP servers run outside it. Whether it applies to `claude -p` is not stated on the part of the page I read [U]. [E] https://code.claude.com/docs/en/sandboxing (read 2026-11-08, summary, last 10k characters not read). [I] Treat it as defence in depth; the separate macOS user is the real boundary.

### 3.2 Grok (xAI, now "SpaceXAI" on its own pages)

- **The official agent harness is open source.** `xai-org/grok-build`: "SpaceXAI's coding agent harness and TUI", Apache-2.0, 27,712 stars, last push 2026-09-29, a Rust CLI that runs "interactively, headlessly for scripting/CI, or embedded in editors via the Agent Client Protocol (ACP)". [E] https://github.com/xai-org/grok-build (`gh repo view` and README, 2026-11-08). Release listing was empty via `gh release list`, so I could not confirm a current tagged version [U].
- **Headless flags.** `-p/--single`, `-m`, `-s/--session-id`, `-r/--resume`, `-c/--continue`, `--cwd`, `--output-format plain|json|streaming-json`, `--always-approve`, `--no-auto-update`; "the example assumes `grok` is already authenticated locally, or `XAI_API_KEY` is set". Exit codes are not documented. [E] https://docs.x.ai/build/cli/headless-scripting (read 2026-11-08, summary).
- **Permissions and sandbox.** Modes ask, auto, always-approve; `deny` rules always win; `grok --sandbox <profile>` with `workspace`, `read-only`, `strict` (Landlock on Linux, Seatbelt on macOS); child-network blocking is "Enforced on Linux only; no-op on macOS". "Built-ins do not permanently protect paths such as `~/.ssh`". [E] https://docs.x.ai/build/features/permissions and https://docs.x.ai/build/features/sandbox (read 2026-11-08, raw `.md`). A `read-only` profile is a good fit for a reviewer [I].
- **Auth routes.** Browser OIDC and device code for interactive use, `XAI_API_KEY` for "Scripts, CI/CD, headless automation". Credential resolution order: `model.api_key`, `model.env_key`, active session token, then `XAI_API_KEY`. [E] https://docs.x.ai/build/enterprise (read 2026-11-08, summary).
- **Subscription versus API.** One shared weekly pool per seat for Grok, Build, API and other surfaces: "you get one shared weekly usage pool that you can spend however you like across any Grok product"; Extra Usage Credits "are priced at standard rates, which means the cost per action is higher"; usage breakdown by "API, Build, Chat, Imagine, Voice". API billing is tracked at the team level. [E] https://docs.x.ai/grok/faq (read 2026-11-08, summary) and https://docs.x.ai/x-subscription/usage-limits (raw). Current plans: Plus $8, Premium $30 (4x), Super $100 (15x), Ultra $200 (50x); "Existing Cursor, SuperGrok, and X Premium plans continue". [E] https://docs.x.ai/x-subscription/pricing (raw). Absolute limits are not published as numbers on these pages.
- **Third-party use of the subscription.** Warp documents an OAuth bridge, "xAI determines eligible tiers and usage limits", and says "A connected subscription does not apply to cloud runs". [E] https://docs.warp.dev/agents/inference/grok-subscription/ (summary). That is Warp's statement, not xAI's.
- **Plugin from xAI itself.** `xai-org/grok-build-plugin-cc` (275 stars, pushed 2026-11-07) lets Claude Code "delegate reviews, rescue tasks" to the `grok` CLI and requires "A logged-in Grok CLI session". [E] https://github.com/xai-org/grok-build-plugin-cc (README, 2026-11-08). [I] xAI treats subscription-logged-in headless reviews launched from another tool as a supported pattern, but this is a README, not a terms clause.
- **Unverified.** xAI's Terms of Service and any acceptable-use text on automation. `x.ai/legal/*` returned HTTP 403 to both the fetch tool and `curl`, and `docs.x.ai/grok/faq` is silent on it. The owner should read https://x.ai/legal/terms-of-service in a browser before running a subscription-authenticated loop [U]. Safe fallback: use `XAI_API_KEY`, which xAI labels for CI.

### 3.3 OpenCode Go

- **What it is.** "OpenCode Go gives you reliable access to popular open coding models, with three monthly plans": Go $10, Go Plus $40, Go Teams $20/member. You "get your API key" from the Console and connect it with `/connect`. "It's completely optional". [E] https://opencode.ai/docs/go/ (read 2026-11-08, raw HTML plus summary).
- **Models.** Page lists GLM-5.3, GLM-5.2, Kimi K3.1 Pro, Kimi K2.7 Code, DeepSeek V4 Pro, Qwen3.8 Max, MiniMax M3, MiMo, Hy3/Hy4, plus "Claude Haiku 5.5", "Grok 4.7", "GPT 6 Luna", "GPT 5.6 Luna", "Gemini 4 Argon", and three free models; "the list may change". [E] same URL (summary). [I] Go therefore gives access to a Claude, a Grok and a GPT family model for the cross-model reviewer role, at the Go caps.
- **Limits.** Per-model monthly dollar limit; "5-hour — 20% of the monthly limit; weekly — 50%; and monthly — 100%". Examples on Go: GLM-5.3-Flash $60, Kimi K2.7 Code $60, DeepSeek V4.1 Flash $100, Kimi K3.1 Pro $15, Grok 4.7 $15, Claude Haiku 5.5 $15. Each response reports usage as `opencode.allowance`. Beyond limits: optional "Extra Usage" pay-as-you-go if you hold a Console balance. [E] same URL (raw HTML).
- **Where it may be used.** "OpenCode Go is designed for OpenCode and other coding agents that produce similar types of requests. Traffic is monitored for abuse that degrades the experience for other users." Clients should "Identify itself with its own user agent ... rather than a generic SDK or HTTP-library name" and "Send a stable session ID in `x-opencode-session`". Validated clients: Hermes, Claude Code, Codex, ZCode, Pi, jcode, Kilo Code CLI; direct endpoints are documented. "Go and Go Plus are for workspaces with a single member"; "Service accounts are not covered by Go Teams". [E] same URL. [I] So `opencode run` in a daemon is the intended use; a hand-rolled `curl` loop with a generic user agent is what the page warns against.
- **Headless and CI.** Not addressed on the Go page. [U] for any explicit policy. Separately, the CLI page says `opencode run` is "designed for scripts, CI jobs, and other workflows". [E] https://docs.opencode.ai/docs/cli/ (summary of a first fetch, read 2026-11-08).
- **CLI surface.** `opencode run [prompt]` with `--model provider/model`, `--format json`, `--agent`, `--continue`, `--session`, `--fork`, `--file`, `--auto` ("Auto-approve permissions not explicitly denied"); `opencode serve` (HTTP API, `OPENCODE_SERVER_PASSWORD` for basic auth); `opencode github install|run`; env `OPENCODE_PERMISSION` (inline JSON permissions), `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_CONFIG_CONTENT`. [E] https://docs.opencode.ai/docs/cli/ (read 2026-11-08, summary).
- **`opencode github`.** Triggers on `/opencode` or `/oc` comments, plus `issues`, `pull_request`, `schedule`, `workflow_dispatch`; model as `provider/model`; runs "inside your GitHub's runners"; OIDC to the OpenCode GitHub App by default or `use_github_token: true`. The docs do not describe who is allowed to trigger it on a public repo [U]. [E] https://docs.opencode.ai/docs/github/ (summary). For an untrusted-input setting prefer your own daemon over this Action [I].
- **Project health.** `anomalyco/opencode`, MIT, 225k stars, last push 2026-11-08, latest release v2.2.6 on 2026-11-06 [E] `gh repo view anomalyco/opencode`, `gh release list` (2026-11-08).
- **Anthropic subscription inside OpenCode.** Not permitted by the Anthropic text in 3.1 (third-party harness routing plan credentials). The OpenCode GitHub docs show `ANTHROPIC_API_KEY`, an API key, for Claude [E: https://docs.opencode.ai/docs/github/]. Use an API key there or use `claude` directly.

### 3.4 What to do about the unknowns

| Unknown | Cheapest way to close it |
|---|---|
| xAI ToS on subscription-authenticated automation | Read https://x.ai/legal/terms-of-service in a browser; or use `XAI_API_KEY` |
| OpenCode Go and unattended use | Email OpenCode support or ask in their Discord/GitHub; meanwhile send a distinct user agent and session ID (they ask for it) |
| Claude: does a 24/7 daemon exceed "ordinary, individual usage" | Cap the daemon (section 7); prefer API key for the bulk |
| Whether Anthropic's June pause becomes a change again | Re-read https://support.claude.com/en/articles/15036540 before each billing month |

### 3.5 Orchestrators and harnesses that already exist

All numbers from `gh repo view` on 2026-11-08.

| Project | What it is (owner's README) | Stars | Last push | Fit |
|---|---|---|---|---|
| `slaid098/orch` | Label `agent:queued` on an issue; Claude Code in a worker container with no GitHub token; orchestrator opens the PR, waits for checks, runs two read-only reviewer containers, squash-merges only when both return no findings; accepts feedback comments only from the issue author and an allowlist; 3 attempts then `needs-human` | 0 | 2026-11-04 | Best design reference for the gate; no license file [E: https://github.com/slaid098/orch] |
| `sean1588/herdr-orchestrator` | Label an issue; daemon spawns an agent in a worktree, spawns a second agent to review, merges "once CI is green and the branch is mergeable"; "Every merge is decided by GitHub's own signals, never by an agent's say-so"; supports Claude Code, Codex, Grok CLI | 6 | 2026-10-12 | Closest match to this plan; depends on herdr panes [E: https://github.com/sean1588/herdr-orchestrator] |
| `BruceBGordon/issue-orchestrator` | Agents on GitHub issues in isolated worktrees, "with guardrails" | 11 | 2026-11-08 | Small; only the repo description was checked [U] |
| `mraza007/baton` | Python daemon polling GitHub Issues, worktrees, opens PRs | 28 | 2026-03-27 | Stale (7 months) |
| `ryanmac/code-conductor` | Claude-only GitHub-native parallel agents | 114 | 2026-03-30 | Stale |
| `openai/symphony` | Spec plus Elixir reference for Codex; control plane is a Linear board; "a low-key engineering preview for testing in trusted environments" | 27,972 | 2026-09-15 | Wrong tracker (Linear), Codex-oriented [E: https://github.com/openai/symphony] |
| `ComposioHQ/agent-orchestrator` | Desktop plus daemon fleets of agents from task to merged PR; Claude Code, Codex and 35+ agents | 14,257 | 2026-11-08 | Heavy; the other two names (`OrchestratorInc`, `AgentWrapper`) resolve to the same repository in `gh` |
| `OpenHands/OpenHands` | General agent platform, MIT | 92,927 | 2026-11-08 | I could not open its GitHub-resolver docs (404 on the URL I tried), so its issue-to-PR mode is not verified here [U] |
| `sweepai/sweep` | Now "AI coding assistant for JetBrains"; last push 2025-09-18 | 7,706 | 2025-09-18 | Not an issue-to-PR bot any more; skip |

[I] Nothing here is a standard. The two with the right shape (orch, herdr-orchestrator) are single-author and under a month or two of activity, so copy ideas (no token for the worker, separate read-only reviewer, merge by GitHub signals, attempt caps) rather than adopt them wholesale.

---

## 4. GitHub features that carry the gate

### 4.1 Rulesets and required checks

Rulesets are "available in public repositories with GitHub Free ... and in public and private repositories with GitHub Pro, GitHub Team, and GitHub Enterprise Cloud". [E] https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets (raw). So a private repo on a Free personal plan has no rulesets; branch protection is the older route, and its availability on private Free repos is not stated on the pages I read [U]. Check `gh api repos/gdorsi/opfs-lsm/rulesets` and the settings page before designing around it.

Branch protection options that matter: required status checks (strict mode requires an up-to-date branch), required reviews or code owner review, "Do not allow bypassing" (otherwise admins are exempt), dismiss stale approvals, and "require approval of the most recent reviewable push" ("someone other than the person who pushed it"). [E] https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches (summary).

### 4.2 Auto-merge

"People with write permissions to a repository can enable auto-merge for a pull request"; "Auto-merge merges a pull request automatically after all required reviews and status checks pass"; it is "disabled if someone without write permissions pushes new changes to the head branch". The option appears on PRs that cannot merge immediately because of required checks or reviews. [E] https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request (summary). Plan availability is not on that page [U].

### 4.3 CODEOWNERS and who may approve

A required code-owner review blocks merge until the owner approves. [E] 4.1 page. Whether a PR author may approve their own PR is not stated on that page [U]; GitHub's UI does not let you approve your own PR in practice [I, not cited]. Design consequence: if the daemon pushes as the owner's own account, "required approving review" cannot be met by an agent. Use a separate bot or machine-user identity for pushing, and let the owner's `/approve`-equivalent be the label (5.3), not a GitHub review.

### 4.4 Merge queue

"Pull request merge queues are available in any public repository owned by an organization, or in private repositories owned by organizations using GitHub Enterprise Cloud." [E] https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue (raw). `gdorsi/opfs-lsm` is user-owned, so no merge queue unless the repo moves to an organization (which is free to create) and goes public [I]. If it does: workflows need `on: merge_group` or required checks never report. [E] same page (summary). Without a queue, use strict "up to date" required checks to avoid two green-but-conflicting PRs merging in sequence [I].

### 4.5 Where CI runs

Self-hosted runners are free; standard GitHub-hosted runners in public repos are free; private repos on Free get a dollar allowance ($12/month) and macOS runners cost $0.062/min against $0.006/min for Linux 2-core. [E] https://docs.github.com/en/billing/concepts/product-billing/github-actions (summary; the "about 10 times" figure is the fetch tool's arithmetic). Your existing CI already runs Chrome on `ubuntu-latest` [R]. Whether `ubuntu-latest` Chrome gives the same OPFS and SharedWorker behaviour you need on macOS Chrome is a project question, not a tooling one [I].

### 4.6 Workflows triggered by agent pushes

"GitHub doesn't trigger workflows on commits made with the default `GITHUB_TOKEN`." Push with a GitHub App token, a machine-user token or a deploy key instead, or CI will not run on the agent's branch and required checks will hang. [E] https://code.claude.com/docs/en/github-actions (Troubleshooting, summary; this is Anthropic restating GitHub behaviour, I did not find the GitHub page that states it).

### 4.7 Copilot and other review bots

Not researched; the plan uses a cross-model reviewer you control, which is the stated goal. Only add Copilot review if it is already in the owner's plan [U].

---

## 5. Recommended architecture for the spare laptop

### 5.1 Run mode: poll, do not tunnel, do not self-host a runner

| Option | Verdict | Reason |
|---|---|---|
| Self-hosted Actions runner on the laptop | No, unless the repo stays private and you accept it | GitHub: self-hosted runners "should almost never be used on public repositories" because "any user can open pull requests against the repository and compromise the environment"; ephemeral runners do not fully fix it ("no way to guarantee that a self-hosted runner only runs one job"), and re-using hardware for JIT runners "can risk exposing information". [E] https://docs.github.com/en/actions/reference/security/secure-use (summary) |
| Webhooks through a tunnel (Tailscale Funnel or cloudflared) | Not needed | Funnel works and is "in beta", ports 443/8443/10000 only, macOS needs the open-source variant, "non-configurable bandwidth limits" [E] https://tailscale.com/kb/1223/funnel (summary). You would add a public endpoint to a laptop to save at most a minute of latency [I]. cloudflared was not researched [U] |
| launchd polling daemon with `gh` | Yes | No inbound surface; outbound HTTPS only; GitHub stays the source of truth [I] |

Use `gh api` or `gh issue list` on a 60 to 120 second `StartInterval`, plus a `KeepAlive` job; a poll that finds nothing costs no model tokens. REST rate-limit headroom was not checked [U]; use conditional requests with ETags if polling gets frequent.

### 5.2 Laptop hardening

- **Separate macOS user** (`factory`), standard (non-admin), no access to the owner's `~`, Keychain or SSH keys. Chrome, Node, pnpm, Rust toolchain installed for that user. This is the real isolation boundary; Claude's and Grok's sandboxes both leave `~/.ssh` readable by default (3.1, 3.2). [I]
- **Worktrees**: one per issue under the `factory` user's workspace; delete after merge or abort. A worktree isolates files, not credentials or the network [I].
- **Containers**: Claude's sandbox docs say `docker` is incompatible with the sandbox and Chromium needs user namespaces (3.1), and macOS containers run a Linux VM, which does not give you macOS Chrome. Real-Chrome verification on macOS is another reason to keep the agent on the host under a separate user and run the heavy Chrome proof on hosted Linux CI [I].
- **Sleep and power**: `caffeinate -s` creates "an assertion to prevent the system from sleeping ... valid only when system is running on AC power" and takes a utility so the assertion lasts only while it runs (`man caffeinate`, macOS on this machine). `pmset -g` on this machine showed `sleep 1 (sleep prevented by ... caffeinate ...)` and `powernap 1`. Wrap the daemon as `caffeinate -s <daemon>` in the launchd plist, keep the lid open or use clamshell mode on AC with a display or dummy plug [I, clamshell behaviour not verified]. A daemon that wakes from sleep must tolerate a stale poll cursor and missed time [I].
- **Secrets**: the Claude token lives only in the `factory` user's environment file (mode 0600) or its Keychain, never in a repo secret that a fork workflow could read. Claude stores its own login in the macOS Keychain, and falls back to `~/.claude/.credentials.json` mode 0600 when the Keychain is locked, as in an SSH session [E: https://code.claude.com/docs/en/authentication, summary]. Because a launchd job is not a login session, the Keychain may be locked, so prefer `CLAUDE_CODE_OAUTH_TOKEN` from a file for the daemon [I].
- **GitHub identity**: a fine-grained token or GitHub App scoped to this one repository with Contents, Pull requests, Issues write and nothing else (no Actions, Workflows or Administration). Claude's official App requests a much broader permission set (Actions write, Administration read, Workflows write, Repository hooks write) and "GitHub doesn't let you accept a subset"; for a smaller set create your own App. [E] https://code.claude.com/docs/en/github-actions (GitHub App permissions)
- **Updates**: pin the agent CLIs and disable auto-update inside the daemon (`grok --no-auto-update`, `OPENCODE_DISABLE_AUTOUPDATE`) so an update does not change behaviour mid-run [E: headless-scripting and CLI pages above].

### 5.3 The approval gate (owner-opened or owner-approved only)

State machine, labels as the visible state, the daemon's local ledger as the source of truth:

```
(no label) --owner opens issue, or owner applies `factory:approved`--> approved
approved --daemon claims--> factory:running
running --PR opened--> factory:review
review --reviewer verdict ok + checks green--> factory:merge-ready --> merged (GitHub auto-merge)
any --3 attempts, budget hit, or gate failure--> factory:needs-human
```

Gate rules, in order, evaluated by the daemon before every transition:

1. **Authority is the owner's login, from the API, not from text.** Eligible if `issue.user.login == "gdorsi"` at creation, or the most recent `labeled` event for `factory:approved` in `GET /repos/{r}/issues/{n}/events` has `actor.login == "gdorsi"`. Never trust a comment that says "approved". [I; the events API is standard GitHub REST, not fetched here]
2. **The label must be unmodified since approval.** Record the issue body's hash and `updated_at` when approving; if the body was edited by anyone else afterwards (check `issue.updated_at` and the `edited` events), drop to `needs-human`. [I]
3. **Only the owner can label.** On a user-owned repo only the owner and invited collaborators can apply labels [I; the permissions page for personal repositories returned 404 so this is not cited]. Do not add collaborators with triage access, or add them to the allowlist deliberately.
4. **Feedback comments** from anyone other than the owner are not given to the agent (orch does the same: "Only comments from the issue author and logins listed in `feedback.allowed_users` are accepted" [E: https://github.com/slaid098/orch]). `claude-code-action` offers `include_comments_by_actor` for the same reason [E: security.md].
5. **PRs the daemon did not open are never touched.** Only PRs whose head branch, author identity and recorded issue ID match the ledger enter the review or merge path. This blocks fork PRs and "approved" labels on someone else's PR entirely [I].

Prompt-injection posture [I unless noted]:

- The agent prompt is a fixed template; issue title and body go into a delimited data block with the instruction that nothing inside it is a command. Anthropic's own advice: "Beware of potential hidden markdown when tagging Claude on untrusted content ... HTML comments, invisible characters, hidden attributes", and its sanitiser "may [be bypassed by] new techniques" [E: security.md]. Because only owner-authored or owner-approved issues enter, the exposure is the owner's own text plus anything the agent fetches (web pages, dependency READMEs, other issues). Disable web tools for the author agent where you can.
- The author agent has no GitHub token and no merge power (as in orch). The daemon pushes and opens the PR after validating the diff. A hijacked agent can then only produce a bad diff, which review and the diff allowlist catch.
- The diff allowlist: reject any PR touching `.github/`, `.claude/`, `.agents/`, `.mcp.json`, `AGENTS.md`, `CLAUDE.md`, lockfile-only changes that add new packages, `package.json` `scripts`, or install hooks, unless the owner labels `factory:allow-infra`. Those are the paths where an agent edit becomes code execution on the next run [I; consistent with Anthropic restoring `.claude/`, `.mcp.json`, `.husky/` from the base branch in the Action, security.md].
- Run agents against the daemon's own pinned copy of the agent config, not whatever is in the checkout: for Claude use `--bare` (needs an API key) or a managed settings file, and for OpenCode set `OPENCODE_DISABLE_PROJECT_CONFIG`. This closes the "repo-supplied hooks run under `-p`" hole in 3.1 [I from E].

### 5.4 Review and merge

1. Daemon opens the PR from a branch on the repo (not a fork), body generated from a template with no AI trace (section 2).
2. CI runs on GitHub-hosted runners. Required checks: tests, `static`, `bench:smoke`, two-tab proof [R names].
3. Reviewer agent, a different model family from the author, runs read-only: Grok CLI with `--sandbox read-only` and a `deny`-all write rule (3.2), or `opencode run --agent <review-agent>` with permissions denying edit and bash writes through `OPENCODE_PERMISSION` (3.3), or `claude -p --allowedTools "Read,Grep,Bash(git diff *)"` with `--permission-mode dontAsk` (3.1). It returns JSON: `{head_sha, verdict: pass|block, findings[]}` (use `--json-schema` for Claude [E: headless page]). The daemon rejects any verdict whose `head_sha` is not the current PR head.
4. Daemon posts the verdict as a PR comment and a commit status or check named `factory/review`. Make `factory/review` a required check. Only the daemon's identity can set it, and a new push resets it [I].
5. Merge: `gh pr merge --auto --squash` once; GitHub merges when required checks and reviews are green. The agent never calls merge. For hardening, enable "Do not allow bypassing" so even the owner token the daemon might use cannot bypass [E: 4.1].
6. Post-merge: daemon records the merge SHA, removes the worktree, and closes the issue.

### 5.5 Cross-model review, concretely

- Author Claude, reviewer Grok (or a Go model) and the reverse on alternate days. Models from different families tend to miss different things [I, general expectation, no measurement here]. The Go plan lets one subscription cover several families (3.3).
- Give the reviewer a rubric from `docs/verification.md` and the project's `AGENTS.md` principles ("read/write performance above everything", "KISS", "Never use fake-indexeddb on benchmarks") [R]. Make the rubric a file in the daemon's own config, not the PR branch.
- The reviewer sees the diff and may run tests read-only; it never sees the author's chain of thought, only the PR.
- A `block` verdict returns findings to the author as a new attempt. Count attempts across both CI failures and review rounds, cap at 3 (as orch does).

### 5.6 Audit trail and failure guards

- Append-only JSONL ledger per run on the `factory` user: issue number, approval event id and actor, model, CLI version, prompt hash, `total_cost_usd` (from `claude -p --output-format json` [E]) or `opencode.allowance` (3.3), exit code, PR number, head SHA, verdict, merge SHA, timestamps. Mirror a one-line summary as an issue comment so the owner sees it in GitHub.
- Loop guards: maximum 3 attempts per issue; one run at a time per repo; a lock file; exponential backoff on `rate_limit` or `overloaded` errors (Claude emits an `api_retry` event with an `error` category [E: headless page]); hard wall-clock timeout per run, then SIGINT, then SIGTERM (143 on Claude [E]).
- Kill switch: a `factory:pause` label on the repo's pinned issue, or a file `~/.factory/PAUSE`; the daemon checks it before every claim and every transition.
- Do not let the daemon open issues or label issues as approved. Agents can comment and relabel only among `factory:*` states, never set `factory:approved` [I].

---

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Making the repo public while a self-hosted runner is attached | High | No self-hosted runner (5.1); if you must, JIT runner on a dedicated machine, not this laptop [E: GitHub secure-use] |
| Prompt injection through issue, PR or fetched text leading to code execution on the laptop | High | Separate macOS user; no token for the author agent; diff allowlist; fixed prompt template; pinned config (5.3) |
| Agent edits CI, hooks or agent config to escalate on the next run | High | Path allowlist and config from outside the checkout (5.3) |
| Subscription terms change under you (Anthropic already announced and paused one change) | Medium | Re-read the help article monthly; make the credential swappable (API key) per role [E: 3.1] |
| xAI automation terms unknown | Medium | Read ToS; or use `XAI_API_KEY` [U] |
| 24/7 usage drains the weekly pool you also use interactively | Medium | Per-subscription budgets (section 7), time windows |
| Agent pushes with `GITHUB_TOKEN` and CI never runs | Low | Use an App or machine-user token (4.6) |
| `GITHUB_TOKEN` in workflow gets write by default | Low | Set default token permission to read; raise per job [E: GitHub secure-use] |
| Third-party actions compromised | Medium | Pin actions to a full commit SHA [E: same page] (your workflow uses `@v4` tags, [R]) |
| Self-review: author and reviewer share a blind spot | Medium | Different families plus the real-Chrome CI proof, which neither model can fake |
| Claude Code default co-author trailer or footer leaking into commits | Low (policy) | Daemon rewrites and validates commit messages and PR bodies (section 2) |
| Non-bypassable ruleset unavailable on a private Free repo | Medium | Check plan; or make the repo public, or move it to an org (4.1, 4.4) |

---

## 7. Budgets and usage caps per subscription [I unless cited]

| Subscription | Cap mechanism | Suggested default |
|---|---|---|
| Claude | `--max-budget-usd` and `--max-turns` per run [E: headless page]; daemon-level counter from `total_cost_usd`; stop at a fraction of the weekly window (read via `/status` interactively, there is no documented headless query [U]) | Reserve at least half the weekly window for the owner; run overnight only |
| Grok | Weekly pool shared across Chat, Build, API [E: xAI FAQ]; usage tab in Settings; spending caps for extra usage [E: https://docs.x.ai/x-subscription/pricing lists "Spending caps and alerts"] | Reviewer only, one review per PR |
| OpenCode Go | Per-model monthly dollar cap with 5h/weekly/monthly windows; read `opencode.allowance` per response [E: Go page] | Use cheap models (GLM-5.3-Flash, Kimi K2.7 Code at $60/month on Go) for bulk work; do not turn on Extra Usage without a ceiling |

A per-day issue quota (for example at most 3 claims per day) is the simplest cap that works across all three.

---

## 8. Open questions

1. What plan is `gdorsi` on, and is rulesets or branch protection with non-bypass available for this private repo? (`gh api repos/gdorsi/opfs-lsm/rulesets`, settings page.) [U]
2. Will the repo go public, move to an organization, or stay private? This decides the runner policy and merge queue (4.4, section 6).
3. xAI's Terms on subscription-authenticated automation (3.2). [U]
4. Does OpenCode accept unattended daemon use on Go, in writing? (3.3) [U]
5. Does the Claude sandbox apply under `claude -p`? Test with a deliberately blocked write. [U]
6. Is `ubuntu-latest` Chrome a sufficient proof for OPFS and SharedWorker behaviour, or is a macOS Chrome job (on the laptop, private repo only) required? Project question.
7. Does the OpenHands issue resolver, or `anomalyco/opencode` `github run`, check the commenter's permission on public repos? I could not open the docs (404) or source path; do not use either on a public repo until verified. [U]
8. Is the `static` job defined on `main`? `AGENTS.md` says it is; `m1-smoke.yml` as read has no such job. [U]
9. Review-quality evidence: no measurement here of whether a cross-model reviewer catches more than a same-model one on this codebase. A two-week trial that records `findings` vs later fixes would answer it.

---

## 9. Sources index

- Claude Code authentication, long-lived token: https://code.claude.com/docs/en/authentication
- Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- Claude Code headless and Agent SDK CLI: https://code.claude.com/docs/en/headless
- Claude Code GitHub Actions: https://code.claude.com/docs/en/github-actions
- `claude-code-action` security model: https://github.com/anthropics/claude-code-action/blob/main/docs/security.md
- Claude Code Code Review (managed): https://code.claude.com/docs/en/code-review
- Claude Code sandbox: https://code.claude.com/docs/en/sandboxing
- Agent SDK with your plan (billing pause, Oct 7 update): https://support.claude.com/en/articles/15036540
- Claude Code with Pro/Max/Ultra: https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan
- Anthropic Consumer Terms (effective Oct 8, 2025): https://www.anthropic.com/legal/consumer-terms
- OpenCode Go: https://opencode.ai/docs/go/
- OpenCode CLI: https://docs.opencode.ai/docs/cli/
- OpenCode GitHub: https://docs.opencode.ai/docs/github/
- OpenCode repo: https://github.com/anomalyco/opencode
- Grok Build repo: https://github.com/xai-org/grok-build
- Grok Build headless: https://docs.x.ai/build/cli/headless-scripting
- Grok Build permissions and sandbox: https://docs.x.ai/build/features/permissions, https://docs.x.ai/build/features/sandbox
- xAI plans and usage: https://docs.x.ai/x-subscription/pricing, https://docs.x.ai/x-subscription/usage-limits, https://docs.x.ai/grok/faq
- xAI Claude Code plugin: https://github.com/xai-org/grok-build-plugin-cc
- Warp's Grok subscription page (third party): https://docs.warp.dev/agents/inference/grok-subscription/
- GitHub secure use of Actions: https://docs.github.com/en/actions/reference/security/secure-use
- GitHub rulesets: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- GitHub protected branches: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- GitHub merge queue: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- GitHub auto-merge: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request
- GitHub Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- Tailscale Funnel: https://tailscale.com/kb/1223/funnel
- Orchestrators: https://github.com/slaid098/orch, https://github.com/sean1588/herdr-orchestrator, https://github.com/openai/symphony, https://github.com/ComposioHQ/agent-orchestrator, https://github.com/BruceBGordon/issue-orchestrator, https://github.com/mraza007/baton, https://github.com/ryanmac/code-conductor, https://github.com/OpenHands/OpenHands, https://github.com/sweepai/sweep
- Not fetched, search snippet only: The Register, 2026-05-14, on the since-paused Claude billing change: https://www.theregister.com/ai-ml/2026/05/14/anthropic-tosses-agents-into-the-api-billing-pool/5240748
