/**
 * Time index scans that follow each row to its primary row, as the
 * collections package does for `table.page`, over a leveled layout shaped
 * like the todo example: primary rows keyed by random UUID with JSON values,
 * and a `byNewest` index. L2 runs use LZ4, as compaction writes them.
 *
 * The search scenarios copy the todo example's `readPage`: page through the
 * index 50 rows at a time, decode each followed row, and keep the ones whose
 * title contains the filter, until the page fills or the index ends.
 *
 *   pnpm bench:follow
 *   TODOS=1000000 SEARCHES=3 pnpm bench:follow
 *   L2_CODEC=raw pnpm bench:follow
 *
 * Prints one JSON line per scenario so runs from two checkouts can be
 * compared.
 */
import "fake-indexeddb/auto";
import { formatUs, summarize } from "../bench/stats.ts";
import {
  MemoryFs,
  type Db
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
const searches = Number(process.env.SEARCHES ?? 5);
const iters = Number(process.env.ITERS ?? 1_000);
const name = "bench-follow";
const enc = new TextEncoder();
const dec = new TextDecoder();
const PAGE = 50;
const NEEDLE = "needle";

let seed = 7;
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const hex = (n: number) => rand(2 ** 30).toString(16).padStart(8, "0").slice(0, n);
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(8)}${hex(4)}`;
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];

/** The collections key layout: u16 length-prefixed segments. */
function segment(s: string): Uint8Array {
  const body = enc.encode(s);
  const out = new Uint8Array(2 + body.byteLength);
  new DataView(out.buffer).setUint16(0, body.byteLength, true);
  out.set(body, 2);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
const T = concat(enc.encode("t/"), segment("todos"));
const I = concat(enc.encode("i/"), segment("todos"), segment("byNewest"));
const primary = (id: string) => concat(T, segment(id));
function indexKey(newest: number, id: string): Uint8Array {
  const v = new Uint8Array(8);
  new DataView(v.buffer).setFloat64(0, newest);
  return concat(I, v, segment(id));
}
const idOf = (indexKey: Uint8Array) => indexKey.subarray(I.byteLength + 8);

type Todo = { id: string; title: string; done: boolean; createdAt: number; newest: number; titleSort: string };

function rowsFor(i: number, id: string, seq: number): SstEntry[] {
  const createdAt = 1_700_000_000_000 + i;
  const newest = 10 ** 15 - 1 - createdAt;
  const title =
    i === 0 ? NEEDLE : Array.from({ length: 2 + rand(4) }, () => WORDS[rand(WORDS.length)]).join(" ");
  const doc: Todo = { id, title, done: false, createdAt, newest, titleSort: title };
  return [
    { kind: "put", key: primary(id), value: enc.encode(JSON.stringify(doc)), seq },
    { kind: "put", key: indexKey(newest, id), value: new Uint8Array(0), seq },
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
const ids: string[] = [];
for (let i = 0; i < todos; i++) {
  const id = uuid();
  ids.push(id);
  l2.push(...rowsFor(i, id, i + 1));
  if (rand(20) === 0) l1.push(...rowsFor(i, id, todos + i + 1));
  if (rand(50) === 0) l0[rand(3)]!.push(...rowsFor(i, id, 2 * todos + i + 1));
}
for (const [i, group] of l0.entries()) {
  const path = `l0/${i}.sst`;
  const body = await encodeSst(group);
  await publishRun(fs, path, body);
  runs.push(runMeta(path, body));
}
const l2Codec = process.env.L2_CODEC === "raw" ? "raw" : "lz4";
for (const [level, entries, codec] of [[1, l1, "raw"], [2, l2, l2Codec]] as const) {
  for (const [i, body] of (await cut(entries, codec)).entries()) {
    const path = levelRunPath(level, `c1.${i}`, body.byteLength);
    await publishRun(fs, path, body);
    runs.push(runMeta(path, body));
  }
}
await publishGeneration(fs, { generation: 1, runs, tombstoneSeq: 0, through: 0 });

__resetMemoryFsForTests(name);
const db = await openHarnessDb({ name, fs, forceMemory: true });
const levels = runs.reduce<Record<string, number>>((n, r) => {
  const l = r.path.slice(0, 2);
  n[l] = (n[l] ?? 0) + 1;
  return n;
}, {});
console.error(`todos=${todos} runs=${JSON.stringify(levels)}`);

const indexEnd = concat(I.subarray(0, I.byteLength - 1), Uint8Array.of(I[I.byteLength - 1]! + 1));

/** One page of `table.page`: PAGE + 1 index rows, each followed to its primary row. */
async function page(db: Db, start: Uint8Array) {
  const hits = await db.rangeFollow(
    { start, endExclusive: indexEnd, limit: PAGE + 1 },
    (entry) => concat(T, idOf(entry.key)),
  );
  const docs = hits.slice(0, PAGE).flatMap((h) => (h.value ? [JSON.parse(dec.decode(h.value)) as Todo] : []));
  return { docs, next: hits[PAGE]?.entry.key };
}

/** The todo example's `readPage` with a filter. Returns matches and rows followed. */
async function search(filter: string) {
  const found: Todo[] = [];
  let cursor: Uint8Array | undefined = I;
  let followed = 0;
  while (cursor) {
    const p = await page(db, cursor);
    followed += p.docs.length;
    for (const d of p.docs) if (d.title.includes(filter)) found.push(d);
    if (found.length >= PAGE) break;
    cursor = p.next;
  }
  return { found: found.length, followed };
}

for (const [label, filter] of [
  ["search, no match", "zzz"],
  ["search, one match at the end", NEEDLE],
] as const) {
  const ms: number[] = [];
  let shape = { found: 0, followed: 0 };
  for (let i = 0; i < searches + 1; i++) {
    const t = performance.now();
    shape = await search(filter);
    if (i > 0) ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const p50 = ms[ms.length >> 1]!;
  console.error(`  ${label.padEnd(30)} p50 ${p50.toFixed(0).padStart(6)} ms  found=${shape.found} followed=${shape.followed}`);
  console.log(JSON.stringify({ todos, label, p50, ...shape }));
}

seed = 11;
for (const label of ["page of 50, followed", "get hit", "get miss"] as const) {
  const samples = new Float64Array(iters);
  for (let i = 0; i < iters + 200; i++) {
    const id = ids[rand(todos)]!;
    const t = performance.now();
    if (label === "page of 50, followed") {
      const at = rand(todos - 2 * PAGE);
      const { docs } = await page(db, indexKey(10 ** 15 - 1 - (1_700_000_000_000 + at), ""));
      if (docs.length !== PAGE) throw new Error("short page");
    } else if (label === "get hit") {
      if (!(await db.get(primary(id)))) throw new Error(`missing ${id}`);
    } else if (await db.get(primary(`${id}!`))) throw new Error("found a miss");
    const d = performance.now() - t;
    if (i >= 200) samples[i - 200] = d;
  }
  const row = summarize(label, samples);
  console.error(`  ${formatUs(row)}`);
  console.log(JSON.stringify({ todos, label, p50: row.p50, p99: row.p99 }));
}
await db.close();
