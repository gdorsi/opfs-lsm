import type { AsyncFs, ReadFs } from "../opfs/async-fs.js";
import { CorruptDatabaseError } from "../errors.js";
import { asGeneration, asSeq, GENERATION_NONE, SEQ_ZERO, type Generation, type Seq } from "../seq.js";
import { crc32 } from "./crc32.js";
import { encodeRun } from "./engine.js";
import { levelOfDir, levelRunPath } from "./levels.js";
import { decodeMarks, encodeMarks, NO_MARKS, type Marks } from "./marks.js";
import type { RunEnd, SstEntry } from "./sst.js";

const GEN_PREFIX = "m/";
/** Magic ASCII "OLGN". */
const GEN_MAGIC = 0x4f4c474e;
/** Version 6: a head that names the runs, then each run's block index. */
const GEN_VERSION = 6;

/**
 * A run of the generation: what the encoder reported when it wrote the file
 * (`RunEnd`), and where the file is.
 */
export type RunMeta = RunEnd & {
  /** Relative to the db root: `l<n>/<name>.sst`. The directory is the level, see levels.ts. */
  readonly path: string;
  /**
   * Every range delete whose record is at or below this seq was applied
   * when the run was written: it holds no version one of them covers. It
   * holds no version past this seq either.
   */
  readonly marksThrough: Seq;
};

export type GenerationMeta = {
  readonly generation: Generation;
  /** L0 newest first, then each level's runs in key order. */
  readonly runs: readonly RunMeta[];
  /**
   * The runs hold every seq of the log up to this one and none past it: the
   * manifest is the fold of one log prefix (design.md, "Recovery").
   */
  readonly through: Seq;
  /**
   * The range deletes of seqs `1..through`, joined, less the marks no run
   * listed can still hold a covered version for (`retireMarks`).
   */
  readonly marks: Marks;
};

/** The empty database: no runs, no seqs, no marks. */
export const GENERATION_ZERO: GenerationMeta = { generation: GENERATION_NONE, runs: [], through: SEQ_ZERO, marks: NO_MARKS };

function genPath(generation: Generation): string {
  return `${GEN_PREFIX}${String(generation).padStart(16, "0")}.mft`;
}

/** Where a manifest's head says how many bytes it is. */
const HEAD_BYTES_AT = 24;

/** The manifest file of `meta`: its head, then each run's block index, in run order. */
export function encodeGeneration(meta: GenerationMeta): Uint8Array {
  const enc = new TextEncoder();
  const paths = meta.runs.map((r) => enc.encode(r.path));
  const marks = encodeMarks(meta.marks);
  let head = 4 + 4 + 8 + 8 + 4 + marks.byteLength + 4 + 4;
  let indexes = 0;
  meta.runs.forEach((r, i) => {
    head += 2 + paths[i]!.byteLength + 4 + 1 + 8 + 4;
    if (r.range) head += 8 + r.range.smallest.byteLength + r.range.largest.byteLength;
    indexes += r.index.byteLength;
  });
  const out = new Uint8Array(head + indexes);
  const view = new DataView(out.buffer);
  let at = head;
  let o = 0;
  view.setUint32(o, GEN_MAGIC, true);
  o += 4;
  view.setUint32(o, GEN_VERSION, true);
  o += 4;
  view.setBigUint64(o, BigInt(meta.generation), true);
  o += 8;
  view.setBigUint64(o, BigInt(meta.through), true);
  o += 8;
  view.setUint32(o, head, true);
  o += 4;
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
    view.setUint32(o, r.index.byteLength, true);
    o += 4;
    out.set(r.index, at);
    at += r.index.byteLength;
  });
  view.setUint32(o, crc32(out.subarray(0, o)), true);
  return out;
}

/**
 * The head of a manifest file, copied: the bytes IndexedDB keeps. It names
 * the runs and leaves out their block indexes, so its size follows the count
 * of runs, not of blocks.
 */
export function manifestHead(file: Uint8Array): Uint8Array {
  return file.slice(0, new DataView(file.buffer, file.byteOffset).getUint32(HEAD_BYTES_AT, true));
}

/**
 * The manifest a whole manifest file holds. A run's index is not read here:
 * `decodeIndex` checks it. With `head`, `buf` may end with its head, and then
 * its runs have no index.
 */
