/**
 * The engine's regression gate: this checkout's `wasm/engine.wasm` (head)
 * against the one at the merge-base with origin/main (base), the build the
 * branch started from.
 *
 *   pnpm --filter @opfs-lsm/kv engine:gate [--base <rev>]
 *
 *   output  the same transcript on every drive case (fuzz/engine-drive.ts)
 *   memory  no page more on the memory probes (scripts/wasm-memory.ts)
 *   work    at most 2% more instrumented work on each workload, counted by
 *           the checked twins, which count the same on every run; only when
 *           base has AssemblyScript source
 *   speed   interleaved wall time on each workload; printed, never fails,
 *           since shared runners are too noisy to judge a few percent
 *   size    no byte more, and the shipped module imports nothing
 *
 * A change on purpose takes a trailer on a commit after the merge-base:
 *   Engine-Output: changed
 *   Engine-Regression: <memory|work|size> <workload>, <reason>
 *   Engine-Regression: merge abi, <reason>
 * Changed output then rests on the differential tests against the
 * TypeScript oracles (fuzz/differential.test.ts).
 *
 * Both builds are driven by this checkout's host. After a change to the ABI
 * or to the run format, base cannot merge what that host gives it: the merge
 * rows are then left out of every comparison, which takes its own trailer,
 * `Engine-Regression: merge abi`, and head's merge memory is printed alone
 * for a reviewer to read.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChecked, ensureChecked } from "../checked/build.ts";
import { checkedFile, openChecked, openShipped, SHIPPED } from "../checked/engine-under-test.ts";
import { packPatterns } from "../src/store/block-scan.js";
import { encodeRunIn, flatEngine, openMergeIn, scanBlockContainsIn, type EngineExports } from "../src/store/engine.js";
import { NO_MARKS } from "../src/store/marks.js";
import type { SstEntry } from "../src/store/sst.js";
import { driveEncode, driveMerge, driveScan, encodeCase, mergeCase, scanCase, xorshift, type Transcript } from "../fuzz/engine-drive.ts";
import { blocksOf } from "../fuzz/targets.ts";
import { memoryProbes } from "./wasm-memory.ts";

const KV = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: KV, encoding: "buffer", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
const KiB = 1024;
const MiB = 1024 * KiB;
const WORK_SLACK = 1.02;

function baseRev(): string {
  const at = process.argv.indexOf("--base");
  if (at > 0) return process.argv[at + 1]!;
  try {
    return git("merge-base", "origin/main", "HEAD").toString().trim();
  } catch {
    throw new Error("no merge-base with origin/main: run `git fetch origin main`, or pass --base <rev>");
  }
}

type Waivers = { output: boolean; regressions: Set<string> };

/** The trailers of the commits after `base`. */
function waivers(base: string): Waivers {
  const log = git("log", "--format=%B", `${base}..HEAD`).toString();
  return {
    output: /^Engine-Output:\s*changed\s*$/m.test(log),
    regressions: new Set([...log.matchAll(/^Engine-Regression:\s*(\S+)\s+([^,\s]+)\s*,/gm)].map((m) => `${m[1]} ${m[2]}`)),
  };
}

/** The workloads work and wall time are judged on: a host's calls, through the bridge. */
function workloads(): Record<string, (ex: EngineExports) => void> {
  const r = xorshift(7);
  const value = () => r.bytes(100);
  const puts: SstEntry[] = Array.from({ length: 5000 }, (_, i) => ({
    kind: "put",
    key: new TextEncoder().encode(`user/${r.int(100_000)}/item/${r.int(1000)}`),
    value: value(),
    seq: i + 1,
  }));
  const shipped = flatEngine({ exports: openShipped() });
  const run = (from: number) => encodeRunIn(shipped, puts.slice(from, from + 2000).map((e, i) => ({ ...e, seq: from + i + 1 })));
  const sources = [run(0), run(1000), run(2000), run(3000)];
  const blocks = blocksOf(sources[0]!.body);
  const patterns = packPatterns([new Uint8Array([r.int(256)])]);
  return {
    encode: (ex) => void encodeRunIn(flatEngine({ exports: ex }), puts),
    scan: (ex) => {
      const engine = flatEngine({ exports: ex });
      for (const block of blocks) scanBlockContainsIn(engine, block, patterns);
    },
    merge: (ex) => {
      const core = openMergeIn(flatEngine({ exports: ex }), {
        sources: sources.map((s) => [{ size: s.body.byteLength, index: s.end.index }]),
        dropTombstones: false,
        marks: NO_MARKS,
        targetBytes: 4 * MiB,
        chunkBytes: 64 * KiB,
        tailBytes: 64 * KiB,
        yieldBytes: MiB,
      });
      for (let stop = core.pump(); stop.kind !== "done"; stop = core.pump()) {
        if (stop.kind === "need") for (const d of stop.demands) core.feed(d.source, sources[d.source]!.body.subarray(d.offset, d.offset + d.length));
      }
      core.close();
    },
  };
}

