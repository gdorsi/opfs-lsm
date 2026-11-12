import type { AsyncFs } from "../opfs/async-fs.js";
import { CorruptDatabaseError } from "../errors.js";
import { crc32 } from "./crc32.js";
import { encodeRun } from "./engine.js";
import { levelOfDir, levelRunPath } from "./levels.js";
import { decodeMarks, encodeMarks, NO_MARKS, type Marks } from "./marks.js";
import type { RunEnd, SstEntry } from "./sst.js";

const GEN_PREFIX = "m/";
/** Magic ASCII "OLGN". */
const GEN_MAGIC = 0x4f4c474e;
/** Version 4 records the mark table and each run's `marksThrough`. */
const GEN_VERSION = 4;

/**
 * A run of the generation: what the encoder reported when it wrote the file
 * (`RunEnd`), and where the file is.
 */
export type RunMeta = RunEnd & {
  /** Relative to the db root: `l<n>/<name>.sst`. The directory is the level, see levels.ts. */
  readonly path: string;
  /**
   * Every range delete whose record is at or below this seq was applied
   * when the run was written: it holds no version one of them covers.
   */
  readonly marksThrough: number;
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
  /**
   * The runs hold every seq of the log up to this one and none past it: the
   * manifest is the fold of one log prefix (design.md, "Recovery").
   */
  readonly through: number;
  /**
   * The range deletes of seqs `1..through`, joined, less the pieces no run
   * listed can still hold a covered version for (`retireMarks`).
   */
  readonly marks: Marks;
};

/** The empty database: no runs, no seqs, no marks. */
export const GENERATION_ZERO: GenerationMeta = { generation: 0, runs: [], tombstoneSeq: 0, through: 0, marks: NO_MARKS };

function genPath(generation: number): string {
  return `${GEN_PREFIX}${String(generation).padStart(16, "0")}.mft`;
}

