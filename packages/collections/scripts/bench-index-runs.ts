/**
 * SST bytes and read cost for a multi-index collections table. Rows go
 * through a real `Table.putMany` against a recording kv stub, so keys are
 * byte-for-byte what collections writes, then through the real wasm
 * encoder, raw and LZ4. Runs twice: with random UUID row ids, as the todo
 * example writes, and with short counter ids.
 *
 *   pnpm --filter @opfs-lsm/collections build && pnpm --filter @opfs-lsm/collections bench:index-runs
 *   ROWS=50000 ROUNDS=9 IDS=uuid pnpm --filter @opfs-lsm/collections bench:index-runs
 */
import "fake-indexeddb/auto";
import { encodeSst, engineUsingWasm, ensureEngine, prefixBound, decodeSst as wasmDecodeSst, type Db, type SstEntry } from "@opfs-lsm/kv";
// Internal kv reader, to time reads without the generation layer.
import { decodeSst, sstKeyRange } from "../../kv/dist/store/sst.js";
import { bytesFile, SstReader } from "../../kv/dist/store/sst-reader.js";
import { PageCache } from "../../kv/dist/store/page-cache.js";
import { Miss, settle } from "../../kv/dist/store/cursor.js";
import { compareBytes } from "../../kv/dist/bytes.js";
import { indexPrefix, Table, type TableSchema } from "../src/index.js";

type IdShape = "uuid" | "short";
const rows = Number(process.env.ROWS ?? 20_000);
const rounds = Number(process.env.ROUNDS ?? 7);
const gets = Number(process.env.GETS ?? 10_000);
const shapes = (process.env.IDS ? [process.env.IDS] : ["uuid", "short"]) as IdShape[];

