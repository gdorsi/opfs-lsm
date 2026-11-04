import type { AsyncFs } from "../opfs/async-fs.js";
import { CorruptDatabaseError } from "../errors.js";
import { crc32 } from "./crc32.js";
import { encodeSst } from "./engine.js";
import { SstReader, type SstEntry } from "./sst.js";

const GEN_PREFIX = "m/";
const L0_PREFIX = "l0/";
const SST_PREFIX = "sst/";
/** Magic ASCII "OLGN". */
const GEN_MAGIC = 0x4f4c474e;
const GEN_VERSION = 1;

export type GenerationMeta = {
  readonly generation: number;
  /** Paths relative to db root, newest first. */
  readonly runs: readonly string[];
};

function genPath(generation: number): string {
  return `${GEN_PREFIX}${String(generation).padStart(16, "0")}.mft`;
}

export function encodeGeneration(meta: GenerationMeta): Uint8Array {
  const enc = new TextEncoder();
  const paths = meta.runs.map((p) => enc.encode(p));
  let size = 4 + 4 + 8 + 4;
  for (const p of paths) size += 2 + p.byteLength;
  size += 4;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint32(o, GEN_MAGIC, true);
  o += 4;
  view.setUint32(o, GEN_VERSION, true);
  o += 4;
  view.setBigUint64(o, BigInt(meta.generation), true);
  o += 8;
  view.setUint32(o, paths.length, true);
  o += 4;
  for (const p of paths) {
    view.setUint16(o, p.byteLength, true);
    o += 2;
    out.set(p, o);
    o += p.byteLength;
  }
  view.setUint32(o, crc32(out.subarray(0, o)), true);
  return out;
}

export function decodeGeneration(buf: Uint8Array): GenerationMeta {
  if (buf.byteLength < 24) {
    throw new CorruptDatabaseError("generation too short");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== GEN_MAGIC) {
    throw new CorruptDatabaseError("bad generation magic");
  }
  if (view.getUint32(4, true) !== GEN_VERSION) {
    throw new CorruptDatabaseError("bad generation version");
  }
  const generation = Number(view.getBigUint64(8, true));
  const runCount = view.getUint32(16, true);
  const crcOff = buf.byteLength - 4;
  if (crc32(buf.subarray(0, crcOff)) !== view.getUint32(crcOff, true)) {
    throw new CorruptDatabaseError("generation crc mismatch");
  }
  const dec = new TextDecoder();
  const runs: string[] = [];
  let o = 20;
  for (let i = 0; i < runCount; i++) {
    const len = view.getUint16(o, true);
    o += 2;
    runs.push(dec.decode(buf.subarray(o, o + len)));
    o += len;
  }
  if (o !== crcOff) throw new CorruptDatabaseError("generation trailing");
  return { generation, runs };
}

export async function loadLatestGeneration(
  fs: AsyncFs,
): Promise<GenerationMeta | undefined> {
  const names = await fs.list("m");
  const gens: number[] = [];
  for (const name of names) {
    const n = Number(name.replace(/\.mft$/, ""));
    if (Number.isFinite(n)) gens.push(n);
  }
  gens.sort((a, b) => b - a);
  for (const generation of gens) {
    const buf = await fs.read(genPath(generation), 0, 1 << 20);
    if (!buf || buf.byteLength === 0) continue;
    try {
      return decodeGeneration(buf);
    } catch (err) {
      if (err instanceof CorruptDatabaseError) continue;
      throw err;
    }
  }
  return undefined;
}

export async function publishGeneration(
  fs: AsyncFs,
  generation: number,
  runs: readonly string[],
): Promise<void> {
  const body = encodeGeneration({ generation, runs: [...runs] });
  const w = await fs.create(genPath(generation));
  await w.write(body);
  await w.finish();
}

export async function publishL0(
  fs: AsyncFs,
  name: string,
  entries: readonly SstEntry[],
): Promise<string> {
  const path = `${L0_PREFIX}${name}.sst`;
  const body = await encodeSst(entries);
  const w = await fs.create(path);
  await w.write(body);
  await w.finish();
  return path;
}

export async function publishSst(
  fs: AsyncFs,
  name: string,
  body: Uint8Array,
): Promise<string> {
  const path = `${SST_PREFIX}${name}.sst`;
  const w = await fs.create(path);
  await w.write(body);
  await w.finish();
  return path;
}

/** Newest-first SST readers. Bloom and block index stay on the reader. Blocks do not. */
export async function loadSstReaders(
  fs: AsyncFs,
  meta: GenerationMeta,
): Promise<SstReader[]> {
  const readers: SstReader[] = [];
  for (const path of meta.runs) {
    const buf = await fs.read(path, 0, 1 << 26);
    if (buf) readers.push(new SstReader(buf));
  }
  return readers;
}

/** Delete run files that are in `drop` and not retained by `keep`. */
export async function reclaimRuns(
  fs: AsyncFs,
  drop: readonly string[],
  keep: readonly string[],
): Promise<void> {
  const retained = new Set(keep);
  for (const path of drop) {
    if (retained.has(path)) continue;
    try {
      await fs.remove(path);
    } catch {
      // best-effort
    }
  }
}