export function encodeGeneration(meta: GenerationMeta): Uint8Array {
  const enc = new TextEncoder();
  const paths = meta.runs.map((r) => enc.encode(r.path));
  const marks = encodeMarks(meta.marks);
  let size = 4 + 4 + 8 + 8 + 8 + marks.byteLength + 4;
  meta.runs.forEach((r, i) => {
    size += 2 + paths[i]!.byteLength + 4 + 1 + 8;
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
  view.setBigUint64(o, BigInt(meta.through), true);
  o += 8;
  out.set(marks, o);
  o += marks.byteLength;
  view.setUint32(o, paths.length, true);
  o += 4;
  meta.runs.forEach((r, i) => {
    const p = paths[i]!;
    view.setUint16(o, p.byteLength, true);
    o += 2;
    out.set(p, o);
    o += p.byteLength;
    view.setUint32(o, r.bytes, true);
    o += 4;
    out[o++] = r.range ? 1 : 0;
    for (const key of r.range ? [r.range.smallest, r.range.largest] : []) {
      view.setUint32(o, key.byteLength, true);
      o += 4;
      out.set(key, o);
      o += key.byteLength;
    }
    view.setBigUint64(o, BigInt(r.marksThrough), true);
    o += 8;
  });
  view.setUint32(o, crc32(out.subarray(0, o)), true);
  return out;
}

export function decodeGeneration(buf: Uint8Array): GenerationMeta {
  if (buf.byteLength < 64) {
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
  const tombstoneSeq = Number(view.getBigUint64(16, true));
  const through = Number(view.getBigUint64(24, true));
  const crcOff = buf.byteLength - 4;
  if (crc32(buf.subarray(0, crcOff)) !== view.getUint32(crcOff, true)) {
    throw new CorruptDatabaseError("generation crc mismatch");
  }
  const { marks, end } = decodeMarks(buf, 32, crcOff, through);
  let o = end;
  const dec = new TextDecoder();
  const runs: RunMeta[] = [];
  // Past the CRC only bytes written on purpose reach here; each read is
  // still checked, so they throw CorruptDatabaseError, not RangeError.
  const take = (n: number): number => {
    if (o + n > crcOff) throw new CorruptDatabaseError("generation truncated");
    o += n;
    return o - n;
  };
  const key = (): Uint8Array => {
    const len = view.getUint32(take(4), true);
    const at = take(len);
    return buf.slice(at, at + len);
  };
  const runCount = view.getUint32(take(4), true);
  for (let i = 0; i < runCount; i++) {
    const len = view.getUint16(take(2), true);
    const at = take(len);
    const path = dec.decode(buf.subarray(at, at + len));
    const bytes = view.getUint32(take(4), true);
    const range = buf[take(1)] === 1 ? { smallest: key(), largest: key() } : undefined;
    const marksThrough = Number(view.getBigUint64(take(8), true));
    if (marksThrough > through) throw new CorruptDatabaseError("generation run past through");
    runs.push(range ? { path, bytes, range, marksThrough } : { path, bytes, marksThrough });
  }
  if (o !== crcOff) throw new CorruptDatabaseError("generation trailing");
  return { generation, runs, tombstoneSeq, through, marks };
}

/** The numbers of the manifest files in `m/`, newest first. */
export async function manifestNumbers(fs: AsyncFs): Promise<number[]> {
  const gens: number[] = [];
  for (const name of await fs.list("m")) {
    const n = Number(name.replace(/\.mft$/, ""));
    if (Number.isSafeInteger(n)) gens.push(n);
  }
  return gens.sort((a, b) => b - a);
}

/**
 * Manifest `generation`; "missing" when the file is gone or empty (created
 * and never closed), which a power loss can leave; "corrupt" when it is
 * there and does not decode, which a power loss cannot (OPFS publishes a
 * file whole).
 */
export async function probeManifest(
  fs: AsyncFs,
  generation: number,
): Promise<GenerationMeta | "missing" | "corrupt"> {
  if (generation === 0) return GENERATION_ZERO;
  const buf = await fs.read(genPath(generation), 0, Number.POSITIVE_INFINITY);
  if (!buf || buf.byteLength === 0) return "missing";
  try {
    return decodeGeneration(buf);
  } catch (err) {
    if (err instanceof CorruptDatabaseError) return "corrupt";
    throw err;
  }
}

/** Manifest `generation`, or undefined when it is missing, empty or does not decode. */
export async function readManifest(
  fs: AsyncFs,
  generation: number,
): Promise<GenerationMeta | undefined> {
  const m = await probeManifest(fs, generation);
  return typeof m === "string" ? undefined : m;
}

/** True when every run `meta` lists is on disk and not empty. */
export async function isIntact(fs: AsyncFs, meta: GenerationMeta): Promise<boolean> {
  for (const run of meta.runs) {
    const head = await fs.read(run.path, 0, 1);
    if (!head || head.byteLength === 0) return false;
  }
  return true;
}

export async function loadLatestGeneration(
  fs: AsyncFs,
): Promise<GenerationMeta | undefined> {
  for (const generation of await manifestNumbers(fs)) {
    const meta = await readManifest(fs, generation);
    if (meta) return meta;
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

/** Write a non-empty L0 run that applied the range deletes through `marksThrough`. */
export async function publishL0(
  fs: AsyncFs,
  name: string,
  entries: readonly SstEntry[],
  marksThrough: number,
): Promise<RunMeta> {
  const path = levelRunPath(0, name);
  const { body, end } = await encodeRun(entries);
  const w = await fs.create(path);
  await w.write(body);
  await w.finish();
  return { path, ...end, marksThrough };
}

/** The manifest of `generation`, or undefined when a newer publish removed it. */
export async function loadGeneration(
  fs: AsyncFs,
  generation: number,
): Promise<GenerationMeta | undefined> {
  if (generation === 0) return GENERATION_ZERO;
  const buf = await fs.read(genPath(generation), 0, Number.POSITIVE_INFINITY);
  if (!buf || buf.byteLength === 0) return undefined;
  return decodeGeneration(buf);
}

/**
 * Delete manifests older than `keepFrom`, and swap files (`<n>.mft.crswap`,
 * left by a write killed mid-flight) numbered up to `keepFrom`. Call after
 * IDB records `keepFrom`. A write in progress always numbers past the
 * recorded generation, so its swap file is above `keepFrom` and stays.
 */
export async function reclaimManifests(
  fs: AsyncFs,
  keepFrom: number,
): Promise<void> {
  for (const name of await fs.list("m")) {
    const m = /^(\d+)\.mft(\.crswap)?$/.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (m[2] ? n > keepFrom : n >= keepFrom) continue;
    try {
      await fs.remove(`${GEN_PREFIX}${name}`);
    } catch {
      // best-effort
    }
  }
}

/**
 * Remove each path in `drop` that `keep` does not retain and no tab holds
 * open. Returns the paths still there, for the host to retry. A missing file
 * counts as removed, so a rerun after a crash converges.
 */
export async function reclaimRuns(
  fs: AsyncFs,
  drop: Iterable<string>,
  keep: readonly string[],
): Promise<string[]> {
  const retained = new Set(keep);
  const held: string[] = [];
  for (const path of new Set(drop)) {
    if (retained.has(path)) continue;
    let removed = false;
    try {
      removed = await fs.removeUnlessOpen(path);
    } catch {
      // Retried on the next tick like a held file.
    }
    if (!removed) held.push(path);
  }
  return held;
}

/**
 * The runs of the recorded generation. A manifest past it is left by a
 * crash between publishing it and recording it: the next ingest or
 * compaction builds on the recorded one, and recovery adopts a manifest
 * only when all its runs are on disk, so its runs may go. A read that fails
 * throws, and a manifest that is gone throws too: nothing may be swept
 * against it.
 */
export async function liveRuns(fs: AsyncFs, recorded: number): Promise<string[]> {
  const meta = await loadGeneration(fs, recorded);
  if (!meta) throw new CorruptDatabaseError(`manifest ${recorded} is gone`);
  return meta.runs.map((run) => run.path);
}

/** Every run file on disk, from the `l<n>/` directories. */
export async function listRuns(fs: AsyncFs): Promise<string[]> {
  const out: string[] = [];
  for (const dir of await fs.list("")) {
    if (levelOfDir(dir) === undefined) continue;
    for (const name of await fs.list(dir)) out.push(`${dir}/${name}`);
  }
  return out;
}