export function decodeGeneration(buf: Uint8Array, head = false): GenerationMeta {
  if (buf.byteLength < 40) {
    throw new CorruptDatabaseError("generation too short");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== GEN_MAGIC) {
    throw new CorruptDatabaseError("bad generation magic");
  }
  if (view.getUint32(4, true) !== GEN_VERSION) {
    throw new CorruptDatabaseError("bad generation version");
  }
  const generation = asGeneration(Number(view.getBigUint64(8, true)));
  const through = asSeq(Number(view.getBigUint64(16, true)));
  let indexAt = view.getUint32(HEAD_BYTES_AT, true);
  if (indexAt < 40 || indexAt > buf.byteLength) throw new CorruptDatabaseError("generation truncated");
  const crcOff = indexAt - 4;
  if (crc32(buf.subarray(0, crcOff)) !== view.getUint32(crcOff, true)) {
    throw new CorruptDatabaseError("generation crc mismatch");
  }
  const { marks, end } = decodeMarks(buf, HEAD_BYTES_AT + 4, crcOff, through);
  let o = end;
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  const runs: RunMeta[] = [];
  // Past the CRC only bytes written on purpose reach here; each read is
  // still checked, so they throw CorruptDatabaseError, not RangeError.
  const take = (n: number): number => {
    if (o + n > crcOff) throw new CorruptDatabaseError("generation truncated");
    o += n;
    return o - n;
  };
  /** A `u32` length and that many bytes, copied. */
  const span = (): Uint8Array => {
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
    const range = buf[take(1)] === 1 ? { smallest: span(), largest: span() } : undefined;
    const marksThrough = asSeq(Number(view.getBigUint64(take(8), true)));
    if (marksThrough > through) throw new CorruptDatabaseError("generation run past through");
    // A copy: a reader keeps its run's index, and a view would keep this whole file with it.
    const index = buf.slice(indexAt, (indexAt += view.getUint32(take(4), true)));
    const run = { path, bytes, marksThrough, index };
    runs.push(range ? { ...run, range } : run);
  }
  if (o !== crcOff || (!head && indexAt !== buf.byteLength)) throw new CorruptDatabaseError("generation trailing");
  return { generation, runs, through, marks };
}

/**
 * The run paths of `generation` from IndexedDB's copy of its manifest head.
 * Undefined when the copy is another generation's or does not decode: the
 * manifest file decides then.
 */
export function runsOfCopy(copy: Uint8Array | undefined, generation: Generation): string[] | undefined {
  if (!(copy instanceof Uint8Array)) return undefined;
  try {
    const meta = decodeGeneration(copy, true);
    return meta.generation === generation ? meta.runs.map((r) => r.path) : undefined;
  } catch (err) {
    if (err instanceof CorruptDatabaseError) return undefined;
    throw err;
  }
}

/** The numbers of the manifest files in `m/`, newest first. */
export async function manifestNumbers(fs: ReadFs): Promise<Generation[]> {
  const gens: Generation[] = [];
  for (const name of await fs.list("m")) {
    const n = Number(name.replace(/\.mft$/, ""));
    if (Number.isSafeInteger(n)) gens.push(asGeneration(n));
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
  fs: ReadFs,
  generation: Generation,
): Promise<GenerationMeta | "missing" | "corrupt"> {
  if (generation === GENERATION_NONE) return GENERATION_ZERO;
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
  fs: ReadFs,
  generation: Generation,
): Promise<GenerationMeta | undefined> {
  const m = await probeManifest(fs, generation);
  return typeof m === "string" ? undefined : m;
}

/** True when every run `meta` lists is on disk and not empty. */
export async function isIntact(fs: ReadFs, meta: GenerationMeta): Promise<boolean> {
  for (const run of meta.runs) {
    const head = await fs.read(run.path, 0, 1);
    if (!head || head.byteLength === 0) return false;
  }
  return true;
}

/** Write the manifest of `meta`, and return its head for the transaction that records it. */
export async function publishGeneration(
  fs: AsyncFs,
  meta: GenerationMeta,
): Promise<Uint8Array> {
  const body = encodeGeneration(meta);
  const w = await fs.create(genPath(meta.generation));
  await w.write(body);
  await w.finish();
  return manifestHead(body);
}

/** Write a non-empty L0 run that applied the range deletes through `marksThrough`. */
export async function publishL0(
  fs: AsyncFs,
  name: string,
  entries: readonly SstEntry[],
  marksThrough: Seq,
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
  fs: ReadFs,
  generation: Generation,
): Promise<GenerationMeta | undefined> {
  if (generation === GENERATION_NONE) return GENERATION_ZERO;
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
  keepFrom: Generation,
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
 * open. A file that stays, held or failing, goes at a later call.
 */
export async function reclaimRuns(
  fs: AsyncFs,
  drop: readonly string[],
  keep: readonly string[],
): Promise<void> {
  const retained = new Set(keep);
  for (const path of drop) {
    if (retained.has(path)) continue;
    await fs.removeUnlessOpen(path).catch(() => undefined);
  }
}

/** `loadGeneration` of a recorded generation, which nothing may remove: a manifest that is gone throws. */
export async function loadRecorded(fs: ReadFs, recorded: Generation): Promise<GenerationMeta> {
  const meta = await loadGeneration(fs, recorded);
  if (!meta) throw new CorruptDatabaseError(`manifest ${recorded} is gone`);
  return meta;
}

/**
 * The runs of the recorded generation. A manifest past it is left by a
 * crash between publishing it and recording it: the next ingest or
 * compaction builds on the recorded one, and recovery adopts a manifest
 * only when all its runs are on disk, so its runs may go. A read that fails
 * throws, and a manifest that is gone throws too: nothing may be swept
 * against it.
 */
export async function liveRuns(fs: ReadFs, recorded: Generation): Promise<string[]> {
  return (await loadRecorded(fs, recorded)).runs.map((run) => run.path);
}

/** Every run file on disk, from the `l<n>/` directories. */
export async function listRuns(fs: ReadFs): Promise<string[]> {
  const out: string[] = [];
  for (const dir of await fs.list("")) {
    if (levelOfDir(dir) === undefined) continue;
    for (const name of await fs.list(dir)) out.push(`${dir}/${name}`);
  }
  return out;
}
