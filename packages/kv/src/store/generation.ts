import type { AsyncFs } from "../opfs/async-fs.js";
import { CorruptDatabaseError } from "../errors.js";
import { crc32 } from "./crc32.js";
import { encodeSst } from "./engine.js";
import { SstReader, type SstEntry } from "./sst.js";

const GEN_PREFIX = "m/";
const L0_PREFIX = "l0/";
/** Magic ASCII "OLGN". */
const GEN_MAGIC = 0x4f4c474e;
const GEN_VERSION_V1 = 1;
/** v1 plus a u64 tombstoneSeq after the generation. */
const GEN_VERSION_V2 = 2;
/** v2 plus each run's key range. */
const GEN_VERSION = 3;

export type KeyRange = {
  readonly smallest: Uint8Array;
  readonly largest: Uint8Array;
};

export type RunMeta = {
  /** Relative to the db root. Names the level and byte size, see levels.ts. */
  readonly path: string;
  /** Undefined for a run listed before manifests recorded ranges. */
  readonly range?: KeyRange;
};

export type GenerationMeta = {
  readonly generation: number;
  /** L0 newest first, then each level's runs in key order. */
  readonly runs: readonly RunMeta[];
  /**
   * The highest seq of any tombstone a bottom compaction dropped. A key with
   * no entry may have been deleted at any seq up to this one.
   */
  readonly tombstoneSeq: number;
};

function genPath(generation: number): string {
  return `${GEN_PREFIX}${String(generation).padStart(16, "0")}.mft`;
}

export function encodeGeneration(meta: GenerationMeta): Uint8Array {
  const enc = new TextEncoder();
  const paths = meta.runs.map((r) => enc.encode(r.path));
  let size = 4 + 4 + 8 + 8 + 4;
  meta.runs.forEach((r, i) => {
    size += 2 + paths[i]!.byteLength + 1;
    if (r.range) size += 8 + r.range.smallest.byteLength + r.range.largest.byteLength;
  });
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
  view.setBigUint64(o, BigInt(meta.tombstoneSeq), true);
  o += 8;
  view.setUint32(o, paths.length, true);
  o += 4;
  meta.runs.forEach((r, i) => {
    const p = paths[i]!;
    view.setUint16(o, p.byteLength, true);
    o += 2;
    out.set(p, o);
    o += p.byteLength;
    out[o++] = r.range ? 1 : 0;
    if (!r.range) return;
    for (const key of [r.range.smallest, r.range.largest]) {
      view.setUint32(o, key.byteLength, true);
      o += 4;
      out.set(key, o);
      o += key.byteLength;
    }
  });
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
  const version = view.getUint32(4, true);
  if (version !== GEN_VERSION_V1 && version !== GEN_VERSION_V2 && version !== GEN_VERSION) {
    throw new CorruptDatabaseError("bad generation version");
  }
  const generation = Number(view.getBigUint64(8, true));
  let o = 16;
  let tombstoneSeq = 0;
  if (version >= GEN_VERSION_V2) {
    tombstoneSeq = Number(view.getBigUint64(o, true));
    o += 8;
  }
  const runCount = view.getUint32(o, true);
  o += 4;
  const crcOff = buf.byteLength - 4;
  if (crc32(buf.subarray(0, crcOff)) !== view.getUint32(crcOff, true)) {
    throw new CorruptDatabaseError("generation crc mismatch");
  }
  const dec = new TextDecoder();
  const runs: RunMeta[] = [];
  const key = (): Uint8Array => {
    const len = view.getUint32(o, true);
    o += 4;
    const out = buf.slice(o, o + len);
    o += len;
    return out;
  };
  for (let i = 0; i < runCount; i++) {
    const len = view.getUint16(o, true);
    o += 2;
    const path = dec.decode(buf.subarray(o, o + len));
    o += len;
    if (version >= GEN_VERSION && buf[o++] === 1) {
      const smallest = key();
      runs.push({ path, range: { smallest, largest: key() } });
    } else {
      runs.push({ path });
    }
  }
  if (o !== crcOff) throw new CorruptDatabaseError("generation trailing");
  return { generation, runs, tombstoneSeq };
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
    const buf = await fs.read(genPath(generation), 0, Number.POSITIVE_INFINITY);
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
  meta: GenerationMeta,
): Promise<void> {
  const body = encodeGeneration(meta);
  const w = await fs.create(genPath(meta.generation));
  await w.write(body);
  await w.finish();
}

/** The manifest entry for a run file with these bytes. */
export function runMeta(path: string, body: Uint8Array): RunMeta {
  const range = new SstReader(body).range;
  return range ? { path, range } : { path };
}

/** Write a non-empty L0 run. */
export async function publishL0(
  fs: AsyncFs,
  name: string,
  entries: readonly SstEntry[],
): Promise<RunMeta> {
  const path = `${L0_PREFIX}${name}.sst`;
  const body = await encodeSst(entries);
  const w = await fs.create(path);
  await w.write(body);
  await w.finish();
  return runMeta(path, body);
}

export async function publishRun(
  fs: AsyncFs,
  path: string,
  body: Uint8Array,
): Promise<string> {
  const w = await fs.create(path);
  await w.write(body);
  await w.finish();
  return path;
}

/** The manifest of `generation`, or undefined when a newer publish removed it. */
export async function loadGeneration(
  fs: AsyncFs,
  generation: number,
): Promise<GenerationMeta | undefined> {
  if (generation === 0) return { generation, runs: [], tombstoneSeq: 0 };
  const buf = await fs.read(genPath(generation), 0, Number.POSITIVE_INFINITY);
  if (!buf || buf.byteLength === 0) return undefined;
  return decodeGeneration(buf);
}

/** Undefined when the run file is gone. Run files never change once written. */
export async function loadSstReader(
  fs: AsyncFs,
  path: string,
): Promise<SstReader | undefined> {
  const buf = await fs.read(path, 0, Number.POSITIVE_INFINITY);
  return buf ? new SstReader(buf) : undefined;
}

/** Delete manifests older than `keepFrom`. Call after IDB records `keepFrom`. */
export async function reclaimManifests(
  fs: AsyncFs,
  keepFrom: number,
): Promise<void> {
  for (const name of await fs.list("m")) {
    const n = Number(name.replace(/\.mft$/, ""));
    if (!Number.isFinite(n) || n >= keepFrom) continue;
    try {
      await fs.remove(genPath(n));
    } catch {
      // best-effort
    }
  }
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
