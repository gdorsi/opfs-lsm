/**
 * policy.ts — the factory's rules as data: validated config, the one path table, and the owner rule.
 * No I/O except reading the config file in `loadPolicy`.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import type { Rules, Stage } from "./decide.ts";
import { familyOf } from "./agents.ts";

// ───────────────────────────── config ─────────────────────────────

/** Owner constraint: the fixer is the unmodified `claude -p` on the owner's subscription (OAuth token). */
export interface FixerConfig {
  cli: "claude";
  model: string;
  maxBudgetUsd: number;
  maxTurns: number;
}
/** Owner constraint: the reviewer is non-Anthropic. The type rules out `claude`; loadPolicy rules out Claude models. */
export type ReviewerConfig = { cli: "grok"; model: string } | { cli: "opencode"; model: `${string}/${string}` };

export type AgentConfig = FixerConfig | ReviewerConfig;

export interface Policy {
  repo: { owner: string; name: string };
  rules: Rules;
  pollSeconds: number;
  /** Fallback chain: the first that gives a usable answer wins. All non-Anthropic. */
  reviewers: readonly [ReviewerConfig, ...ReviewerConfig[]];
  fixer: FixerConfig;
  /** Added plus removed lines a single fix commit may carry. */
  maxFixLines: number;
  app: { id: number; installation: number; keyFile: string; botLogin: string; botEmail: string };
  runUser: string; // macOS user that runs agents and checks; has no GitHub credential
  mirrorDir: string; // ~factory/.factory/mirror.git
  worktreeRoot: string; // group-writable dir shared with runUser
  chromePath: string;
  pnpmStore: string;
  cargoTarget: string;
}

const STAGES: readonly Stage[] = ["review", "fix", "merge"];

function expandHome(p: string): string {
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}

/**
 * Read and validate ~/.factory/config.json. Throws once with every problem listed.
 * Checks: every reviewer's family != "anthropic" (the PR author's family) and != fixer family;
 * maxFixes in 1..3; runsPerDay and timeouts positive; keyFile mode 0600; runUser != current user.
 * Families come from agents.ts `familyOf`, the only place that knows CLIs and model ids.
 */