let seed = 11;
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const hex = (n: number) => rand(2 ** 30).toString(16).padStart(8, "0").slice(0, n);
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(8)}${hex(4)}`;
const TAGS = ["home", "work", "urgent", "later", "errand", "call", "email", "read"];

type Todo = { id: string; title: string; done: boolean; createdAt: number; orgId: string; tags: string[] };

const SPEC: TableSchema = {
  name: "todos",
  indexes: [
    { name: "byDone", path: "done" },
    { name: "byCreatedAt", path: "createdAt" },
    { name: "byOrgCreated", path: ["orgId", "createdAt"] },
    { name: "byTag", path: "tags", multiEntry: true },
  ],
};

function todo(i: number, ids: IdShape): Todo {
  const tags = new Set(Array.from({ length: 1 + rand(3) }, () => TAGS[rand(TAGS.length)]!));
  return {
    id: ids === "uuid" ? uuid() : i.toString(36),
    title: `buy milk ${i}`,
    done: rand(4) === 0,
    createdAt: 1_700_000_000_000 + i * 1000 + rand(1000),
    orgId: `org-${rand(40)}`,
    tags: [...tags],
  };
}

async function recordedRows(docs: Todo[]): Promise<SstEntry[]> {
  const out: SstEntry[] = [];
  const stub = {
    update: async (keys: Uint8Array[], body: (prev: undefined[], tx: unknown) => unknown) =>
      body(keys.map(() => undefined), {
        put: (key: Uint8Array, value: Uint8Array) => out.push({ kind: "put", key, value, seq: out.length + 1 }),
        delete: () => {
          throw new Error("unexpected delete");
        },
      }),
  } as unknown as Db;
  await new Table<Todo>(stub, SPEC).putMany(docs);
  return out;
}

const assert = (ok: boolean, msg: string) => {
  if (!ok) throw new Error(msg);
};
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const version = (b: Uint8Array) => view(b).getUint32(b.byteLength - 8, true);
const blockCount = (b: Uint8Array) => view(b).getUint32(b.byteLength - 40, true);
const createdAt = prefixBound(indexPrefix("todos", "byCreatedAt"));

/** A cold reader: its first reads load the run's layout and pages. */
const readerOf = (b: Uint8Array) => new SstReader(bytesFile(b), new PageCache(), sstKeyRange(b));

async function scan(reader: SstReader): Promise<number> {
  const c = reader.cursor(createdAt);
  let n = 0;
  for (;;) {
    const e = c.peek();
    if (e instanceof Miss) {
      await e.ready;
      continue;
    }
    if (!e) return n;
    n += e.key.byteLength > 0 ? 1 : 0;
    c.next();
  }
}

async function bench(ids: IdShape): Promise<void> {
  seed = 11;
  const entries = (await recordedRows(Array.from({ length: rows }, (_, i) => todo(i, ids)))).sort((a, b) =>
    compareBytes(a.key, b.key),
  );
  const indexEntries = entries.filter((e) => e.key[0] === 0x69); // "i/"
  const expectScan = indexEntries.filter(
    (e) => compareBytes(e.key, createdAt.start) >= 0 && compareBytes(e.key, createdAt.endExclusive!) < 0,
  ).length;
  assert(expectScan === rows, `byCreatedAt holds one key per row (${expectScan})`);
  const probes = Array.from({ length: gets }, () => indexEntries[rand(indexEntries.length)]!.key);

  const runs = { raw: await encodeSst(entries, "raw"), lz4: await encodeSst(entries, "lz4") };
  const indexRuns = { raw: await encodeSst(indexEntries, "raw"), lz4: await encodeSst(indexEntries, "lz4") };

  console.log(`\n## ids=${ids} rows=${rows} entries=${entries.length} index entries=${indexEntries.length} sst version=${version(runs.raw)}`);
  console.log(`${"run".padEnd(18)}${"bytes".padStart(11)}${"blocks".padStart(8)}${"B/entry".padStart(9)}`);
  for (const [label, b, n] of [
    ["all raw", runs.raw, entries.length],
    ["all lz4", runs.lz4, entries.length],
    ["index-only raw", indexRuns.raw, indexEntries.length],
    ["index-only lz4", indexRuns.lz4, indexEntries.length],
  ] as const) {
    console.log(
      `${label.padEnd(18)}${String(b.byteLength).padStart(11)}${String(blockCount(b)).padStart(8)}${(b.byteLength / n).toFixed(1).padStart(9)}`,
    );
  }

  const getAll = async (reader: SstReader) => {
    let hits = 0;
    for (const k of probes) {
      let e = reader.get(k);
      if (e instanceof Miss) e = await settle(() => reader.get(k));
      if (e?.kind === "put") hits++;
    }
    return hits;
  };
  const ops: Record<string, (b: Uint8Array) => boolean | Promise<boolean>> = {
    "decode ts": (b) => decodeSst(b).length === entries.length,
    "decode wasm": async (b) => (await wasmDecodeSst(b)).length === entries.length,
    "index scan": async (b) => (await scan(readerOf(b))) === rows,
    [`${gets} gets`]: async (b) => (await getAll(readerOf(b))) === gets,
  };

  const ms = new Map<string, number[]>();
  for (let r = 0; r < rounds + 1; r++) {
    const order = r % 2 === 0 ? (["raw", "lz4"] as const) : (["lz4", "raw"] as const);
    for (const codec of order) {
      for (const [op, run] of Object.entries(ops)) {
        const t = performance.now();
        const ok = await run(runs[codec]);
        const d = performance.now() - t;
        assert(ok, `${op} ${codec} returned the expected count`);
        if (r === 0) continue;
        const key = `${op} ${codec}`;
        ms.set(key, [...(ms.get(key) ?? []), d]);
      }
    }
  }

  console.log(`timings (ms) over ${rounds} rounds after 1 warmup, codecs alternating, every count asserted`);
  console.log(`${"op".padEnd(22)}${"median".padStart(9)}${"min".padStart(9)}${"max".padStart(9)}`);
  for (const [key, xs] of [...ms].sort(([a], [b]) => a.localeCompare(b))) {
    const s = [...xs].sort((a, b) => a - b);
    console.log(
      `${key.padEnd(22)}${s[s.length >> 1]!.toFixed(2).padStart(9)}${s[0]!.toFixed(2).padStart(9)}${s[s.length - 1]!.toFixed(2).padStart(9)}`,
    );
  }
}

await ensureEngine();
assert(engineUsingWasm(), "wasm engine loaded");
for (const ids of shapes) await bench(ids);
