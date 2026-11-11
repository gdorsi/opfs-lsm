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
  const path = line.match(/[\w./-]+\.(?:ts|tsx|js|mjs|rs)\b/);
  if (path) errors.push(`docs/design.md:${i + 1}: names the source file "${path[0]}". Name only what a user or the disk sees.`);
});

const headings = new Set(
  lines.filter((line) => line.startsWith("#")).map((line) => line.replace(/^#+\s*/, "").trim()),
);
const citations = execFileSync("git", ["grep", "-nE", 'design\\.md, "[^"]+"', "--", ":!scripts/check-docs.mjs"], { cwd: root, encoding: "utf8" });
for (const hit of citations.trim().split("\n")) {
  for (const [, heading] of hit.matchAll(/design\.md, "([^"]+)"/g)) {
    if (!headings.has(heading)) errors.push(`${hit.split(":").slice(0, 2).join(":")}: cites design.md, "${heading}", which is not a heading.`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`docs/design.md: ${lines.length}/${maxLines} lines, every citation resolves`);