type Line = { readonly axis: string; readonly text: string; readonly fails: readonly string[] };

/** Why base cannot run this checkout's merge workload, or undefined when it can. */
function mergeBreak(base: Uint8Array, run: ReturnType<typeof workloads>): string | undefined {
  try {
    run.merge!(openShipped(base));
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function output(base: EngineExports, head: EngineExports, merges: boolean): Line {
  const r = xorshift(1);
  const fails: string[] = [];
  const family = <C>(name: string, cases: number, next: () => C, drive: (ex: EngineExports, c: C) => Transcript) => {
    let same = 0;
    for (let i = 0; i < cases; i++) {
      const c = next();
      const want = drive(base, c);
      const got = drive(head, c);
      if (want.join("\n") === got.join("\n")) same++;
      else if (fails.length < 3) fails.push(`output ${name} case ${i}: ${got.find((line, at) => line !== want[at])?.slice(0, 120)}`);
    }
    return `${name} ${same}/${cases} identical`;
  };
  // Base writes the runs the scan and merge cases start from, so both builds read the same bytes.
  const text = [
    family("encode", 300, () => encodeCase(r), driveEncode),
    family("scan", 300, () => scanCase(r, base), driveScan),
    ...(merges ? [family("merge", 100, () => mergeCase(r, base), driveMerge)] : []),
  ].join(" · ");
  return { axis: "output", text, fails };
}

async function memory(base: BufferSource, head: BufferSource, w: Waivers, merges: boolean): Promise<Line> {
  const shape = { sources: 49, flushMiB: 1.75, chunk: 128 * KiB, tail: 128 * KiB };
  const measure = async (wasm: BufferSource) => {
    const probes = memoryProbes(wasm);
    return {
      flush: await probes.flush(1.75),
      merge: merges ? (await probes.merge(shape)).peak : 0,
      overlap: merges ? (await probes.merge(shape, 7)).peak : 0,
    };
  };
  const [b, h] = [await measure(base), await measure(head)];
  const mib = (n: number) => (n / MiB).toFixed(2);
  const names = merges ? (["flush", "merge", "overlap"] as const) : (["flush"] as const);
  let alone = "";
  if (!merges) {
    const probes = memoryProbes(head);
    alone = ` · head alone: merge ${mib((await probes.merge(shape)).peak)} MiB, overlap ${mib((await probes.merge(shape, 7)).peak)} MiB`;
  }
  return {
    axis: "memory",
    text: names.map((k) => `${k} ${mib(b[k])} → ${mib(h[k])} MiB`).join(" · ") + alone,
    fails: names.filter((k) => h[k] > b[k] && !w.regressions.has(`memory ${k}`)).map((k) => `memory ${k}: ${mib(b[k])} → ${mib(h[k])} MiB`),
  };
}

/** The base twin, built from base's source with this checkout's transform, or undefined when base has none. */
async function baseTwin(rev: string): Promise<Uint8Array | undefined> {
  try {
    git("cat-file", "-e", `${rev}:packages/kv/engine/index.ts`);
  } catch {
    return undefined;
  }
  const root = mkdtempSync(join(tmpdir(), "kv-gate-"));
  try {
    // From the repository's top: in a subdirectory git archive reads paths relative to it.
    const top = git("rev-parse", "--show-toplevel").toString().trim();
    execFileSync("sh", ["-c", `git archive ${rev}:packages/kv engine | tar -x -C ${JSON.stringify(root)}`], { cwd: top });
    await buildChecked(root, join(root, "build"));
    return readFileSync(join(root, "build/engine.wasm"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function work(base: Uint8Array | undefined, run: ReturnType<typeof workloads>, w: Waivers): Line {
  const count = (wasm: Uint8Array | undefined) => {
    const out: Record<string, number> = {};
    for (const [name, workload] of Object.entries(run)) {
      const twin = openChecked(wasm ? { wasm } : {});
      const before = twin.work();
      workload(twin.exports);
      out[name] = twin.work() - before;
    }
    return out;
  };
  const h = count(undefined);
  if (!base) return { axis: "work", text: `${Object.entries(h).map(([k, v]) => `${k} ${v.toLocaleString("en")}`).join(" · ")} (base has no AssemblyScript source to count)`, fails: [] };
  const b = count(base);
  const pct = (k: string) => `${(((h[k]! - b[k]!) / b[k]!) * 100).toFixed(1)}%`;
  return {
    axis: "work",
    text: Object.keys(h).map((k) => `${k} ${b[k]!.toLocaleString("en")} → ${h[k]!.toLocaleString("en")} (${pct(k)})`).join(" · "),
    fails: Object.keys(h).filter((k) => h[k]! > b[k]! * WORK_SLACK && !w.regressions.has(`work ${k}`)).map((k) => `work ${k}: ${pct(k)}`),
  };
}

/** ABAB-interleaved rounds, each the median of a few calls per build. */
function speed(base: EngineExports, head: EngineExports, run: ReturnType<typeof workloads>): Line {
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
  const ms = (x: number) => x.toFixed(3);
  const parts: string[] = [];
  for (const [name, workload] of Object.entries(run)) {
    const once = (ex: EngineExports) => {
      const t = performance.now();
      workload(ex);
      return performance.now() - t;
    };
    for (let i = 0; i < 10; i++) {
      once(base);
      once(head);
    }
    const sides: [number[], number[]] = [[], []];
    for (let round = 0; round < 15; round++) {
      const order = round & 1 ? ([1, 0] as const) : ([0, 1] as const);
      for (const side of order) sides[side].push(median(Array.from({ length: 7 }, () => once(side ? head : base))));
    }
    const [b, h] = sides.map(median) as [number, number];
    const range = (xs: number[]) => `[${ms(Math.min(...xs))}–${ms(Math.max(...xs))}]`;
    parts.push(`${name} ${ms(b)} ${range(sides[0])} → ${ms(h)} ${range(sides[1])} ms (${(h / b).toFixed(2)}×)`);
  }
  return { axis: "speed", text: parts.join(" · "), fails: [] };
}

function size(base: Uint8Array, head: Uint8Array, w: Waivers): Line {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(head)).length;
  const fails = [
    ...(head.byteLength > base.byteLength && !w.regressions.has("size engine.wasm") ? [`size: ${head.byteLength - base.byteLength} bytes more`] : []),
    ...(imports ? [`size: the shipped module imports ${imports} names`] : []),
  ];
  return { axis: "size", text: `${base.byteLength.toLocaleString("en")} → ${head.byteLength.toLocaleString("en")} bytes, ${imports} imports`, fails };
}

const rev = baseRev();
const w = waivers(rev);
const base = new Uint8Array(git("show", `${rev}:packages/kv/wasm/engine.wasm`));
const head = new Uint8Array(readFileSync(SHIPPED));
if (!process.env.KV_CHECKED_DIR) await ensureChecked();
console.log(`engine gate: head ${git("rev-parse", "--short", "HEAD").toString().trim()} against base ${rev.slice(0, 8)} (${checkedFile("engine.wasm")})`);
const all = workloads();
const broken = mergeBreak(base, all);
/** The workloads base and head are compared on. */
const run = Object.fromEntries(Object.entries(all).filter(([name]) => name !== "merge" || broken === undefined));
const lines: Line[] = [];
const report = (line: Line) => {
  lines.push(line);
  const waived = line.axis === "output" && w.output && line.fails.length ? " (waived: Engine-Output: changed)" : "";
  console.log(`  ${line.axis.padEnd(6)}  ${line.text}${waived}`);
};
if (broken !== undefined) {
  const fails = w.regressions.has("merge abi") ? [] : [`merge: base cannot run this checkout's merge (${broken})`];
  report({ axis: "merge", text: `not compared: base cannot run this checkout's merge (${broken})`, fails });
}
report(output(openShipped(base), openShipped(head), broken === undefined));
report(await memory(base, head, w, broken === undefined));
report(work(await baseTwin(rev), run, w));
report(speed(openShipped(base), openShipped(head), run));
report(size(base, head, w));
const fails = lines.flatMap((l) => (l.axis === "output" && w.output ? [] : l.fails));
if (fails.length) {
  console.log(`\nFAIL\n  ${fails.join("\n  ")}`);
  console.log("A change on purpose takes a trailer on one of the branch's commits, e.g. `Engine-Regression: work merge, trades 3% for bounded memory`.");
  process.exit(1);
}
console.log("\nok");
