import type { ReadFs } from "../opfs/async-fs.js";
import { CorruptDatabaseError } from "../errors.js";
import { asGeneration, asSeq, GENERATION_NONE, SEQ_ZERO, type Generation, type Seq } from "../seq.js";
import { crc32 } from "./crc32.js";
import { decodeMarks, encodeMarks, NO_MARKS, type Marks } from "./marks.js";
import type { RunEnd } from "./sst.js";

/** Magic ASCII "OLGN". */
const GEN_MAGIC = 0x4f4c474e;
/** Version 6: a head that names the runs, then each run's block index. */
const GEN_VERSION = 6;

/**
 * A run of the generation: what the encoder reported when it wrote the file
 * (`RunEnd`), and where the file is.
 */
export type RunMeta = RunEnd & {
  /** Relative to the db root: `l<n>/<name>.sst`. */
  readonly path: string;
  /** The `n` of the path's `l<n>/` directory; a manifest whose path names none does not decode. */
  readonly level: number;
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

/** The manifest file of `generation`, relative to the db root. */
export function manifestPath(generation: Generation): string {
  return `m/${String(generation).padStart(16, "0")}.mft`;
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

/** A run as the manifest head names it: all of `RunMeta` but the block index. */
type RunHead = Omit<RunMeta, "index">;

/**
 * Decode a manifest file, or with `whole` false its head alone: its fields,
 * and `run` of each run's head and the span of the file that holds its index.
 */
function decode<R>(
  buf: Uint8Array,
  run: (head: RunHead, indexAt: number, indexEnd: number) => R,
  whole: boolean,
): Omit<GenerationMeta, "runs"> & { runs: R[] } {
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
  const runs: R[] = [];
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
    const level = /^l(\d+)\//.exec(path)?.[1];
    if (!level) throw new CorruptDatabaseError("generation run path names no level");
    const bytes = view.getUint32(take(4), true);
    const range = buf[take(1)] === 1 ? { smallest: span(), largest: span() } : undefined;
    const marksThrough = asSeq(Number(view.getBigUint64(take(8), true)));
    if (marksThrough > through) throw new CorruptDatabaseError("generation run past through");
    const head = { path, level: Number(level), bytes, marksThrough };
    runs.push(run(range ? { ...head, range } : head, indexAt, (indexAt += view.getUint32(take(4), true))));
  }
  if (o !== crcOff || (whole && indexAt !== buf.byteLength)) throw new CorruptDatabaseError("generation trailing");
  return { generation, runs, through, marks };
}

/** The manifest a whole manifest file holds. A run's index is not read here: `decodeIndex` checks it. */
export function decodeGeneration(buf: Uint8Array): GenerationMeta {
  // A copy: a reader keeps its run's index, and a view would keep this whole file with it.
  return decode(buf, (run, at, to): RunMeta => ({ ...run, index: buf.slice(at, to) }), true);
}

/** What a manifest head names: its generation, and its runs by path. */
type ManifestHead = {
  readonly generation: Generation;
  readonly runs: readonly string[];
};

/** The head of a manifest file, which may end with its head (`manifestHead`). */
export function decodeManifestHead(buf: Uint8Array): ManifestHead {
  return decode(buf, (run) => run.path, false);
}

/**
 * The run paths of `generation` from IndexedDB's copy of its manifest head.
 * Undefined when the copy is another generation's or does not decode: the
 * manifest file decides then.
 */
export function runsOfCopy(copy: Uint8Array | undefined, generation: Generation): readonly string[] | undefined {
  if (!(copy instanceof Uint8Array)) return undefined;
  try {
    const head = decodeManifestHead(copy);
    return head.generation === generation ? head.runs : undefined;
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
export async function readManifest(
  fs: ReadFs,
  generation: Generation,
): Promise<GenerationMeta | "missing" | "corrupt"> {
  try {
    return (await loadGeneration(fs, generation)) ?? "missing";
  } catch (err) {
    if (err instanceof CorruptDatabaseError) return "corrupt";
    throw err;
  }
}

/** The manifest of `generation`, or undefined when a newer publish removed it. One that does not decode throws. */
export async function loadGeneration(
  fs: ReadFs,
  generation: Generation,
): Promise<GenerationMeta | undefined> {
  if (generation === GENERATION_NONE) return GENERATION_ZERO;
  const buf = await fs.read(manifestPath(generation), 0, Number.POSITIVE_INFINITY);
  return buf?.byteLength ? decodeGeneration(buf) : undefined;
}

/** `loadGeneration` of a recorded generation, which nothing may remove: a manifest that is gone throws. */
export async function loadRecorded(fs: ReadFs, recorded: Generation): Promise<GenerationMeta> {
  const meta = await loadGeneration(fs, recorded);
  if (!meta) throw new CorruptDatabaseError(`manifest ${recorded} is gone`);
  return meta;
}

/** True when every run `meta` lists is on disk and not empty. */
export async function isIntact(fs: ReadFs, meta: GenerationMeta): Promise<boolean> {
  for (const run of meta.runs) {
    const head = await fs.read(run.path, 0, 1);
    if (!head?.byteLength) return false;
  }
  return true;
}
