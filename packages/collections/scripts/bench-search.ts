/**
 * Time a todo search two ways over a leveled layout: the substring walk the
 * todo example does today (page `byNewest`, decode each row, keep titles
 * that contain the text), and one page of a multi-entry `byTermNewest`
 * index whose terms are each title word and every prefix of it.
 *
 * Index keys come from a real `Table.putMany` run against a recording kv
 * stub, so they are byte-for-byte what collections writes. The rows are
 * then laid out as L0, L1 and LZ4 L2 runs, as compaction leaves them.
 *
 *   pnpm bench:search
 *   TODOS=1000000 SEARCHES=2 pnpm bench:search
 *   TERMS=words pnpm bench:search    (whole words only, no prefixes)
 */
import "fake-indexeddb/auto";
import {
  MemoryFs,
  encodeSst,
  ensureEngine,
  type Db,
  type SstEntry,
} from "@opfs-lsm/kv";
import {
  __resetMemoryFsForTests,
  openHarnessDb,
} from "@opfs-lsm/kv/testing";
// Internal kv helpers, to lay runs out without the write path.
import { publishGeneration, publishRun, runMeta, type RunMeta } from "../../kv/dist/store/generation.js";
import { levelRunPath, TARGET_RUN_BYTES } from "../../kv/dist/store/levels.js";
import { entryRecordSize } from "../../kv/dist/store/sst.js";
import { compareBytes } from "../../kv/dist/bytes.js";
import { CollectionDb, Table, type CollectionSchema } from "../src/index.js";

const todos = Number(process.env.TODOS ?? 100_000);
const searches = Number(process.env.SEARCHES ?? 5);
const iters = Number(process.env.ITERS ?? 500);
const name = "bench-search";
const PAGE = 50;

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

type Todo = { id: string; title: string; done: boolean; createdAt: number; newest: number; terms: string[] };

const wordsOnly = process.env.TERMS === "words";

/** Each word of the title and, unless TERMS=words, every prefix of it, so typing "mil" finds "milk". */
function termsOf(title: string): string[] {
  const out = new Set<string>();
  for (const word of title.toLowerCase().split(/\s+/)) {
    for (let i = wordsOnly ? word.length : 1; i <= word.length; i++) out.add(word.slice(0, i));
  }
  return [...out];
}

const SCHEMA: CollectionSchema = {
  tables: [
    {
      name: "todos",
      indexes: [
        { name: "byNewest", path: "newest" },
        { name: "byTermNewest", path: ["terms", "newest"], multiEntry: true },
      ],
    },
  ],
};

function todo(i: number): Todo {
  const createdAt = 1_700_000_000_000 + i;
  const title = i === 0 ? "needle" : Array.from({ length: 2 + rand(4) }, () => WORDS[rand(WORDS.length)]).join(" ");
  return { id: uuid(), title, done: false, createdAt, newest: 10 ** 15 - 1 - createdAt, terms: termsOf(title) };
}

/** The entries `Table.putMany` writes for `docs` into an empty table. */
async function recordedRows(docs: Todo[], seq: number): Promise<SstEntry[]> {
  const out: SstEntry[] = [];
  const stub = {
    update: async (keys: Uint8Array[], body: (prev: undefined[], tx: unknown) => unknown) =>
      body(keys.map(() => undefined), {
        put: (key: Uint8Array, value: Uint8Array) => out.push({ kind: "put", key, value, seq }),
        delete: () => {
          throw new Error("unexpected delete");
        },
      }),
  } as unknown as Db;
  await new Table<Todo>(stub, SCHEMA.tables[0]!).putMany(docs);
  return out;
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
for (let i = 0; i < todos; i += 1000) {
  const docs = Array.from({ length: Math.min(1000, todos - i) }, (_, j) => todo(i + j));
  l2.push(...(await recordedRows(docs, 1)));
  const recent = docs.filter(() => rand(20) === 0);
  if (recent.length) l1.push(...(await recordedRows(recent, 2)));
  const newest = docs.filter(() => rand(50) === 0);
  if (newest.length) l0[rand(3)]!.push(...(await recordedRows(newest, 3)));
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
const kv = await openHarnessDb({ name, fs, forceMemory: true });
const table = new CollectionDb(kv, SCHEMA).table<Todo>("todos");
const levels = runs.reduce<Record<string, number>>((n, r) => {
  const l = r.path.slice(0, 2);
  n[l] = (n[l] ?? 0) + 1;
  return n;
}, {});
const termRoot = new TextEncoder().encode("byTermNewest");
const isTerm = (key: Uint8Array) => {
  outer: for (let i = 0; i + termRoot.byteLength <= Math.min(key.byteLength, 40); i++) {
    for (let j = 0; j < termRoot.byteLength; j++) if (key[i + j] !== termRoot[j]) continue outer;
    return true;
  }
  return false;
};
const recordBytes = (rows: SstEntry[], keep: (k: Uint8Array) => boolean) =>
  rows.reduce((n, e) => n + (keep(e.key) ? entryRecordSize(e) : 0), 0);
const allBytes = recordBytes(l2, () => true);
const termBytes = recordBytes(l2, isTerm);
const runMiB = runs.reduce((n, r) => n + Number(/-(\d+)\.sst$/.exec(r.path)?.[1] ?? 0), 0) / 2 ** 20;
console.error(`todos=${todos} runs=${JSON.stringify(levels)} run MiB=${runMiB.toFixed(1)} term index share of records=${((100 * termBytes) / allBytes).toFixed(0)}%`);
console.log(JSON.stringify({ todos, label: "layout", terms: wordsOnly ? "words" : "prefixes", runMiB, termShare: termBytes / allBytes }));

/** The todo example's readPage: page byNewest and keep titles containing `text`. */
async function substringSearch(text: string): Promise<number> {
  const found: Todo[] = [];
  let after: Uint8Array | undefined;
  for (;;) {
    const page = await table.page("byNewest", { limit: PAGE, ...(after ? { after } : {}) });
    for (const d of page.docs) if (d.title.includes(text)) found.push(d);
    if (found.length >= PAGE || page.next === undefined) return found.length;
    after = page.next;
  }
}

async function termSearch(text: string): Promise<number> {
  return (await table.page("byTermNewest", { value: text, limit: PAGE })).docs.length;
}

const cases = [
  ["substring walk", "no match", () => substringSearch("zzz")],
  ["substring walk", "one match at the end", () => substringSearch("needle")],
  ["term index", "no match", () => termSearch("zzz")],
  ["term index", "one match at the end", () => termSearch("needle")],
  ["term index", "common word, full page", () => termSearch("alpha")],
  ...(wordsOnly ? [] : ([["term index", "one-letter prefix, full page", () => termSearch("a")]] as const)),
] as const;

for (const [how, what, run] of cases) {
  const slow = how === "substring walk";
  const n = slow ? searches : iters;
  const ms: number[] = [];
  let found = 0;
  for (let i = 0; i < n + (slow ? 1 : 50); i++) {
    const t = performance.now();
    found = await run();
    const d = performance.now() - t;
    if (i >= (slow ? 1 : 50)) ms.push(d);
  }
  ms.sort((a, b) => a - b);
  const p50 = ms[ms.length >> 1]!;
  const p99 = ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.99))]!;
  const label = `${how}, ${what}`;
  console.error(`  ${label.padEnd(46)} p50 ${p50 >= 10 ? `${p50.toFixed(0)} ms` : `${(p50 * 1000).toFixed(0)} µs`}  found=${found}`);
  console.log(JSON.stringify({ todos, label, p50, p99, found }));
}
await kv.close();