export function loadPolicy(file: string): Policy {
  const problems: string[] = [];
  const raw = JSON.parse(readFileSync(expandHome(file), "utf8")) as Record<string, unknown>;
  const str = (k: string, fallback?: string): string => {
    const v = raw[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (fallback !== undefined) return fallback;
    problems.push(`${k}: required string`);
    return "";
  };
  const num = (k: string, fallback: number, min = 1): number => {
    const v = raw[k];
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !(v >= min)) problems.push(`${k}: number >= ${min}`);
    return typeof v === "number" ? v : fallback;
  };

  const repoStr = str("repo");
  const [owner = "", name = ""] = repoStr.split("/");
  if (!owner || !name) problems.push("repo: expected owner/name");
  const ownerLogin = str("owner", owner);
  const stage = str("stage", "review") as Stage;
  if (!STAGES.includes(stage)) problems.push(`stage: one of ${STAGES.join(", ")}`);

  const fixer = raw.fixer as Partial<FixerConfig> | undefined;
  if (!fixer || fixer.cli !== "claude" || typeof fixer.model !== "string") problems.push('fixer: { cli: "claude", model, maxBudgetUsd, maxTurns }');
  const fixerCfg: FixerConfig = {
    cli: "claude",
    model: fixer?.model ?? "",
    maxBudgetUsd: typeof fixer?.maxBudgetUsd === "number" ? fixer.maxBudgetUsd : 3,
    maxTurns: typeof fixer?.maxTurns === "number" ? fixer.maxTurns : 60,
  };

  const reviewersRaw = (Array.isArray(raw.reviewers) ? raw.reviewers : raw.reviewer ? [raw.reviewer] : []) as Partial<ReviewerConfig>[];
  if (reviewersRaw.length === 0) problems.push("reviewers: at least one of { cli: grok | opencode, model }");
  const reviewers: ReviewerConfig[] = [];
  reviewersRaw.forEach((r, i) => {
    if ((r.cli !== "grok" && r.cli !== "opencode") || typeof r.model !== "string") {
      problems.push(`reviewers[${i}]: { cli: grok | opencode, model }`);
      return;
    }
    if (r.cli === "opencode" && !/^[^/]+\/.+$/.test(r.model)) problems.push(`reviewers[${i}].model: provider/model`);
    const cfg = r as ReviewerConfig;
    const fam = familyOf(cfg);
    if (fam === "anthropic") problems.push(`reviewers[${i}]: model is Anthropic, same family as the author and the fixer`);
    if (fam === familyOf(fixerCfg)) problems.push(`reviewers[${i}]: same family as the fixer`);
    reviewers.push(cfg);
  });

  const app = (raw.app ?? {}) as Partial<Policy["app"]>;
  if (typeof app.id !== "number" || typeof app.installation !== "number" || typeof app.keyFile !== "string") problems.push("app: { id, installation, keyFile }");
  const keyFile = expandHome(app.keyFile ?? "");
  if (keyFile) {
    try {
      const mode = statSync(keyFile).mode & 0o777;
      if (mode & 0o077) problems.push(`app.keyFile: mode must be 0600 (is ${mode.toString(8)})`);
    } catch {
      problems.push(`app.keyFile: cannot stat ${keyFile}`);
    }
  }

  const runUser = str("runUser", "factoryrun");
  if (runUser === userInfo().username) problems.push("runUser: must differ from the daemon's user");

  const maxFixes = num("maxFixes", 2);
  if (maxFixes > 3) problems.push("maxFixes: at most 3");
  const perDay = (raw.runsPerDay ?? {}) as Partial<Record<string, number>>;
  const timeoutsMin = (raw.timeoutMinutes ?? {}) as Partial<Record<string, number>>;
  const positive = (v: number | undefined, fallback: number, label: string): number => {
    if (v === undefined) return fallback;
    if (!(v > 0)) problems.push(`${label}: positive number`);
    return v;
  };

  const rules: Rules = {
    owner: ownerLogin,
    trunk: str("trunk", "main"),
    stage,
    maxFixes,
    maxErrors: num("maxErrors", 2),
    runsPerDay: {
      review: positive(perDay.review, 30, "runsPerDay.review"),
      verify: positive(perDay.verify, 40, "runsPerDay.verify"),
      fix: positive(perDay.fix, 12, "runsPerDay.fix"),
    },
    timeoutMs: {
      review: positive(timeoutsMin.review, 20, "timeoutMinutes.review") * 60_000,
      verify: positive(timeoutsMin.verify, 45, "timeoutMinutes.verify") * 60_000,
      fix: positive(timeoutsMin.fix, 30, "timeoutMinutes.fix") * 60_000,
    },
    graceMs: 10 * 60_000,
    backoffMs: num("backoffMinutes", 30) * 60_000,
    settleMs: num("settleMinutes", 5, 0) * 60_000,
  };

  if (problems.length > 0) throw new Error(`config ${file}:\n  ${problems.join("\n  ")}`);
  const home = homedir();
  return {
    repo: { owner, name },
    rules,
    pollSeconds: num("pollSeconds", 60, 10),
    reviewers: reviewers as [ReviewerConfig, ...ReviewerConfig[]],
    fixer: fixerCfg,
    maxFixLines: num("maxFixLines", 200),
    app: {
      id: app.id as number,
      installation: app.installation as number,
      keyFile,
      botLogin: app.botLogin ?? "opfs-lsm-factory[bot]",
      botEmail: app.botEmail ?? `${app.id}+opfs-lsm-factory[bot]@users.noreply.github.com`,
    },
    runUser,
    mirrorDir: expandHome(str("mirrorDir", `${home}/.factory/mirror.git`)),
    worktreeRoot: expandHome(str("worktreeRoot", "/Users/Shared/factory-work")),
    chromePath: str("chromePath", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    pnpmStore: expandHome(str("pnpmStore", `/Users/${runUser}/.factory/pnpm-store`)),
    cargoTarget: expandHome(str("cargoTarget", `/Users/${runUser}/.factory/cargo-target`)),
  };
}

// ───────────────────────────── paths: one table, three uses ─────────────────────────────

export interface PathRule {
  glob: string;
  /** May the fixer's patch change it? */
  fixer: "allow" | "deny";
  /** May a PR that changes it land without the owner? */
  merge: "auto" | "owner";
  /** Present in agent worktrees? Hidden paths are never reviewed, so they are always merge: "owner". */
  agents: "visible" | "hidden";
  why: string;
}

/** The only list of special paths. Everything not listed: fixer allow, merge auto, visible. */
export const PATHS: readonly PathRule[] = [
  { glob: ".github/**", fixer: "deny", merge: "owner", agents: "visible", why: "workflows; the App lacks the workflows permission anyway" },
  { glob: "factory/**", fixer: "deny", merge: "owner", agents: "visible", why: "the gate itself, including SUITE" },
  { glob: ".claude/**", fixer: "deny", merge: "owner", agents: "hidden", why: "hooks would run under claude -p" },
  { glob: ".mcp.json", fixer: "deny", merge: "owner", agents: "hidden", why: "MCP servers would start under claude -p" },
  { glob: ".agents/**", fixer: "deny", merge: "auto", agents: "visible", why: "verification skills" },
  { glob: "AGENTS.md", fixer: "deny", merge: "auto", agents: "visible", why: "agent instructions" },
  { glob: "CLAUDE.md", fixer: "deny", merge: "auto", agents: "visible", why: "agent instructions" },
  { glob: "**/package.json", fixer: "deny", merge: "auto", agents: "visible", why: "scripts and dependencies" },
  { glob: "pnpm-lock.yaml", fixer: "deny", merge: "auto", agents: "visible", why: "dependencies" },
  { glob: "pnpm-workspace.yaml", fixer: "deny", merge: "auto", agents: "visible", why: "workspace shape" },
  { glob: ".npmrc", fixer: "deny", merge: "auto", agents: "visible", why: "registry and install behaviour" },
  { glob: "**/Cargo.toml", fixer: "deny", merge: "auto", agents: "visible", why: "dependencies" },
  { glob: "Cargo.lock", fixer: "deny", merge: "auto", agents: "visible", why: "dependencies" },
  { glob: ".oxlintrc.json", fixer: "deny", merge: "auto", agents: "visible", why: "a fix must not weaken lint" },
  { glob: ".fallowrc.json", fixer: "deny", merge: "auto", agents: "visible", why: "a fix must not weaken dead-code checks" },
  { glob: "bench/size/rows.ts", fixer: "deny", merge: "auto", agents: "visible", why: "a fix must not raise size budgets" },
  { glob: "packages/kv/wasm/**", fixer: "deny", merge: "auto", agents: "visible", why: "built artifacts" },
];

/** `dir/**` = prefix, `**\/name` = basename anywhere, otherwise an exact path. */
export function matchesGlob(glob: string, path: string): boolean {
  if (glob.endsWith("/**")) return path.startsWith(glob.slice(0, -2));
  if (glob.startsWith("**/")) {
    const name = glob.slice(3);
    return path === name || path.endsWith(`/${name}`);
  }
  return path === glob;
}

function rulesFor(path: string): PathRule[] {
  return PATHS.filter((r) => matchesGlob(r.glob, path));
}

/** Changed paths that need the owner to merge. Feeds Pr.gatePaths. */
export function gatePaths(paths: readonly string[]): string[] {
  return paths.filter((p) => rulesFor(p).some((r) => r.merge === "owner" || r.agents === "hidden"));
}
/** Changed paths the fixer was not allowed to touch. Checked by github.ts before pushing a fix. */
export function fixerViolations(paths: readonly string[]): string[] {
  return paths.filter((p) => rulesFor(p).some((r) => r.fixer === "deny"));
}
/** Sparse-checkout exclusions for agent worktrees. */
export function hiddenFromAgents(): string[] {
  return PATHS.filter((p) => p.agents === "hidden").map((p) => p.glob);
}

// ───────────────────────────── the owner rule ─────────────────────────────

declare const cleanBrand: unique symbol;
/** Text that may be written to GitHub or into a commit. Only `clean` mints it. */
export type CleanText = string & { readonly [cleanBrand]: true };

/** Vendor, model and CLI names that never belong in what the factory writes. Case-insensitive, word-bounded. */
const NAMES: readonly RegExp[] = [
  /\bclaude(?:[ -]code)?\b/gi,
  /\banthropic\b/gi,
  /\b(?:opus|sonnet|haiku|fable|mythos)(?:[ -]?\d[\d.]*)?\b/gi,
  /\bgrok(?:[ -]?\d[\d.]*)?\b/gi,
  /\bx\.?ai\b/gi,
  /\bopencode\b/gi,
  /\bopenai\b/gi,
  /\bgpt[ -]?\d[\w.-]*/gi,
  /\bgemini\b/gi,
  /\bcopilot\b/gi,
  /\bcodex\b/gi,
  /\bllms?\b/gi,
  /\bas an ai\b/gi,
  /\bai[ -](?:assist\w*|generat\w*|agent|model|review\w*|written|authored)\b/gi,
];
/** Lines or phrases that are attribution by shape. */
const ATTRIBUTION: readonly RegExp[] = [
  /^[\s/*#-]*co-authored-by:.*$/gim,
  /^[\s/*#-]*signed-off-by:.*$/gim,
  /\bgenerated (?:with|by)\b[^\n]*/gi,
  /\bnoreply@anthropic\.com\b/gi,
  /\u{1F916}/gu,
];

function inPathContext(text: string, index: number): boolean {
  // ".claude/settings.json", "~/.claude", "factory/.claude/**": a leading dot or slash marks a path.
  const before = text.slice(Math.max(0, index - 2), index);
  return /[./~]$/.test(before);
}

function redact(text: string, patterns: readonly RegExp[], replacement: string, keepPaths: boolean): string {
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, (m, ...args) => {
      const index = args[args.length - 2] as number;
      const whole = args[args.length - 1] as string;
      return keepPaths && inPathContext(whole, index) ? m : replacement;
    });
  }
  return out;
}

