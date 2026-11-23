import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const bench = join(root, "bench");
const { build } = createRequire(join(root, "packages/kv/package.json"))("esbuild");
const { version } = JSON.parse(readFileSync(join(bench, "node_modules/@tanstack/db/package.json"), "utf8"));

const ENTRIES = {
  "collection and live query": `
    import { createCollection, createLiveQueryCollection, eq } from "@tanstack/db";
    console.log(createCollection, createLiveQueryCollection, eq);`,
  "query builder only": `
    import { Query, and, eq, gt, inArray, compileSingleRowExpression } from "@tanstack/db";
    const q = new Query().from({ i: globalThis.c })
      .where(({ i }) => and(eq(i.status, 1), inArray(i.p, [1, 2]), gt(i.m, 3)))
      .orderBy(({ i }) => i.m, "desc").limit(50);
    console.log(q, compileSingleRowExpression);`,
};

/** The part of TanStack DB a bundled file belongs to: `db-ivm`, or the first two path segments under the `@tanstack/db` build. */
function partOf(path) {
  const inScope = path.replace(/^.*node_modules\/@tanstack\//, "");
  if (inScope.startsWith("db-ivm/")) return "db-ivm";
  if (!inScope.startsWith("db/dist/esm/")) return inScope.split("/")[0];
  const [first, second] = inScope.slice("db/dist/esm/".length).replace(/\.js$/, "").split("/");
  return second && (first === "query" || first === "collection") ? `${first}/${second}` : first;
}

const kB = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;

async function bundle(options) {
  const { outputFiles, metafile } = await build({ bundle: true, minify: true, format: "esm", platform: "browser", write: false, metafile: true, ...options });
  const code = outputFiles[0].contents;
  return { bytes: code.length, gzip: gzipSync(code, { level: 9 }).length, inputs: Object.values(metafile.outputs)[0].inputs };
}

console.log(`@tanstack/db ${version}, esbuild, minified`);
for (const [name, contents] of Object.entries(ENTRIES)) {
  const { bytes, gzip, inputs } = await bundle({ stdin: { contents, resolveDir: bench } });
  console.log(`\n${name}: ${kB(bytes)}, ${kB(gzip)} gzip`);
  const parts = new Map();
  for (const [path, { bytesInOutput }] of Object.entries(inputs)) parts.set(partOf(path), (parts.get(partOf(path)) ?? 0) + bytesInOutput);
  for (const [part, size] of [...parts].sort((a, b) => b[1] - a[1]).filter(([, size]) => size >= 1000)) console.log(`  ${kB(size).padStart(8)}  ${part}`);
}

const planner = await bundle({ entryPoints: [join(root, "packages/tanstack-db/src/plan.ts")], external: ["@tanstack/db", "@opfs-lsm/docstore"] });
console.log(`\npackages/tanstack-db/src/plan.ts: ${kB(planner.bytes)}, ${kB(planner.gzip)} gzip`);
