/**
 * Builds what the checked suites run, into a directory that is not
 * committed:
 *
 * - `engine.wasm`, the checked twin: the engine source compiled with the
 *   shipped build's flags (engine/build.sh) minus `--noAssert`, plus the
 *   instrument transform and the function names.
 * - `alloc.wasm`, the allocator alone, for its model test.
 *
 *   pnpm --filter @opfs-lsm/kv build:wasm-checked
 *
 * `ensureChecked` rebuilds only when the engine source or this directory
 * changed, so the suites call it before they start.
 */
import asc from "assemblyscript/asc";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKED_DIR } from "./engine-under-test.ts";
import { Instrument } from "./instrument.ts";

const KV = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLAGS = ["--runtime", "engine/runtime", "--use", "abort=", "--optimizeLevel", "3", "--shrinkLevel", "2"];
/** The allocator's three calls, and where its heap starts, as exports. */
const ALLOC_HARNESS = `import { free, tryAlloc, tryRealloc } from "./engine/alloc";
export function alloc(size: usize): usize { return tryAlloc(size); }
export function realloc(ptr: usize, size: usize): usize { return tryRealloc(ptr, size); }
export function release(ptr: usize): void { free(ptr); }
export function heapStart(): usize { return ((__heap_base + 4 + 7) & ~7) - 4; }
`;

async function compile(root: string, entry: string, flags: string[], transforms: (typeof Instrument)[] = []): Promise<Uint8Array> {
  let binary: Uint8Array | undefined;
  const { error, stderr } = await asc.main([entry, "--baseDir", root, ...FLAGS, ...flags, "--outFile", "out.wasm"], {
    transforms,
    readFile: (name, baseDir) => (name === "alloc-harness.ts" ? ALLOC_HARNESS : readText(join(baseDir, name))),
    writeFile: (name, contents) => {
      if (name === "out.wasm") binary = contents as Uint8Array;
    },
  });
  if (error || !binary) throw new Error(`${entry} did not build: ${error?.message ?? "no output"}\n${stderr.toString()}`);
  return binary;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Compile `<root>/engine` into `outDir`. Paths stay relative to `root`: asc
 * names a module by the path it was reached by, and the transform finds the
 * allocator by that name.
 */
export async function buildChecked(root = KV, outDir = CHECKED_DIR): Promise<void> {
  const twin = await compile(root, "engine/index.ts", ["--debug"], [Instrument]);
  // The engine's static data always takes a page, and the allocator counts on one. The cap lets the model fill memory.
  const alloc = await compile(root, "alloc-harness.ts", ["--noAssert", "--initialMemory", "1", "--maximumMemory", "64"]);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "engine.wasm"), twin);
  writeFileSync(join(outDir, "alloc.wasm"), alloc);
}

function sourceHash(): string {
  const hash = createHash("sha256");
  for (const dir of ["engine", "checked"]) {
    for (const name of readdirSync(join(KV, dir)).sort()) {
      if (name.endsWith(".ts")) hash.update(name).update(readFileSync(join(KV, dir, name)));
    }
  }
  return hash.digest("hex");
}

/** Build unless the last build was from the current source. */
export async function ensureChecked(): Promise<void> {
  const stamp = join(CHECKED_DIR, "source");
  const want = sourceHash();
  if (readText(stamp) === want) return;
  await buildChecked();
  writeFileSync(stamp, want);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await ensureChecked();
