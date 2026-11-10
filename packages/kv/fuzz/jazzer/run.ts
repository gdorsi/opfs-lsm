/**
 * Run one Jazzer.js target (coverage-guided, libFuzzer) over a TypeScript
 * decoder. Not part of `pnpm test`.
 *
 *   pnpm --filter @opfs-lsm/kv fuzz:jazzer <target> [seconds]
 *   pnpm --filter @opfs-lsm/kv fuzz:jazzer sst-read 600
 *
 * Targets: sst-read, sst-decode, manifest, record, lz4 (see entries.ts).
 * The run starts from `fuzz/corpus/<target>/` (the committed `seed-*` files
 * plus whatever earlier runs added, which git ignores) and adds new inputs
 * there. A finding is written to `fuzz/.build/crash-*`; replay it with
 * `pnpm --filter @opfs-lsm/kv fuzz:jazzer <target> 0 <file>`.
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRIES: Record<string, string> = {
  "sst-read": "sstRead",
  "sst-decode": "sstDecode",
  manifest: "manifest",
  record: "recordBody",
  lz4: "lz4",
};

const [target = "", seconds = "600", replay] = process.argv.slice(2);
const entry = ENTRIES[target];
if (!entry) {
  console.error(`usage: fuzz:jazzer <${Object.keys(ENTRIES).join("|")}> [seconds] [input to replay]`);
  process.exit(2);
}

const fuzzDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(fuzzDir, ".build");
mkdirSync(out, { recursive: true });
const bundle = join(out, "entries.cjs");
// One CommonJS file, so Jazzer instruments every decoder line it loads.
await build({
  entryPoints: [join(fuzzDir, "jazzer/entries.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundle,
  logLevel: "error",
});

const corpus = join(fuzzDir, "corpus", target);
const args = [
  bundle,
  ...(replay ? [replay] : [corpus]),
  "--fuzz_function",
  entry,
  "--includes",
  ".build/",
  "--timeout",
  "10000",
  "--",
  ...(replay ? ["-runs=1"] : [`-max_total_time=${seconds}`]),
  "-rss_limit_mb=2048",
  `-artifact_prefix=${out}/`,
  "-print_final_stats=1",
];
const jazzer = join(fuzzDir, "../node_modules/.bin/jazzer");
const res = spawnSync(jazzer, args, { stdio: "inherit", cwd: out });
process.exit(res.status ?? 1);
