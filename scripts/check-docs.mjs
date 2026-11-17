import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const maxLines = 700;
const design = readFileSync(join(root, "docs/design.md"), "utf8");
const lines = design.replace(/\n$/, "").split("\n");
const errors = [];

if (lines.length > maxLines) {
  errors.push(`docs/design.md has ${lines.length} lines, the limit is ${maxLines}. Cut lines or move a topic to its own file.`);
}

lines.forEach((line, i) => {
  const path = line.match(/[\w./-]+\.(?:ts|tsx|js|mjs|rs)(?!\w|\.\w)/);
  if (path) errors.push(`docs/design.md:${i + 1}: names the source file "${path[0]}". Name only what a user or the disk sees.`);
});

const headings = new Set(
  lines.filter((line) => line.startsWith("#")).map((line) => line.replace(/^#+\s*/, "").trim()),
);
const citation = 'design\\.md, "([^"]+)"';
let citations = "";
try {
  citations = execFileSync("git", ["grep", "-nE", citation, "--", ":!scripts/check-docs.mjs"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  if (error.status !== 1) throw error;
}
for (const hit of citations.trim().split("\n").filter(Boolean)) {
  for (const [, heading] of hit.matchAll(new RegExp(citation, "g"))) {
    if (!headings.has(heading)) errors.push(`${hit.split(":").slice(0, 2).join(":")}: cites missing heading "${heading}".`);
  }
}

// Every figure a page names is registered: VitePress would otherwise fail only when it renders the page.
function registryKeys(file, name) {
  const source = readFileSync(join(root, file), "utf8");
  const body = source.match(new RegExp(`export const ${name}\\b[^=]*= \\{\\n([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
  const keys = new Set([...body.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]));
  if (keys.size === 0) errors.push(`scripts/check-docs.mjs: read no names from ${name} in ${file}. Update registryKeys.`);
  return keys;
}
const scenes = registryKeys("site/stageshow/sizes.ts", "SIZES");
const described = registryKeys("site/.vitepress/theme/figures.ts", "FIGURES");
const figureRefs = [
  // POSIX patterns for git grep: no \s or \b.
  { pattern: "<!--[[:space:]]*figure:[[:space:]]*[a-z]+", names: described, registry: "FIGURES in site/.vitepress/theme/figures.ts" },
  { pattern: '<Illustration[[:space:]]([^>]*[[:space:]])?name="[a-z]+"', names: scenes, registry: "SIZES in site/stageshow/sizes.ts" },
];
for (const { pattern, names, registry } of figureRefs) {
  let hits = "";
  try {
    hits = execFileSync("git", ["grep", "--untracked", "-nE", pattern, "--", "*.md", "*.vue"], { cwd: root, encoding: "utf8" });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  for (const hit of hits.trim().split("\n").filter(Boolean)) {
    const name = hit.match(/figure:\s*([a-z]+)|\bname="([a-z]+)"/);
    const figure = name?.[1] ?? name?.[2];
    if (figure && !names.has(figure)) {
      errors.push(`${hit.split(":").slice(0, 2).join(":")}: names the figure "${figure}", which is not in ${registry}.`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`docs/design.md: ${lines.length}/${maxLines} lines, every citation resolves, every figure is registered`);
