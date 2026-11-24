import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PublicPackage = { dir: string; name: string; version: string };
type Release = { tag: `v${string}`; notes: string };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function publicPackages(): PublicPackage[] {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name: dir }) => ({ dir, manifest: JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")) }))
    .filter(({ manifest }) => !manifest.private)
    .map(({ dir, manifest }) => ({ dir, name: manifest.name, version: manifest.version }));
}

function release(packages: PublicPackage[]): Release {
  const versions = new Set(packages.map((pkg) => pkg.version));
  if (versions.size !== 1) {
    const found = packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ");
    throw new Error(`the public packages must share one version, found ${found}`);
  }
  const notes = packages
    .map((pkg) => `## ${pkg.name}@${pkg.version}\n\n${changelogSection(pkg.dir, pkg.version)}`)
    .join("\n\n") + "\n";
  return { tag: `v${packages[0].version}`, notes };
}

function changelogSection(dir: string, version: string): string {
  const file = join(root, "packages", dir, "CHANGELOG.md");
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(`## ${version}\n`);
  if (start === -1) return "";
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? text.length : next).trim();
}

const { tag, notes } = release(publicPackages());

if (process.argv.includes("--dry-run")) {
  console.log(`${tag}\n\n${notes}`);
} else if (spawnSync("gh", ["release", "view", tag], { cwd: root, stdio: "ignore" }).status === 0) {
  console.log(`release ${tag} exists`);
} else {
  const file = join(mkdtempSync(join(tmpdir(), "github-release-")), "notes.md");
  writeFileSync(file, notes);
  const sha = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("gh", ["release", "create", tag, "--title", tag, "--notes-file", file, "--target", sha], { cwd: root, stdio: "inherit" });
}
