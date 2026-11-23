/**
 * Run one Jazzer.js target (coverage-guided, libFuzzer). Not part of
 * `pnpm test`.
 *
 *   pnpm --filter @opfs-lsm/kv fuzz:jazzer <target> [seconds]
 *   pnpm --filter @opfs-lsm/kv fuzz:jazzer engine-merge 600
 *
 * Decoder targets: sst-read, sst-decode, manifest, wal-row (entries.ts), the
 * TypeScript decoders, which Jazzer instruments. Engine targets:
 * engine-encode, engine-scan, engine-merge (engine-entries.ts), the wasm
 * engine, whose checked twin counts its own coverage.
 * The run starts from `fuzz/corpus/<target>/` (the committed `seed-*` files
 * plus whatever earlier runs added, which git ignores) and adds new inputs
 * there. A finding is written to `fuzz/.build/crash-*`; replay it with
 * `pnpm --filter @opfs-lsm/kv fuzz:jazzer <target> 0 <file>`.
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureChecked } from "../../checked/build.ts";

const ENTRIES: Record<string, { fn: string; engine?: true }> = {
  "sst-read": { fn: "sstRead" },
  "sst-decode": { fn: "sstDecode" },
  manifest: { fn: "manifest" },
  "wal-row": { fn: "walRow" },
  "engine-encode": { fn: "engineEncode", engine: true },
  "engine-scan": { fn: "engineScan", engine: true },
  "engine-merge": { fn: "engineMerge", engine: true },
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

async function decoderBundle(): Promise<string[]> {
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
  return [bundle, "--includes", ".build/"];
}

async function engineModule(): Promise<string[]> {
  // KV_CHECKED_DIR runs a twin built elsewhere, such as a planted bug's.
  if (!process.env.KV_CHECKED_DIR) await ensureChecked();
  // Jazzer loads only .js, .mjs and .cjs targets; tsx loads the TypeScript behind this one.
  const shim = join(out, "engine-entries.mjs");
  writeFileSync(shim, `export * from ${JSON.stringify(pathToFileURL(join(fuzzDir, "jazzer/engine-entries.ts")).href)};\n`);
  return [shim, "--excludes", "*", "--sync"];
}

const [module, ...instrumentation] = entry.engine ? await engineModule() : await decoderBundle();
const corpus = join(fuzzDir, "corpus", target);
const args = [
  module!,
  ...(replay ? [replay] : [corpus]),
  "--fuzz_function",
  entry.fn,
  ...instrumentation,
  "--timeout",
  "10000",
  "--",
  ...(replay ? ["-runs=1"] : [`-max_total_time=${seconds}`]),
  "-rss_limit_mb=2048",
  `-artifact_prefix=${out}/`,
  "-print_final_stats=1",
];
const jazzer = join(fuzzDir, "../node_modules/.bin/jazzer");
// The engine targets load as TypeScript, through tsx.
const env = entry.engine ? { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import tsx` } : process.env;
const res = spawnSync(jazzer, args, { stdio: "inherit", cwd: out, env });
process.exit(res.status ?? 1);
