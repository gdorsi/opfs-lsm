import "fake-indexeddb/auto";
import { MemoryFs, __resetMemoryFsForTests, decodeSst, openDb } from "../src/index.js";
import { loadLatestGeneration } from "../src/store/generation.js";
import { SstReader } from "../src/store/sst.js";

const flushEvery = Number(process.env.FLUSH_EVERY ?? 32);
const batches = Number(process.env.BATCHES ?? 20_000);
const keys = Number(process.env.KEYS ?? 2_000);
const name = `aged-${flushEvery}`;
const enc = new TextEncoder();

let seed = 1;
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};

__resetMemoryFsForTests(name);
const fs = new MemoryFs();
const db = await openDb({
  name,
  fs,
  forceMemory: true,
  ingestPolicy: { maxBatches: 1e9, maxBytes: 2 ** 40 },
});
const live = new Map<number, number>();
const value = new Uint8Array(100);
for (let i = 1; i <= batches; i++) {
  const k = rand(keys);
  if (rand(10) === 0) {
    await db.delete(enc.encode(`k${k}`));
    live.delete(k);
  } else {
    await db.put(enc.encode(`k${k}`), value);
    live.set(k, i);
  }
  if (i % flushEvery === 0) await db.ingest();
}
await db.ingest();

const meta = await loadLatestGeneration(fs);
let sstBytes = 0;
let tombstones = 0;
const readers: SstReader[] = [];
for (const path of meta?.runs ?? []) {
  const buf = (await fs.read(path, 0, 1 << 30))!;
  sstBytes += buf.byteLength;
  tombstones += (await decodeSst(buf)).filter((e) => e.kind === "del").length;
  readers.push(new SstReader(buf));
}
let probes = 0;
for (let k = 0; k < keys; k++) {
  const key = enc.encode(`k${k}`);
  for (const r of readers) {
    if (!r.mightContain(key)) continue;
    probes++;
    if (r.get(key)) break;
  }
}
const liveBytes = live.size * (100 + 5);
console.log(
  JSON.stringify({
    flushEvery,
    batches,
    runs: meta?.runs.length ?? 0,
    sstKiB: Math.round(sstBytes / 1024),
    liveKiB: Math.round(liveBytes / 1024),
    spaceAmp: Number((sstBytes / liveBytes).toFixed(2)),
    tombstones,
    liveKeys: live.size,
    blockProbesPerKey: Number((probes / keys).toFixed(2)),
  }),
);
await db.close();
