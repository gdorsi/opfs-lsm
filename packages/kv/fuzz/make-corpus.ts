/**
 * Writes the seed corpora for the decoder fuzzers from files the engine
 * itself produces: a small database run through ingest and two compactions
 * on MemoryFs and fake-indexeddb (L0 and L1 runs, manifests, WAL rows), and
 * LZ4 runs from the wasm encoder and compaction merge, as L2+ runs are
 * written.
 *
 *   pnpm --filter @opfs-lsm/kv fuzz:corpus
 *
 * Output (only `seed-*` files are tracked; a fuzzing run adds the rest):
 *   packages/kv/fuzz/corpus/<target>/seed-*          Jazzer.js targets (fuzz/jazzer/)
 *   crates/engine-core/fuzz/corpus/<target>/seed-*   cargo fuzz targets
 */
import "fake-indexeddb/auto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openHarnessDb,
  ingest,
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
} from "../src/testing.js";
import { encodeSst as encodeSstWasm, ensureEngine, engineUsingWasm } from "../src/store/engine.js";
import { encodeSst, type SstEntry } from "../src/store/sst.js";
import { mergeRuns } from "../tests/runs.js";
import { walStore } from "../tests/sim/check-database.js";
import { framedBlocks } from "./targets.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsCorpus = join(here, "corpus");
const rustCorpus = join(here, "../../../crates/engine-core/fuzz/corpus");
const utf = (s: string) => new TextEncoder().encode(s);

async function seeds(dir: string, files: readonly Uint8Array[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) if (name.startsWith("seed-")) await rm(join(dir, name));
  for (const [i, bytes] of files.entries()) await writeFile(join(dir, `seed-${String(i).padStart(3, "0")}`), bytes);
}

const cat = (...parts: (Uint8Array | number[])[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** A database through four flushes (one L0 -> L1 compaction) and a reopen, as the engine writes it. */
async function realDatabase(): Promise<{ runs: Uint8Array[]; manifests: Uint8Array[]; walRows: Uint8Array[] }> {
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const open = () => openHarnessDb({ name: "corpus", fs, ingest: createLocalIngestClient(host) });
  let db = await open();
  for (let round = 0; round < 5; round++) {
    await db.batch((tx) => {
      for (let i = 0; i < 60; i++) tx.put(utf(`todo/${String(i * 5 + round).padStart(4, "0")}`), utf(`{"title":"buy milk ${i}","done":${i % 2 === 0}}`));
      tx.delete(utf(`todo/${String(round * 7).padStart(4, "0")}`));
    });
    await db.put(utf(`i/byDone/${round}`), new Uint8Array(0));
    await ingest(db);
  }
  await db.put(utf("todo/9999"), utf('{"title":"left in the WAL"}'));
  await db.delete(utf("todo/0001"));
  await db.close();
  db = await open();
  await db.close();

  const runs: Uint8Array[] = [];
  for (const dir of await fs.list("")) {
    if (!/^l\d+$/.test(dir)) continue;
    for (const name of await fs.list(dir)) runs.push((await fs.read(`${dir}/${name}`, 0, Infinity))!);
  }
  const manifests: Uint8Array[] = [];
  for (const name of await fs.list("m")) manifests.push((await fs.read(`m/${name}`, 0, Infinity))!);
  const raw = await walStore("corpus", "readonly", (wal) => wal.getAll());
  const walRows = (raw as unknown[]).map((r) => new Uint8Array(r as ArrayBuffer));
  return { runs, manifests, walRows };
}

function todoEntries(n: number, from = 0): SstEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "put" as const,
    key: utf(`todo/${String(from + i).padStart(6, "0")}`),
    value: utf(`{"title":"buy milk ${i % 7}","done":false}`),
    seq: from + i + 1,
  }));
}

async function main(): Promise<void> {
  await ensureEngine();
  if (!engineUsingWasm()) throw new Error("wasm did not load: run `pnpm --filter @opfs-lsm/kv build:wasm`");
  const db = await realDatabase();

  const lz4Runs = [
    await encodeSstWasm(todoEntries(40), "lz4"),
    // An L2-sized compaction output: several LZ4 blocks.
    ...(await mergeRuns([[await encodeSstWasm(todoEntries(150, 100), "raw")], [db.runs[0]!]], { codec: "lz4" })).runs.map((r) => r.body),
  ];
  const edgeRuns = [
    encodeSst([]),
    encodeSst([{ kind: "put", key: utf("big"), value: new Uint8Array(6000).fill(0x61), seq: 1 }]),
    encodeSst([...todoEntries(30), { kind: "del", key: utf("todo/zz"), seq: 99 }], 256),
  ];
  const runs = [...db.runs, ...lz4Runs, ...edgeRuns].filter((r) => r.byteLength < 60_000);
  const lz4Blocks = lz4Runs.flatMap((r) => framedBlocks(r)).slice(0, 6);
  const rawBlocks = [...db.runs, ...edgeRuns].flatMap((r) => framedBlocks(r)).slice(0, 6);

  // Jazzer.js targets: byte 0 is the flags byte each target documents.
  await seeds(join(tsCorpus, "sst-read"), runs.flatMap((r) => [cat([0], r), cat([4], r)]));
  await seeds(join(tsCorpus, "sst-decode"), runs.map((r) => cat([0], r)));
  await seeds(join(tsCorpus, "manifest"), db.manifests.map((m) => cat([0], m)));
  await seeds(join(tsCorpus, "wal-row"), db.walRows.slice(0, 8));
  await seeds(join(tsCorpus, "lz4"), lz4Blocks);

  // cargo fuzz targets (crates/engine-core/fuzz/fuzz_targets/).
  await seeds(join(rustCorpus, "decode_sst"), runs.flatMap((r) => [cat([0], r), cat([1], r)]));
  await seeds(
    join(rustCorpus, "scan_block_contains"),
    [...rawBlocks.map((b) => cat([0, 0], b)), ...lz4Blocks.map((b) => cat([1, 4], utf("milk"), b))],
  );
  const small = runs.filter((r) => r.byteLength < 30_000);
  await seeds(join(rustCorpus, "decode_block"), [...rawBlocks.map((b) => cat([0], b)), ...lz4Blocks.map((b) => cat([1], b))]);
  // Header: flags, target, group (bit i: run i + 1 joins run i's source), window sizes, feed seed.
  const session = (header: number[], ...runList: Uint8Array[]) =>
    cat(header, ...runList.flatMap((r) => [[r.byteLength & 0xff, r.byteLength >> 8], r]));
  await seeds(join(rustCorpus, "merge_session"), [
    session([0, 0, 0, 0x00, 0], small[1]!, small[0]!),
    session([1, 4, 0, 0x12, 1], small[1]!, small[0]!),
    session([2 | 8, 0, 0, 0x34, 2], lz4Runs[0]!, small[0]!),
    session([1, 1, 0b1, 0x51, 3], encodeSst(todoEntries(30)), encodeSst(todoEntries(30, 30)), edgeRuns[2]!),
    session([0, 0, 0, 0x60, 4], edgeRuns[0]!, edgeRuns[1]!),
  ]);
  console.log(
    `seeds: ${runs.length} runs (${lz4Runs.length} LZ4), ${db.manifests.length} manifests, ${db.walRows.length} WAL rows, ${lz4Blocks.length + rawBlocks.length} blocks`,
  );
}

await main();
