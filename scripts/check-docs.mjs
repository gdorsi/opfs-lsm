import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
const { SIZES } = await import("../site/stageshow/sizes.ts");
const { FIGURES } = await import("../site/.vitepress/theme/figures.ts");
const figureRefs = [
  // The same pattern as figureHtml in site/.vitepress/markdown.ts.
  { pattern: /^<!--\s*figure:\s*(\S+)\s*-->\s*$/gm, names: FIGURES, registry: "FIGURES in site/.vitepress/theme/figures.ts" },
  { pattern: /<Illustration\s(?:[^>]*\s)?name="([^"]*)"/g, names: SIZES, registry: "SIZES in site/stageshow/sizes.ts" },
];
const pages = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "docs/*.md", "site/*.md", "site/*.vue"], {
  cwd: root,
  encoding: "utf8",
});
for (const page of new Set(pages.trim().split("\n").filter((page) => page && existsSync(join(root, page))))) {
  const text = readFileSync(join(root, page), "utf8");
  for (const { pattern, names, registry } of figureRefs) {
    for (const match of text.matchAll(pattern)) {
      if (Object.hasOwn(names, match[1])) continue;
      const line = text.slice(0, match.index).split("\n").length;
      errors.push(`${page}:${line}: names the figure "${match[1]}", which is not in ${registry}.`);
    }
  }
}

const research = "docs/research";
const maxResearchBytes = 20 * 1024;
const statusLine = /^Status: (shipped|rejected|open|reference)\b/m;
const researchFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", research], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter((file) => file && existsSync(join(root, file)));
const index = researchFiles.includes(`${research}/README.md`) ? readFileSync(join(root, research, "README.md"), "utf8") : "";
if (!index) errors.push(`${research}/README.md is missing. It lists every note with its verdict.`);
for (const file of researchFiles) {
  const text = readFileSync(join(root, file));
  if (text.length > maxResearchBytes) {
    errors.push(`${file} is ${text.length} bytes, the limit is ${maxResearchBytes}. Cut what another doc owns, and keep raw runs out of ${research}.`);
  }
  if (!file.endsWith(".md")) continue;
  for (const [, target] of text.toString().matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (!existsSync(join(root, dirname(file), target))) errors.push(`${file}: links to "${target}", which does not exist.`);
  }
  const name = file.slice(research.length + 1);
  if (name.includes("/") || name === "README.md") continue;
  if (!statusLine.test(text.toString().split("\n").slice(0, 12).join("\n"))) {
    errors.push(`${file}: no "Status: shipped|rejected|open|reference" line in its first 12 lines.`);
  }
  if (!index.includes(`](${name})`)) errors.push(`${file}: ${research}/README.md has no row that links to it.`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`docs/design.md: ${lines.length}/${maxLines} lines, every citation resolves, every figure is registered`);
console.log(`${research}: ${researchFiles.length} files, each at most ${maxResearchBytes} bytes, every note has a status and a README row`);
