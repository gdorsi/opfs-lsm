/**
 * Proves the checked suites have not gone blind: plants each bug below in a
 * copy of the engine source, builds that copy's checked twin, and runs the
 * kv suite on it (`KV_ENGINE=checked`). Each planted bug must fail the suite
 * within the time limit, through the check that owns it: a shadow report,
 * or for the allocator, which the twin does not check, its model test. A
 * failure that only compares output with the clean shipped build would
 * pass a blind check. The clean source must pass. Prints a table and exits
 * 1 on any other outcome.
 *
 *   pnpm --filter @opfs-lsm/kv mutant-canary [name…]
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChecked } from "../checked/build.ts";

const KV = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT_MS = 10 * 60_000;

type Mutant = { readonly name: string; readonly file: string; readonly from: string; readonly to: string };

const SHADOW = /SanitizerError|^(bad-access|leak|double-free|invalid-free|invalid-realloc):/;
const ALLOC_MODEL = /alloc-model\.test\.ts/;
/** The output that shows the check owning `mutant` caught it. */
const owner = (mutant: Mutant) => (mutant.file === "alloc.ts" ? ALLOC_MODEL : SHADOW);

/** Each `from` occurs once in its file. */
const MUTANTS: readonly Mutant[] = [
  { name: "append copies a byte too many", file: "buf.ts", from: "memory.copy(this.ptr + this.len, src, n);", to: "memory.copy(this.ptr + this.len, src, n + 1);" },
  {
    name: "commonPrefix reads up to 7 bytes past both keys, output unchanged",
    file: "buf.ts",
    from: "    if (x) return i + <usize>(ctz<u64>(x) >> 3);\n    i += 8;\n  }\n",
    to: "    if (x) return min(n, i + <usize>(ctz<u64>(x) >> 3));\n    i += 8;\n  }\n  while (i < n) {\n    const x = load<u64>(a + i) ^ load<u64>(b + i);\n    if (x) return min(n, i + <usize>(ctz<u64>(x) >> 3));\n    i += 8;\n  }\n  i = n;\n",
  },
  { name: "input_ptr gives a byte too few", file: "index.ts", from: "input.tryCapacity(max<usize>(len, 1))", to: "input.tryCapacity(max<usize>(len, 2) - 1)" },
  { name: "merge_close frees the session twice", file: "index.ts", from: "    s.free();\n    session = null;", to: "    s.free();\n    s.free();\n    session = null;" },
  { name: "merge_close leaks the session", file: "index.ts", from: "    s.free();\n    session = null;", to: "    session = null;" },
  { name: "the sort buffer is freed before the sort", file: "sst.ts", from: "    mergeSort(input, v, buf, n);\n    heap.free(buf);", to: "    heap.free(buf);\n    mergeSort(input, v, buf, n);" },
  { name: "the sort buffer is 4 bytes short", file: "sst.ts", from: "const buf = heap.alloc(n << 2);", to: "const buf = heap.alloc((n << 2) - 4);" },
  { name: "the run's keys are read after the run end is freed", file: "sst.ts", from: "  end.appendRest(out);\n  end.free();", to: "  end.free();\n  end.appendRest(out);" },
  { name: "the encode order is freed twice", file: "sst.ts", from: "  order.free();\n  return 0;", to: "  order.free();\n  order.free();\n  return 0;" },
  { name: "the Bloom filter is not zeroed", file: "bloom.ts", from: "  memory.fill(bits, 0, len);\n", to: "" },
  { name: "free merges a block with the wrong neighbour", file: "alloc.ts", from: "if (next && block + size == next) {", to: "if (next && block + size == next + 8) {" },
];

type Outcome = { readonly code: number | null; readonly ms: number; readonly first: string; readonly lines: readonly string[] };

/** The kv suite on the checked build in `dir`, stopping at the first failure. */
function suite(dir: string): Promise<Outcome> {
  const started = Date.now();
  const child = spawn("pnpm", ["exec", "vitest", "run", "--bail=1"], {
    cwd: KV,
    env: { ...process.env, KV_ENGINE: "checked", KV_CHECKED_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), LIMIT_MS);
  return new Promise((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = out.split("\n").map((l) => l.trim());
      const first = lines.find((l) => SHADOW.test(l)) ?? lines.find((l) => /AssertionError|RuntimeError/.test(l)) ?? lines.find((l) => l.startsWith("FAIL")) ?? "";
      resolve({ code, ms: Date.now() - started, first: first.slice(0, 160), lines });
    });
  });
}

async function plant(mutant: Mutant | undefined): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), "kv-mutant-"));
  try {
    cpSync(join(KV, "engine"), join(root, "engine"), { recursive: true });
    if (mutant) {
      const path = join(root, "engine", mutant.file);
      const source = readFileSync(path, "utf8");
      if (source.split(mutant.from).length !== 2) throw new Error(`${mutant.name}: the text to replace does not occur once in ${mutant.file}`);
      writeFileSync(path, source.replace(mutant.from, mutant.to));
    }
    await buildChecked(root, join(root, ".build"));
    return await suite(join(root, ".build"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Some tests read the package's built files.
if (spawnSync("pnpm", ["run", "build"], { cwd: KV, stdio: "inherit" }).status !== 0) process.exit(1);

const only = process.argv.slice(2);
const rows: string[] = [];
let wrong = 0;
for (const mutant of [undefined, ...MUTANTS.filter((m) => !only.length || only.some((o) => m.name.includes(o)))]) {
  const { code, ms, first, lines } = await plant(mutant);
  const failed = code !== 0 && code !== null;
  const owned = mutant !== undefined && lines.some((l) => owner(mutant).test(l));
  const verdict = mutant ? (failed ? (owned ? "caught" : "NOT BY ITS CHECK") : code === null ? "TIMED OUT" : "MISSED") : code === 0 ? "passes" : "FAILS";
  if (verdict !== "caught" && verdict !== "passes") wrong++;
  rows.push(`| ${mutant?.name ?? "clean source"} | ${verdict} | ${(ms / 1000).toFixed(0)} s | ${first.replaceAll("|", "\\|")} |`);
  console.log(rows.at(-1));
  // A planted bug proves nothing when the clean source fails too.
  if (!mutant && verdict === "FAILS") break;
}
console.log(["", "| Planted bug | Checked suite | Time | First report |", "| --- | --- | --- | --- |", ...rows].join("\n"));
process.exit(wrong ? 1 : 0);
