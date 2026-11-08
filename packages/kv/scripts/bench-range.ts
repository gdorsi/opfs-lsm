/**
 * Time `db.range` over a leveled layout shaped like the todo example: three
 * key prefixes (`todo/`, `idx/oldest/`, `idx/title/`), a few overlapping L0
 * runs, and disjoint L1 and L2 runs of about 4 MiB. L2 runs use LZ4, as
 * compaction writes them. Also times point gets and opening the database.
 *
 *   pnpm bench:range
 *   TODOS=1000000 ITERS=2000 pnpm bench:range
 *
 * Prints one JSON line per scenario so runs from two checkouts can be
 * compared.
 */
import "fake-indexeddb/auto";
import { formatUs, summarize } from "../bench/stats.ts";
import {
  MemoryFs
} from "../src/index.js";
import {
  openHarnessDb,
  __resetMemoryFsForTests
} from "../src/testing.js";
import { encodeSst, ensureEngine } from "../src/store/engine.js";
import { publishGeneration, publishRun, runMeta, type RunMeta } from "../src/store/generation.js";
import { levelRunPath, TARGET_RUN_BYTES } from "../src/store/levels.js";
import { entryRecordSize, type SstEntry } from "../src/store/sst.js";
import { compareBytes } from "../src/bytes.js";

const todos = Number(process.env.TODOS ?? 100_000);
const iters = Number(process.env.ITERS ?? 2_000);
const name = "bench-range";
const enc = new TextEncoder();

let seed = 7;
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
const pad = (n: number, w: number) => String(n).padStart(w, "0");

function rowsFor(i: number, seq: number): SstEntry[] {
  const time = 1_700_000_000_000 + i;
  const id = pad(i, 8);
  const title = Array.from({ length: 2 + rand(4) }, () => WORDS[rand(WORDS.length)]).join(" ");
  const primary = enc.encode(`todo/${pad(9_999_999_999_999 - time, 13)}/${id}`);
  return [
    { kind: "put", key: primary, value: enc.encode(JSON.stringify({ title, done: false })), seq },
    { kind: "put", key: enc.encode(`idx/oldest/${pad(time, 13)}/${id}`), value: primary, seq },
    { kind: "put", key: enc.encode(`idx/title/${title}/${pad(time, 13)}/${id}`), value: primary, seq },
  ];
}

async function cut(entries: SstEntry[], codec: "raw" | "lz4"): Promise<Uint8Array[]> {
  entries.sort((a, b) => compareBytes(a.key, b.key));
  const out: Uint8Array[] = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < entries.length; i++) {
    size += entryRecordSize(entries[i]!);
    if (size >= TARGET_RUN_BYTES || i === entries.length - 1) {
      out.push(await encodeSst(entries.slice(start, i + 1), codec));
      start = i + 1;
      size = 0;
    }
  }
  return out;
}

await ensureEngine();
const fs = new MemoryFs();
const runs: RunMeta[] = [];
const l2: SstEntry[] = [];
const l1: SstEntry[] = [];
const l0: SstEntry[][] = [[], [], []];
for (let i = 0; i < todos; i++) {
  l2.push(...rowsFor(i, i + 1));
  if (rand(20) === 0) l1.push(...rowsFor(i, todos + i + 1));
  if (rand(50) === 0) l0[rand(3)]!.push(...rowsFor(i, 2 * todos + i + 1));
}
for (const [i, group] of l0.entries()) {
  const path = `l0/${i}.sst`;
  const body = await encodeSst(group);
  await publishRun(fs, path, body);
  runs.push(runMeta(path, body));
}
for (const [level, entries, codec] of [[1, l1, "raw"], [2, l2, "lz4"]] as const) {
  for (const [i, body] of (await cut(entries, codec)).entries()) {
    const path = levelRunPath(level, `c1.${i}`, body.byteLength);
    await publishRun(fs, path, body);
    runs.push(runMeta(path, body));
  }
}
await publishGeneration(fs, { generation: 1, runs, tombstoneSeq: 0, through: 0 });

__resetMemoryFsForTests(name);
const openStart = performance.now();
const db = await openHarnessDb({ name, fs, forceMemory: true });
const openMs = performance.now() - openStart;
const runBytes = runs.reduce((n, r) => n + (r.path.match(/-(\d+)\.sst$/) ? Number(RegExp.$1) : 0), 0);
console.log(JSON.stringify({ todos, label: "open", openMs, runMiB: runBytes / 2 ** 20 }));
const levels = runs.reduce<Record<string, number>>((n, r) => {
  const l = r.path.slice(0, 2);
  n[l] = (n[l] ?? 0) + 1;
  return n;
}, {});

const titleStart = enc.encode("idx/title/echo");
const scenarios: { label: string; range: () => { start?: Uint8Array; endExclusive?: Uint8Array; limit?: number } }[] = [
  { label: "todo page (256)", range: () => ({ start: enc.encode("todo/"), endExclusive: enc.encode("todo0"), limit: 256 }) },
  { label: "title page (256)", range: () => ({ start: titleStart, endExclusive: enc.encode("idx/title0"), limit: 256 }) },
  {
    label: "oldest, 10 keys",
    range: () => {
      const i = rand(todos - 10);
      return {
        start: enc.encode(`idx/oldest/${pad(1_700_000_000_000 + i, 13)}`),
        endExclusive: enc.encode(`idx/oldest/${pad(1_700_000_000_000 + i + 10, 13)}`),
      };
    },
  },
  {
    label: "oldest, open end (50)",
    range: () => ({ start: enc.encode(`idx/oldest/${pad(1_700_000_000_000 + rand(todos), 13)}`), limit: 50 }),
  },
];

console.error(`todos=${todos} runs=${JSON.stringify(levels)} iters=${iters}`);
for (const s of scenarios) {
  const samples = new Float64Array(iters);
  let rows = 0;
  seed = 99;
  for (let i = 0; i < iters + 200; i++) {
    const range = s.range();
    const t = performance.now();
    let n = 0;
    for await (const entry of db.range(range)) n += entry.value.byteLength > 0 ? 1 : 0;
    const d = performance.now() - t;
    if (i >= 200) {
      samples[i - 200] = d;
      rows += n;
    }
  }
  const row = summarize(s.label, samples);
  console.error(`  ${formatUs(row)}  rows=${rows}`);
  console.log(JSON.stringify({ todos, label: s.label, p50: row.p50, p99: row.p99, rows }));
}
seed = 5;
const hitKeys = Array.from({ length: iters + 200 }, () => {
  const i = rand(todos);
  return enc.encode(`idx/oldest/${pad(1_700_000_000_000 + i, 13)}/${pad(i, 8)}`);
});
const missKeys = hitKeys.map((k) => Uint8Array.of(...k, 0x21));
for (const [label, keys] of [["get hit", hitKeys], ["get miss", missKeys]] as const) {
  const samples = new Float64Array(iters);
  let rows = 0;
  for (let i = 0; i < keys.length; i++) {
    const t = performance.now();
    const v = await db.get(keys[i]!);
    const d = performance.now() - t;
    if (i >= 200) {
      samples[i - 200] = d;
      rows += v ? 1 : 0;
    }
  }
  const row = summarize(label, samples);
  console.error(`  ${formatUs(row)}  rows=${rows}`);
  console.log(JSON.stringify({ todos, label, p50: row.p50, p99: row.p99, rows }));
}
await db.close();
