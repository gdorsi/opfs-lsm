/**
 * Writes the seed corpora for the decoder fuzzers from files the engine
 * itself produces: a small database run through ingest and two compactions
 * on MemoryFs and fake-indexeddb (L0 and L1 runs, manifests, WAL rows), and
 * a multi-block run from the compaction merge.
 *
 *   pnpm --filter @opfs-lsm/kv fuzz:corpus
 *
 * Output (only `seed-*` files are tracked; a fuzzing run adds the rest):
 *   packages/kv/fuzz/corpus/<target>/seed-*   Jazzer.js targets (fuzz/jazzer/)
 */
import "fake-indexeddb/auto";
import "../src/testing.js";
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
import { encodeRun, ensureEngine } from "../src/store/engine.js";
import type { SstEntry } from "../src/store/sst.js";
import { encodeSstRef } from "../tests/oracle/sst-ref.js";
import { mergeRuns } from "../tests/runs.js";
import { walStore } from "../tests/sim/check-database.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsCorpus = join(here, "corpus");
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

/**
 * A database through four flushes (one L0 -> L1 compaction) and a reopen, as
 * the engine writes it. The range deletes cover no key their own flush
 * writes, so the runs, and the seeds made from them, do not change with
 * them: one reaches the manifests' marks, one stays in the WAL. The last
 * WAL row is an `update`'s, so it starts with a header.
 */
async function realDatabase(): Promise<{ runs: Uint8Array[]; manifests: Uint8Array[]; walRows: Uint8Array[] }> {
  const fs = new MemoryFs();
  const host = new EngineHost(() => fs);
  const open = () => openHarnessDb({ name: "corpus", fs, ingest: createLocalIngestClient(host) });
  let db = await open();
  for (let round = 0; round < 5; round++) {
    await db.batch((tx) => {
      for (let i = 0; i < 60; i++) tx.put(utf(`todo/${String(i * 5 + round).padStart(4, "0")}`), utf(`{"title":"buy milk ${i}","done":${i % 2 === 0}}`));
      tx.delete(utf(`todo/${String(round * 7).padStart(4, "0")}`));
      if (round === 4) tx.deleteRange({ start: utf("todo/0000"), endExclusive: utf("todo/0001") });
    });
    await db.put(utf(`i/byDone/${round}`), new Uint8Array(0));
    await ingest(db);
  }
  await db.put(utf("todo/9999"), utf('{"title":"left in the WAL"}'));
  await db.delete(utf("todo/0001"));
  await db.batch((tx) => tx.deleteRange({ start: utf("todo/0100") }, { through: 3 }));
  await db.update([utf("todo/9999")], (_values, tx) => tx.put(utf("todo/9999"), utf('{"title":"updated in the WAL"}')));
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
  const db = await realDatabase();

  const merged = (await mergeRuns([[(await encodeRun(todoEntries(150, 100))).body], [db.runs[0]!]])).runs.map((r) => r.body);
  const edgeRuns = [
    encodeSstRef([]),
    encodeSstRef([{ kind: "put", key: utf("big"), value: new Uint8Array(6000).fill(0x61), seq: 1 }]),
    encodeSstRef([...todoEntries(30), { kind: "del", key: utf("todo/zz"), seq: 99 }], 256),
  ];
  const runs = [...db.runs, ...merged, ...edgeRuns].filter((r) => r.byteLength < 60_000);

  // Jazzer.js targets: byte 0 is the flags byte each target documents.
  await seeds(join(tsCorpus, "sst-read"), runs.flatMap((r) => [cat([0], r), cat([4], r)]));
  await seeds(join(tsCorpus, "sst-decode"), runs.map((r) => cat([0], r)));
  await seeds(join(tsCorpus, "manifest"), db.manifests.map((m) => cat([0], m)));
  await seeds(join(tsCorpus, "wal-row"), db.walRows.slice(0, 8));

  console.log(`seeds: ${runs.length} runs, ${db.manifests.length} manifests, ${db.walRows.length} WAL rows`);
}

await main();
