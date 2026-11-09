import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, findAttribution, fixerViolations, gatePaths, hiddenFromAgents, matchesGlob, PATHS } from "./policy.ts";

test("globs: prefix, basename anywhere, exact", () => {
  assert.ok(matchesGlob(".github/**", ".github/workflows/x.yml"));
  assert.ok(!matchesGlob(".github/**", "docs/.github"));
  assert.ok(matchesGlob("**/package.json", "package.json"));
  assert.ok(matchesGlob("**/package.json", "packages/kv/package.json"));
  assert.ok(!matchesGlob("**/package.json", "packages/kv/package.json.bak"));
  assert.ok(matchesGlob("Cargo.lock", "Cargo.lock"));
  assert.ok(!matchesGlob("Cargo.lock", "crates/kv/Cargo.lock"));
});

test("gate paths are the owner-only and hidden rows; fixer denials are the deny rows", () => {
  const changed = ["packages/kv/src/a.ts", ".github/workflows/m1-smoke.yml", "factory/decide.ts", ".claude/settings.json", "packages/kv/package.json", "docs/x.md"];
  assert.deepEqual(gatePaths(changed), [".github/workflows/m1-smoke.yml", "factory/decide.ts", ".claude/settings.json"]);
  assert.deepEqual(fixerViolations(changed), [".github/workflows/m1-smoke.yml", "factory/decide.ts", ".claude/settings.json", "packages/kv/package.json"]);
  assert.deepEqual(hiddenFromAgents(), [".claude/**", ".mcp.json"]);
  for (const r of PATHS) if (r.agents === "hidden") assert.equal(r.merge, "owner", `${r.glob}: hidden paths are never reviewed, so the owner merges them`);
});

test("clean redacts tool names and attribution but keeps path context", () => {
  const c = clean("Claude says the .claude/settings.json hook is fine.\nCo-Authored-By: Someone <x@y>\nGenerated with a tool\n\n\n\nDone 🤖");
  assert.equal(c, "the tool says the .claude/settings.json hook is fine.\n\nDone");
});

test("clean is a no-op on the factory's own templates", () => {
  const t = "The factory stopped on 3f9c2e1 and needs you.\n\nTo continue: push a commit (an empty commit retries), merge by hand, or add the factory:hold label.";
  assert.equal(clean(t), t);
});

test("findAttribution: trailers, generated-with, noreply, credits hit; a doc that mentions a vendor does not", () => {
  assert.deepEqual(
    findAttribution([
      { where: "commit:1", text: "fix: x\n\nCo-Authored-By: Bot <noreply@example.com>" },
      { where: "body", text: "🤖 Generated with some tool" },
      { where: "commit:2", text: "docs: compare storage engines used by Anthropic and others" },
      { where: "diff:a.ts", text: "// written with help from Claude" },
      { where: "title", text: "fix(kv): recover every crash state" },
    ]),
    ["commit:1", "body", "diff:a.ts"],
  );
});
