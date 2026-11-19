// The apps a script can run by name: `site`, the docs site, or a folder under examples/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The workspace package of `name`. Prints `usage` and the names it accepts when there is no such app. */
export function resolveApp(name, usage) {
  if (name === "site") return { pkg: "@opfs-lsm/site", site: true };
  const manifest = join(root, "examples", name ?? "", "package.json");
  if (!name || !existsSync(manifest)) {
    fail(`usage: ${usage}\n<app> is one of: site, ${readdirSync(join(root, "examples")).join(", ")}`);
  }
  return { pkg: JSON.parse(readFileSync(manifest, "utf8")).name, site: false };
}
