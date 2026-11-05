/**
 * Time the memtable's operations as it grows. 130k rows is about what the
 * 4 MiB flush limit holds with small values.
 *
 *   pnpm bench:memtable
 *   ROWS=10000,50000,130000 pnpm bench:memtable
 */
import { formatUs, summarize } from "../bench/stats.ts";
import type { CheckedKey, CheckedValue } from "../src/check.js";
import { sliceRows } from "../src/store/merge.js";
import { Memtable } from "../src/store/memtable.js";

const sizes = (process.env.ROWS ?? "10000,130000").split(",").map(Number);
const enc = new TextEncoder();
const keyOf = (i: number) => enc.encode(`user:${String(i).padStart(8, "0")}`) as CheckedKey;
const value = new Uint8Array(16) as CheckedValue;

for (const rows of sizes) {
  const order = Uint32Array.from({ length: rows }, (_, i) => i);
  for (let i = rows - 1; i > 0; i--) {
    const j = (Math.imul(i, 2654435761) >>> 0) % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const mem = new Memtable();
  const tail = Math.min(10_000, rows);
  const insert = new Float64Array(tail);
  const advance = new Float64Array(tail);
  for (let i = 0; i < rows; i++) {
    const op = { type: "put" as const, key: keyOf(order[i]!), value };
    const t = performance.now();
    mem.apply({ seq: i + 1, ops: [op] });
    const d = performance.now() - t;
    if (i >= rows - tail) {
      insert[i - (rows - tail)] = d;
      const a = performance.now();
      mem.advanceTo(0);
      advance[i - (rows - tail)] = performance.now() - a;
    }
  }
  if (mem.sorted.length !== rows) throw new Error(`memtable holds ${mem.sorted.length} of ${rows}`);

  const probes = 20_000;
  const hit = new Float64Array(probes);
  const miss = new Float64Array(probes);
  const scan = new Float64Array(probes);
  for (let i = 0; i < probes; i++) {
    const k = (Math.imul(i, 40503) >>> 0) % rows;
    let t = performance.now();
    if (!mem.get(keyOf(k))) throw new Error(`get missing ${k}`);
    hit[i] = performance.now() - t;
    t = performance.now();
    if (mem.get(keyOf(rows + 1 + i))) throw new Error(`get found ${rows + 1 + i}`);
    miss[i] = performance.now() - t;
    t = performance.now();
    sliceRows(mem.sorted, { start: keyOf(k), endExclusive: keyOf(k + 100) });
    scan[i] = performance.now() - t;
  }
  const snapshot = new Float64Array(200);
  for (let i = 0; i < snapshot.length; i++) {
    const t = performance.now();
    mem.sorted.slice();
    snapshot[i] = performance.now() - t;
  }

  console.log(`rows=${rows}, last ${tail} inserts`);
  for (const row of [
    summarize("insert", insert),
    summarize("advanceTo (no change)", advance),
    summarize("get hit", hit),
    summarize("get miss", miss),
    summarize("scan 100", scan),
    summarize("view snapshot", snapshot),
  ]) {
    console.log(`  ${formatUs(row)}`);
  }
}
