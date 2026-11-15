// Local release. Replaces the release workflow that used to live in
// .github/workflows/release.yml: versions the packages from the pending
// changesets, tests, publishes to npm, pushes, and opens GitHub releases.
// Run with `pnpm release`. See CONTRIBUTING.md.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const noGithub = process.argv.includes("--no-github");

type Package = {
  dir: string;
  name: string;
  version: string;
  published: string | null;
};

function run(cmd: string, args: string[]): void {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  if (dryRun) return;
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
}

function capture(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
  return result.stdout;
}

function tryCapture(cmd: string, args: string[]): string | null {
  const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

// 1. Preflight: main, clean tree, up to date with origin.
const branch = capture("git", ["branch", "--show-current"]).trim();
if (branch !== "main") fail(`must run on main, you are on ${branch}`);

const dirty = capture("git", ["status", "--porcelain"]);
if (dirty.trim() !== "") fail(`working tree is not clean:\n${dirty}`);

run("git", ["fetch", "origin", "main"]);
const local = capture("git", ["rev-parse", "main"]).trim();
const remote = capture("git", ["rev-parse", "origin/main"]).trim();
if (local !== remote) {
  const message = "main is not up to date with origin/main";
  if (dryRun) console.log(`note: ${message}, dry-run continues`);
  else fail(`${message}, run git pull --ff-only or git push first`);
}

// 2. Version from the pending changesets.
const pending = readdirSync(join(root, ".changeset"))
  .filter((name: string) => name.endsWith(".md") && name !== "README.md");
if (pending.length > 0) {
  console.log(`versioning ${pending.length} changeset(s):`);
  for (const name of pending) console.log(`  .changeset/${name}`);
  run("pnpm", ["changeset", "version"]);
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", "chore(release): version packages"]);
} else {
  console.log("no pending changesets");
}

// 3. Test and static checks on the versioned tree.
run("pnpm", ["test"]);
run("pnpm", ["static"]);

// 4. Find the packages whose version npm does not have yet.
const packages: Package[] = readdirSync(join(root, "packages"))
  .map((dir: string) => {
    const manifest = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
    return { dir, name: manifest.name, version: manifest.version };
  })
  .filter((pkg: Package) => !pkg.private)
  .map((pkg: Package) => ({
    ...pkg,
    published: tryCapture("npm", ["view", pkg.name, "version"])?.trim() ?? null,
  }));
const toPublish = packages.filter((pkg: Package) => pkg.published !== pkg.version);

for (const pkg of packages) {
  const state = pkg.published === pkg.version ? "already published" : pkg.published === null ? "not on npm" : `npm has ${pkg.published}`;
  console.log(`${pkg.name}@${pkg.version}: ${state}`);
}
if (toPublish.length === 0) {
  console.log("nothing to publish");
}

// 5. Publish; changesets publishes each package that is not on npm and tags it.
if (toPublish.length > 0) {
  run("pnpm", ["changeset", "publish"]);
}

run("git", ["push", "origin", "main", "--follow-tags"]);

// 6. One GitHub release per published package, with its changelog entry.
if (toPublish.length > 0 && !noGithub) {
  if (tryCapture("gh", ["--version"]) === null) {
    fail("gh is not installed, install it or rerun with --no-github");
  }
  for (const pkg of toPublish) {
    const tag = `${pkg.name}@${pkg.version}`;
    const notes = changelogSection(pkg.dir, pkg.version);
    if (dryRun) {
      console.log(`$ gh release create ${tag} --title ${tag} --notes-file <changelog for ${pkg.name}>`);
      continue;
    }
    const exists = tryCapture("gh", ["release", "view", tag]) !== null;
    if (exists) {
      console.log(`${tag}: GitHub release already exists`);
      continue;
    }
    const file = join(tmpdir(), `release-notes-${pkg.name.replace("/", "-")}-${pkg.version}.md`);
    writeFileSync(file, notes);
    run("gh", ["release", "create", tag, "--title", tag, "--notes-file", file]);
  }
}

function changelogSection(dir: string, version: string): string {
  const file = join(root, "packages", dir, "CHANGELOG.md");
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(`## ${version}\n`);
  if (start === -1) return "";
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? text.length : next).trim() + "\n";
}
