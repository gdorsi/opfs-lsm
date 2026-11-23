import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGES = ["@tanstack/query-db-collection@1.5.2", "@tanstack/electric-db-collection@1.0.0-rc.1.5", "@tanstack/solid-db@1.0.0-rc.1.5"];
const WATCHED = ["@tanstack/db", "solid-js"];

const work = mkdtempSync(join(tmpdir(), "tanstack-adapters-"));
try {
  for (const spec of PACKAGES) {
    const tarball = execFileSync("npm", ["pack", spec, "--silent"], { cwd: work, encoding: "utf8" }).trim().split("\n").at(-1);
    const dir = join(work, tarball.replace(/\.tgz$/, ""));
    mkdirSync(dir);
    execFileSync("tar", ["-xzf", join(work, tarball), "-C", dir]);
    const manifest = JSON.parse(readFileSync(join(dir, "package/package.json"), "utf8"));
    console.log(`\n${manifest.name} ${manifest.version}`);
    for (const field of ["dependencies", "peerDependencies"]) {
      for (const name of WATCHED) if (manifest[field]?.[name]) console.log(`  ${field}: ${name} ${manifest[field][name]}`);
    }

    const sources = readdirSync(join(dir, "package/src"))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(join(dir, "package/src", file), "utf8"))
      .join("\n");
    const runtimeImports = [...sources.matchAll(/^import \{([^}]*)\} from '@tanstack\/db'/gm)].flatMap(([, names]) => names.split(",").map((n) => n.trim()).filter(Boolean));
    console.log(`  values imported from @tanstack/db: ${[...new Set(runtimeImports)].sort().join(", ") || "none"}`);

    // `metadata.collection` is the sync metadata store, not the collection.
    const uses = new Map();
    for (const [member] of sources.matchAll(/(?<!metadata\??\.)\bcollection\.[_a-zA-Z]+(?:\.[_a-zA-Z]+)*/g)) uses.set(member, (uses.get(member) ?? 0) + 1);
    for (const [member, count] of [...uses].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(3)}  ${member}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
