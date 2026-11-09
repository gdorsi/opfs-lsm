import type { AsyncFs } from "../opfs/async-fs.js";
import { CorruptDatabaseError } from "../errors.js";
import { crc32 } from "./crc32.js";
import { encodeSst } from "./engine.js";
import { sstKeyRange, type SstEntry } from "./sst.js";

const GEN_PREFIX = "m/";
const L0_PREFIX = "l0/";
/** Magic ASCII "OLGN". */
const GEN_MAGIC = 0x4f4c474e;
/**
 * Version 2 added `through`, version 3 `cut`. Older manifests read with the
 * missing fields 0.
 */
const GEN_VERSION = 3;

export type KeyRange = {
  readonly smallest: Uint8Array;
  readonly largest: Uint8Array;
};

export type RunMeta = {
  /** Relative to the db root. Names the level and byte size, see levels.ts. */
  readonly path: string;
  /** Undefined for an empty run, which has no keys. */
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
  /**
   * The runs hold every seq of the log up to this one and none past it: the
   * manifest is the fold of one log prefix (design.md, "Recovery").
   */
  readonly through: number;
  /**
   * The runs hold every log record stamped at or below `cut`, from every
   * tab's log, and `through` counts them: the stable order numbers the
   * records above the cut from `through + 1` on.
   */
  readonly cut: number;
};

/** The empty database: no runs, no seqs. */
export const GENERATION_ZERO: GenerationMeta = { generation: 0, runs: [], tombstoneSeq: 0, through: 0, cut: 0 };

function genPath(generation: number): string {
  return `${GEN_PREFIX}${String(generation).padStart(16, "0")}.mft`;
}

export function encodeGeneration(meta: GenerationMeta): Uint8Array {
  const enc = new TextEncoder();
  const paths = meta.runs.map((r) => enc.encode(r.path));
  let size = 4 + 4 + 8 + 8 + 8 + 8 + 4;
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
  view.setBigUint64(o, BigInt(meta.through), true);
  o += 8;
  view.setBigUint64(o, BigInt(meta.cut), true);
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
  if (buf.byteLength < 32) {
    throw new CorruptDatabaseError("generation too short");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== GEN_MAGIC) {
    throw new CorruptDatabaseError("bad generation magic");
  }
  const version = view.getUint32(4, true);
  if (version < 1 || version > GEN_VERSION) {
    throw new CorruptDatabaseError("bad generation version");
  }
  const generation = Number(view.getBigUint64(8, true));
  let o = 16;
  const tombstoneSeq = Number(view.getBigUint64(o, true));
  o += 8;
  let through = 0;
  if (version >= 2) {
    if (buf.byteLength < 40) throw new CorruptDatabaseError("generation too short");
    through = Number(view.getBigUint64(o, true));
    o += 8;
  }
  let cut = 0;
  if (version >= 3) {
    if (buf.byteLength < 48) throw new CorruptDatabaseError("generation too short");
    cut = Number(view.getBigUint64(o, true));
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
  for (let i = 0; i < runCount; i++) {
    const len = view.getUint16(take(2), true);
    const at = take(len);
    const path = dec.decode(buf.subarray(at, at + len));
    if (buf[take(1)] === 1) {
      const smallest = key();
      runs.push({ path, range: { smallest, largest: key() } });
    } else {
      runs.push({ path });
    }
  }
  if (o !== crcOff) throw new CorruptDatabaseError("generation trailing");
  return { generation, runs, tombstoneSeq, through, cut };
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
async function readManifest(
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

/** The manifest entry for a run file with these bytes. */
export function runMeta(path: string, body: Uint8Array): RunMeta {
  const range = sstKeyRange(body);
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
  if (generation === 0) return GENERATION_ZERO;
  const buf = await fs.read(genPath(generation), 0, Number.POSITIVE_INFINITY);
  if (!buf || buf.byteLength === 0) return undefined;
  return decodeGeneration(buf);
}

/** Delete manifests older than `keepFrom`. Call once manifest `keepFrom` is published. */
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
 * The runs of the committed generation. A manifest past it lists a run
 * that is gone (a power loss): recovery never picks it and nothing builds
 * on it, so its runs may go. A read that fails throws, and a manifest that
 * is gone throws too: nothing may be swept against it.
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
    if (!/^l\d+$/.test(dir)) continue;
    for (const name of await fs.list(dir)) out.push(`${dir}/${name}`);
  }
  return out;
}
