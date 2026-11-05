/**
 * Time the wasm SST codec on runs of the size compaction writes.
 *
 *   pnpm bench:wasm
 *   ROUNDS=30 RUNS=8 pnpm bench:wasm
 */
import { formatRounds } from "../bench/stats.ts";
import { TARGET_RUN_BYTES } from "../src/store/levels.js";
import {
  decodeSst,
  encodeSst,
  engineUsingWasm,
  ensureEngine,
  mergeSsts,
} from "../src/store/engine.js";
import type { SstEntry } from "../src/store/sst.js";

const rounds = Number(process.env.ROUNDS ?? 15);
const inputs = Number(process.env.RUNS ?? 4);
const valueBytes = Number(process.env.VALUE_BYTES ?? 1024);
const enc = new TextEncoder();

await ensureEngine();
if (!engineUsingWasm()) {
  console.error("wasm did not load; these would be TypeScript fallback times");
  process.exit(1);
}

const perRun = Math.floor(TARGET_RUN_BYTES / (valueBytes + 24));
const value = new Uint8Array(valueBytes).fill(7);
const runOf = (r: number): SstEntry[] =>
  Array.from({ length: perRun }, (_, i) => ({
    kind: "put" as const,
    key: enc.encode(`user:${String(i).padStart(8, "0")}`),
    value,
    seq: r * perRun + i + 1,
  }));
const entries = runOf(0);
const run = await encodeSst(entries);
const newestFirst = await Promise.all(
  Array.from({ length: inputs }, (_, r) => encodeSst(runOf(inputs - r))),
);

const times = { encode: [] as number[], decode: [] as number[], merge: [] as number[] };
for (let i = 0; i < rounds; i++) {
  let t = performance.now();
  await encodeSst(entries);
  times.encode.push(performance.now() - t);
  t = performance.now();
  const rows = await decodeSst(run);
  times.decode.push(performance.now() - t);
  if (rows.length !== perRun) throw new Error(`decoded ${rows.length} of ${perRun}`);
  t = performance.now();
  const merged = await mergeSsts(newestFirst, false, TARGET_RUN_BYTES);
  times.merge.push(performance.now() - t);
  if (merged.ssts.length === 0) throw new Error("merge wrote nothing");
}

const mib = (n: number) => (n / 2 ** 20).toFixed(2);
console.log(`run ${mib(run.byteLength)} MiB, ${perRun} entries of ${valueBytes} B, ${rounds} rounds`);
console.log(formatRounds("encode_sst", times.encode));
console.log(formatRounds("decode_sst", times.decode));
console.log(formatRounds(`merge ${inputs} runs`, times.merge));
