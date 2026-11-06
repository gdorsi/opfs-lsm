import "fake-indexeddb/auto";
import {
  MemoryFs,
  decodeSst
} from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests
} from "../src/testing.js";
import { loadLatestGeneration } from "../src/store/generation.js";
import { bloomMightContain } from "../src/store/bloom.js";
import { settle } from "../src/store/cursor.js";
import { PageCache } from "../src/store/page-cache.js";
import { sstKeyRange } from "../src/store/sst.js";
import { bytesFile, openMeta, SstReader, type RunLayout } from "../src/store/sst-reader.js";

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
const db = await openHarnessDb({
  name,
  fs,
  forceMemory: true,
  ingestPolicy: { maxWalBytes: 2 ** 40 },
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
const cache = new PageCache();
const readers: { reader: SstReader; layout: RunLayout }[] = [];
for (const { path } of meta?.runs ?? []) {
  const buf = (await fs.read(path, 0, 1 << 30))!;
  sstBytes += buf.byteLength;
  tombstones += (await decodeSst(buf)).filter((e) => e.kind === "del").length;
  readers.push({
    reader: new SstReader(bytesFile(buf), cache, sstKeyRange(buf)),
    layout: (await openMeta(bytesFile(buf))).value,
  });
}
let probes = 0;
for (let k = 0; k < keys; k++) {
  const key = enc.encode(`k${k}`);
  for (const { reader, layout } of readers) {
    if (!bloomMightContain(layout.bloom, key)) continue;
    probes++;
    if (await settle(() => reader.get(key))) break;
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
