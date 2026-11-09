/**
 * boundaries.test.ts — the module rules that keep the gate a gate, checked on the source text.
 * An agent that takes the shortest path that compiles fails here instead of in production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const DIR = new URL("./", import.meta.url);

/**
 * Allowed runtime imports between factory modules (type-only imports are free). `node:*` builtins are
 * allowed everywhere except `node:child_process`, which must be listed. A module not in this table fails.
 */
const DAG: Record<string, readonly string[]> = {
  "decide.ts": [], // pure
  "policy.ts": ["agents.ts"], // familyOf for the reviewer-independence check
  "sandbox.ts": ["node:child_process"], // the only way to run anything as the run user
  "workspace.ts": ["node:child_process", "policy.ts"], // git as the daemon's user; hiddenFromAgents
  "verify.ts": ["sandbox.ts"],
  "agents.ts": ["sandbox.ts"],
  "github.ts": ["decide.ts", "policy.ts", "workspace.ts"],
  "main.ts": ["decide.ts", "github.ts", "policy.ts", "workspace.ts", "agents.ts", "verify.ts", "sandbox.ts"],
};

/** Source modules (not tests) and their text with comments removed. */
function sources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const text = readFileSync(new URL(f, DIR), "utf8");
    out.set(f, stripComments(text));
  }
  return out;
}

/**
 * Drop comment lines (`//`, `/*`, ` * `, `*\/`). A full tokenizer would also catch trailing comments, but
 * strings such as "dir/**" make regex-based block stripping eat code, and every check here is about code.
 */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n");
}

/** Runtime import specifiers: `import x from`, `import { a, type B } from`, `import "x"`, `export … from`. Skips `import type` / `export type`. */
export function runtimeImports(src: string): string[] {
  const specs: string[] = [];
  const re = /^\s*(import|export)\s+(?!type\b)([^;]*?)\s*from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) {
    if (m[1] === "export" && !/[{*]/.test(m[2] ?? "")) continue; // `export const x = …` is not a re-export
    specs.push((m[3] ?? m[4])!);
  }
  return specs.map((s) => s.replace(/^\.\//, ""));
}

test("runtime imports follow the DAG", () => {
  const files = sources();
  for (const [file, src] of files) {
    const allowed = DAG[file];
    assert.ok(allowed, `${file} is not in the DAG; add it deliberately`);
    for (const spec of runtimeImports(src)) {
      if (spec.startsWith("node:") && spec !== "node:child_process") continue;
      assert.ok(allowed.includes(spec), `${file} imports ${spec} at runtime; allowed: ${allowed.join(", ") || "nothing"}`);
    }
    assert.ok(!/\bimport\s*\(/.test(src), `${file} uses a dynamic import`);
    assert.ok(!/\brequire\s*\(/.test(src), `${file} uses require()`);
  }
});

test("decide.ts imports nothing at runtime", () => {
  assert.deepEqual(runtimeImports(sources().get("decide.ts") ?? ""), []);
});

test("the import parser skips type-only imports and sees mixed ones", () => {
  const src = 'import type { A } from "./a.ts";\nimport { b, type C } from "./b.ts";\nimport "./side.ts";\nexport { d } from "./d.ts";\nexport type { E } from "./e.ts";\nexport const f = 1;\nimport {\n  g,\n} from "node:fs";';
  assert.deepEqual(runtimeImports(src), ["b.ts", "side.ts", "d.ts", "node:fs"]);
});

test("only github.ts reads the App key", () => {
  for (const [file, src] of sources()) {
    if (file === "github.ts" || file === "policy.ts") continue; // policy.ts declares and validates the path
    assert.ok(!/\bkeyFile\b/.test(src), `${file} mentions keyFile`);
  }
});

test("only github.ts mints Auth, so only github.ts can fetch or push", () => {
  for (const [file, src] of sources()) {
    if (file === "github.ts") continue;
    assert.ok(!/\bas\s+(unknown\s+as\s+)?Auth\b/.test(src), `${file} casts to Auth`);
  }
});

test("only decide.ts mints MergeTicket", () => {
  for (const [file, src] of sources()) {
    if (file === "decide.ts") continue;
    assert.ok(!/\bas\s+(unknown\s+as\s+)?MergeTicket\b/.test(src), `${file} casts to MergeTicket`);
  }
});

test("only policy.ts mints CleanText", () => {
  for (const [file, src] of sources()) {
    if (file === "policy.ts") continue;
    assert.ok(!/\bas\s+(unknown\s+as\s+)?CleanText\b/.test(src), `${file} casts to CleanText`);
  }
});

test("only sandbox.ts and workspace.ts spawn processes", () => {
  for (const [file, src] of sources()) {
    const spawns = runtimeImports(src).includes("node:child_process");
    assert.equal(spawns, file === "sandbox.ts" || file === "workspace.ts", `${file} ${spawns ? "imports" : "does not import"} node:child_process`);
  }
});
