/**
 * Where does a full scan of one run spend its time? Search-shaped keys
 * (about 60 B) and values (about 30 B), no IndexedDB. Blocks are raw, as L0
 * and L1 write them. CODEC=lz4 measures the blocks of L2 and deeper.
 *
 *   ROWS=200000 CODEC=raw pnpm exec tsx scripts/bench-scan-split.ts
 */
import { encodeSst, engineUsingWasm, ensureEngine } from "../src/store/engine.js";
import { Miss, type LayerCursor } from "../src/store/cursor.js";
import { PageCache } from "../src/store/page-cache.js";
import { sstKeyRange, type SstEntry } from "../src/store/sst.js";
import { bytesFile, SstReader } from "../src/store/sst-reader.js";

const rows = Number(process.env.ROWS ?? 200_000);
await ensureEngine();
if (!engineUsingWasm()) throw new Error("wasm did not load");
const enc = new TextEncoder();
let seed = 7;
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const W = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const entries: SstEntry[] = Array.from({ length: rows }, (_, i) => ({
  kind: "put" as const,
  key: enc.encode(`s/todos/${String(10 ** 15 - i).padStart(16, "0")}/${i.toString(16).padStart(8, "0")}-0000-4000-a000-000000000000`),
  value: enc.encode(` ${Array.from({ length: 2 + rand(4) }, () => W[rand(W.length)]).join(" ")}`),
  seq: i + 1,
}));
const sst = await encodeSst(entries, process.env.CODEC === "lz4" ? "lz4" : "raw");
console.error(`rows=${rows} codec=${process.env.CODEC === "lz4" ? "lz4" : "raw"} sst=${(sst.byteLength / 2 ** 20).toFixed(1)} MiB`);

// A budget above the run, so after the first pass every scan is warm.
const reader = new SstReader(bytesFile(sst), new PageCache(4 * sst.byteLength), sstKeyRange(sst));

/** Calls `f` on each entry of `c`, waiting out misses. */
async function each(c: LayerCursor, f: (value: Uint8Array | undefined) => void): Promise<void> {
  for (;;) {
    const e = c.peek();
    if (e instanceof Miss) {
      await e.ready;
      continue;
    }
    if (!e) return;
    f(e.value);
    c.next();
  }
}

const time = async (name: string, f: () => Promise<number>) => {
  const ms: number[] = [];
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    n = await f();
    if (i >= 2) ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.error(`${name.padEnd(34)} ${ms[2]!.toFixed(1)} ms  ${((ms[2]! * 1e6) / rows).toFixed(0)} ns/key  (${n})`);
};

const token = enc.encode(" 0zz");
const has = (v: Uint8Array) => {
  outer: for (let i = 0; i + token.length <= v.length; i++) {
    for (let j = 0; j < token.length; j++) if (v[i + j] !== token[j]) continue outer;
    return true;
  }
  return false;
};
await time("cursor scan, copies, no match", async () => {
  let n = 0;
  await each(reader.cursor(), () => n++);
  return n;
});
await time("cursor scan + byte match", async () => {
  let n = 0;
  await each(reader.cursor(), (v) => {
    if (v && has(v)) n++;
  });
  return n;
});
await time("scanContains in wasm, miss", async () => {
  let n = 0;
  await each(reader.scanContains([token]), () => n++);
  return n;
});
await time("scanContains in wasm, common word", async () => {
  let n = 0;
  await each(reader.scanContains([enc.encode(" alpha")]), () => n++);
  return n;
});
