/**
 * Jazzer.js entry points, one per decoder. `run.ts` bundles this file and
 * runs one entry under libFuzzer; a `RuleBroken` (or any other throw) is a
 * finding. The checks are the ones the fast-check properties run
 * (`../targets.ts`). These cover the TypeScript decoders; the wasm engine
 * has its own targets (`engine-entries.ts`). `sstRead` loads the shipped
 * engine, which scans a tab's blocks.
 */
import { readFile } from "node:fs/promises";
import { engineMemory, ensureEngine, readEngineWith } from "../../src/store/engine.js";
import { decodeIndex } from "../../src/store/sst.js";
import {
  checkDecodeSst,
  checkManifest,
  checkRunRead,
  checkWalRow,
  fixManifestCrc,
  footerOf,
  repairSst,
  type Repair,
  watchWasmMemory,
} from "../targets.js";

readEngineWith((url) => readFile(url));
watchWasmMemory(() => engineMemory().wasmBytes);
let engine: Promise<void> | undefined;

const REPAIRS: readonly Repair[] = ["none", "crc", "trailer", "trailer"];
const PATTERN = new TextEncoder().encode(" hot");
const FIXED_KEYS = ["", "todo/000005", "t/a", "zzzz"].map((k) => new TextEncoder().encode(k));

/** The first and last keys the index names, read without trusting it. */
function indexKeys(buf: Uint8Array): Uint8Array[] {
  const f = footerOf(buf);
  if (!f) return [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const keys: Uint8Array[] = [];
  let o = f.indexStart;
  for (let i = 0; i < Math.min(f.blockCount, 8); i++) {
    for (let k = 0; k < 2; k++) {
      if (o + 4 > buf.byteLength) return keys;
      const len = view.getUint32(o, true);
      if (o + 4 + len > buf.byteLength || len > 256) return keys;
      keys.push(buf.slice(o + 4, o + 4 + len));
      o += 4 + len;
    }
    o += 8;
  }
  return keys;
}

/** `file` repaired as bits 0-1 of `flags` pick: not at all, its CRC, or its trailer. */
function repaired(file: Uint8Array, flags: number): Uint8Array {
  repairSst(file, REPAIRS[flags & 3]!);
  return file;
}

/**
 * A tab's reads of one run: `SstReader` get, scans and filtered scan. Byte 0
 * picks the file's repair, a u16 gives the length of a manifest, and the
 * file follows. The run's entry is the manifest's first, read as a tab reads
 * it: through `decodeGeneration`, with the CRC rewritten so that mutations
 * reach the index behind it. The reader fails every read of a file that is
 * not the size its entry records, so the entry takes the file's size when
 * its blocks end inside the file.
 */
export async function sstRead(data: Uint8Array): Promise<void> {
  if (data.byteLength < 3) return;
  const fileAt = 3 + (data[1]! | (data[2]! << 8));
  const manifest = data.slice(3, fileAt);
  fixManifestCrc(manifest);
  const run = (await checkManifest(manifest, false))?.runs[0];
  const buf = repaired(data.slice(fileAt), data[0]!);
  if (!run) return;
  const { blockStart, sepEnd } = decodeIndex(run.index, run.bytes);
  if (blockStart[sepEnd.length]! > buf.byteLength) return;
  await (engine ??= ensureEngine());
  const keys = [...indexKeys(buf), ...(run.range ? [run.range.smallest, run.range.largest] : []), ...FIXED_KEYS];
  await checkRunRead(buf, { keys, run: { ...run, bytes: buf.byteLength }, pattern: PATTERN });
}

/** The SharedWorker's full decode of a run, in TypeScript. Byte 0 picks the repair. */
export async function sstDecode(data: Uint8Array): Promise<void> {
  if (data.byteLength > 0) await checkDecodeSst(repaired(data.slice(1), data[0]!), false);
}

/** `decodeGeneration`. Byte 0 bit 0 rewrites the CRC. */
export async function manifest(data: Uint8Array): Promise<void> {
  if (data.byteLength < 1) return;
  const buf = data.slice(1);
  if (data[0]! & 1) fixManifestCrc(buf);
  await checkManifest(buf, false);
}

/** `decodeOps` on one WAL row. */
export async function walRow(data: Uint8Array): Promise<void> {
  await checkWalRow(data.slice().buffer);
}
