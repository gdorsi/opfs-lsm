/**
 * Where does a full scan of one run spend its time? Search-shaped keys
 * (about 60 B) and values (about 30 B), LZ4 blocks, no IndexedDB.
 *
 *   ROWS=200000 pnpm exec tsx scripts/bench-scan-split.ts
 */
import { encodeSst, engineUsingWasm, ensureEngine } from "../src/store/engine.js";
import { SstReader, type SstEntry } from "../src/store/sst.js";
import { lz4Decompress } from "../src/store/lz4.js";

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
const sst = await encodeSst(entries);
console.error(`rows=${rows} sst=${(sst.byteLength / 2 ** 20).toFixed(1)} MiB`);

const time = (name: string, f: () => number) => {
  const ms: number[] = [];
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    n = f();
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
time("cursor scan, copies, no match", () => {
  const c = new SstReader(sst).cursor();
  let n = 0;
  for (let e = c.peek(); e; c.next(), e = c.peek()) n++;
  return n;
});
time("cursor scan + byte match", () => {
  const c = new SstReader(sst).cursor();
  let n = 0;
  for (let e = c.peek(); e; c.next(), e = c.peek()) if (e.value && has(e.value)) n++;
  return n;
});
time("scanContains in wasm, miss", () => {
  let n = 0;
  for (const _ of new SstReader(sst).scanContains([token])) n++;
  return n;
});
time("scanContains in wasm, common word", () => {
  let n = 0;
  for (const _ of new SstReader(sst).scanContains([enc.encode(" alpha")])) n++;
  return n;
});
