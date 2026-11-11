/**
 * Jazzer.js entry points, one per decoder. `run.ts` bundles this file and
 * runs one entry under libFuzzer; a `RuleBroken` (or any other throw) is a
 * finding. The checks are the ones the fast-check properties run
 * (`../targets.ts`). These cover the TypeScript decoders only: the wasm
 * ones are covered natively by `cargo fuzz` (crates/engine-core/fuzz/).
 */
import {
  checkDecodeSst,
  checkLz4,
  checkManifest,
  checkRunRead,
  checkWalRow,
  fixManifestCrc,
  footerOf,
  repairSst,
  type Repair,
} from "../targets.js";

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

/** Byte 0: bits 0-1 pick the repair (none, CRC, trailer), bit 2 routes by the index's key range. */
function sstInput(data: Uint8Array): { buf: Uint8Array; withRange: boolean } | undefined {
  if (data.byteLength < 1) return undefined;
  const buf = data.slice(1);
  repairSst(buf, REPAIRS[data[0]! & 3]!);
  return { buf, withRange: (data[0]! & 4) !== 0 };
}

/** A tab's reads of one run: `SstReader` get, scans and filtered scan. */
export async function sstRead(data: Uint8Array): Promise<void> {
  const input = sstInput(data);
  if (!input) return;
  const keys = indexKeys(input.buf);
  const range = input.withRange && keys.length >= 2 ? { smallest: keys[0]!, largest: keys[keys.length - 1]! } : undefined;
  await checkRunRead(input.buf, { keys: [...keys, ...FIXED_KEYS], range, pattern: PATTERN });
}

/** The SharedWorker's full decode of a run, in TypeScript. */
export async function sstDecode(data: Uint8Array): Promise<void> {
  const input = sstInput(data);
  if (input) await checkDecodeSst(input.buf, false);
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

/** `lz4DecompressJs`: a framed block, u32 size then LZ4 bytes, as the run stores it. */
export async function lz4(data: Uint8Array): Promise<void> {
  if (data.byteLength < 4) return;
  const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  await checkLz4(data.slice(4), size);
}
