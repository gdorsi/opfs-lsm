import "fake-indexeddb/auto";
import { MemoryFs, __resetMemoryFsForTests, openDb } from "../src/index.js";
import { loadLatestGeneration } from "../src/store/generation.js";

const totalMiB = Number(process.env.TOTAL_MIB ?? 120);
const keys = Number(process.env.KEYS ?? 200_000);
const valueBytes = Number(process.env.VALUE_BYTES ?? 512);
const batchSize = 512;
const name = "compaction-cost";
const enc = new TextEncoder();
const MiB = 1024 * 1024;

let seed = 7;
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const keyOf = (k: number) => enc.encode(`k${String(k).padStart(8, "0")}`);

__resetMemoryFsForTests(name);
const fs = new MemoryFs();
let flushBytes = 0;
let compactionBytes = 0;
let stepInput = 0;
let maxStepInput = 0;
const read = fs.read.bind(fs);
fs.read = async (path, offset, length) => {
  const buf = await read(path, offset, length);
  if (length === 1 << 30 && buf) stepInput += buf.byteLength;
  return buf;
};
const create = fs.create.bind(fs);
fs.create = async (path) => {
  const w = await create(path);
  if (path.startsWith("m/")) {
    maxStepInput = Math.max(maxStepInput, stepInput);
    stepInput = 0;
  }
  return {
    write: async (bytes) => {
      if (path.startsWith("l0/")) flushBytes += bytes.byteLength;
      else if (!path.startsWith("m/")) compactionBytes += bytes.byteLength;
      return w.write(bytes);
    },
    finish: () => w.finish(),
    abort: () => w.abort(),
  };
};

const db = await openDb({ name, fs, forceMemory: true });
const model = new Map<number, number>();
let userBytes = 0;
const started = performance.now();
for (let n = 0; userBytes < totalMiB * MiB; n++) {
  await db.batch((tx) => {
    for (let i = 0; i < batchSize; i++) {
      const k = rand(keys);
      const value = new Uint8Array(valueBytes);
      new DataView(value.buffer).setUint32(0, n * batchSize + i);
      tx.put(keyOf(k), value);
      model.set(k, n * batchSize + i);
      userBytes += 9 + valueBytes;
    }
  });
}
await db.ingest();
const seconds = (performance.now() - started) / 1000;

let mismatches = 0;
for (let i = 0; i < 2000; i++) {
  const k = rand(keys);
  const got = await db.get(keyOf(k));
  const want = model.get(k);
  const seen = got ? new DataView(got.buffer, got.byteOffset).getUint32(0) : undefined;
  if (seen !== want) mismatches += 1;
}
const meta = await loadLatestGeneration(fs);
const levels: Record<string, number> = {};
for (const run of meta?.runs ?? []) {
  const path = typeof run === "string" ? run : run.path;
  const level = path.split("/")[0]!;
  levels[level] = (levels[level] ?? 0) + 1;
}
await db.close();
console.log(
  JSON.stringify({
    userMiB: +(userBytes / MiB).toFixed(1),
    flushMiB: +(flushBytes / MiB).toFixed(1),
    compactionWriteMiB: +(compactionBytes / MiB).toFixed(1),
    writeAmp: +((flushBytes + compactionBytes) / userBytes).toFixed(2),
    maxStepInputMiB: +(maxStepInput / MiB).toFixed(1),
    runsPerLevel: levels,
    mismatches,
    seconds: +seconds.toFixed(1),
  }),
);