/**
 * For prose the factory posts (status lines, findings, comments, commit subjects from the fixer).
 * Redacts attribution phrases and vendor/model/CLI names outside path context (".claude/" survives,
 * "Claude says" does not), strips trailer-shaped lines, strips the robot marker, and truncates to `max`.
 * Factory templates go through it too; tests assert it is a no-op on them.
 */
export function clean(text: string, max = 65_000): CleanText {
  let out = redact(text, ATTRIBUTION, "", false);
  out = redact(out, NAMES, "the tool", true);
  out = out.replace(/\b(the|a|an) the tool\b/gi, "the tool");
  out = out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  if (out.length > max) out = `${out.slice(0, max - 1)}…`;
  return out as CleanText;
}

/**
 * Strict scan for evidence of AI assistance. Used for the merge gate (PR commit messages, title, body,
 * added lines) and for fix patches (added lines). Returns the `where` labels that hit.
 * Narrower than `clean`: a research doc that discusses a vendor is not attribution; a trailer or a
 * "Generated with" line, a vendor noreply address, the robot marker, or a tool name used as a credit is.
 */
export function findAttribution(texts: readonly { where: string; text: string }[]): string[] {
  const hits: string[] = [];
  for (const { where, text } of texts) {
    if (ATTRIBUTION.some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(text))) hits.push(where);
    else if (/\b(?:generated|written|authored|made|created|built|implemented|fixed|drafted|produced|assisted|reviewed|co-?authored|help(?:ed)?|pair(?:ed)?)\s+(?:\w+\s+){0,3}?(?:with|by|from|using|via)\s+(?:the\s+)?(?:claude|anthropic|copilot|codex|chatgpt|gpt)/i.test(text)) hits.push(where);
  }
  return hits;
}
