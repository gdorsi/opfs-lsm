import { compareBytes, keyToString } from "../../src/bytes.js";
import type { AsyncFs } from "../../src/opfs/async-fs.js";
import { crc32 } from "../../src/store/crc32.js";
import { engineUsingWasm } from "../../src/store/engine.js";
import {
  decodeGeneration,
  listRuns,
  type GenerationMeta,
  type RunMeta,
} from "../../src/store/generation.js";
import { codecForLevel, levelOf } from "../../src/store/levels.js";
import { decodeSst, readFooter, type SstEntry } from "../../src/store/sst.js";
import { show, type OracleEntry } from "./oracle.js";

/**
 * The analogue of SQLite's `PRAGMA integrity_check` for one database: walks
 * every tab's log under `w/`, the committed manifest (the newest intact
 * one), and every run it lists, and checks the on-disk rules of
 * docs/design.md and architecture/wal-opfs/04-per-tab-logs.md. It reads the
 * logs through its own decoder, so a bug in the engine's reader does not
 * hide a bug in its writer.
 *
 * Call it on a quiet database: no ingest or compaction in flight.
 */
export type DatabaseReport = {
  /** Every record in the order: the manifest's `through` plus the log records above its cut. */
  readonly head: number;
  /** The committed manifest's `through`. */
  readonly ingestedThrough: number;
  readonly generation: number | undefined;
  /** Runs of the committed manifest, in manifest order. */
  readonly runs: readonly string[];
  /** Run files no manifest at or after the committed one lists. Allowed (design.md, "Crash behavior"). */
  readonly orphans: readonly string[];
  /** Manifests older than the committed one. Reclaim is best-effort, so allowed. */
  readonly staleManifests: readonly number[];
  /** Empty manifest files newer than the committed one: a crash before the writer closed. Ignored. */
  readonly emptyManifests: readonly number[];
  /**
   * Chrome's `createWritable` swap files (`<name>.crswap`) in `m/`. A
   * browser killed mid-write leaves one, and Chrome never removes it. The
   * engine skips the name, so it is a leak, not a problem.
   */
  readonly swapFiles: readonly string[];
  /** Tabs whose log ends in bytes that are not a whole frame: a crash mid-write. Allowed. */
  readonly tornTails: readonly string[];
  /** Live entries of the runs plus the logs above the cut, newest wins, in key order. */
  readonly state: readonly OracleEntry[];
  /** Every broken rule. Empty for a healthy database. */
  readonly problems: readonly string[];
};

type WalOp = { key: Uint8Array; value: Uint8Array | undefined };

type LogRec = { stamp: number; tab: string; ops: WalOp[] };

export async function checkDatabase(fs: AsyncFs, _name?: string): Promise<DatabaseReport> {
  const problems: string[] = [];

  // --- Manifests: the newest one that decodes and whose runs are all there is committed.
  const manifests = new Map<number, GenerationMeta>();
  const emptyManifests: number[] = [];
  const swapFiles: string[] = [];
  for (const file of await fs.list("m")) {
    if (file.endsWith(".crswap")) {
      swapFiles.push(`m/${file}`);
      continue;
    }
    const n = Number(file.replace(/\.mft$/, ""));
    if (!/^\d{16}\.mft$/.test(file) || !Number.isSafeInteger(n)) {
      problems.push(`unexpected manifest file m/${file}`);
      continue;
    }
    const buf = await fs.read(`m/${file}`, 0, Number.POSITIVE_INFINITY);
    if (buf?.byteLength === 0) {
      emptyManifests.push(n);
      continue;
    }
    try {
      const decoded = decodeGeneration(buf ?? new Uint8Array(0));
      if (decoded.generation !== n) problems.push(`m/${file} holds generation ${decoded.generation}`);
      manifests.set(n, decoded);
    } catch (err) {
      problems.push(`m/${file}: ${(err as Error).message}`);
    }
  }
  const numbers = [...manifests.keys()].sort((a, b) => b - a);
  const committedNumber = numbers[0] ?? 0;
  const current: GenerationMeta =
    manifests.get(committedNumber) ?? { generation: 0, runs: [], tombstoneSeq: 0, through: 0, cut: 0 };
  const staleManifests = numbers.filter((n) => n < committedNumber).sort((a, b) => a - b);
  const generation = committedNumber;
  if (current.tombstoneSeq > current.through) {
    problems.push(`tombstoneSeq ${current.tombstoneSeq} past the manifest's through ${current.through}`);
  }

  // --- Logs: per tab, segments chain by name, frames are whole and CRC-checked,
  // n counts up with no gap and stamps rise. A torn tail is allowed only at the
  // very end of a tab's log.
  const above: LogRec[] = [];
  const tornTails: string[] = [];
  for (const tab of await fs.list("w")) {
    if (!/^[0-9a-f]{16}$/.test(tab)) {
      problems.push(`unexpected log entry w/${tab}`);
      continue;
    }
    const files = (await fs.list(`w/${tab}`)).sort();
    let lastN: number | undefined;
    let lastStamp = 0;
    files.forEach((f) => {
      if (!/^\d{10}\.\d{16}\.wal$/.test(f)) problems.push(`unexpected log file w/${tab}/${f}`);
    });
    const segs = files.filter((f) => /^\d{10}\.\d{16}\.wal$/.test(f));
    if (segs.length > 0) {
      const firstPrev = Number(segs[0]!.split(".")[1]);
      if (firstPrev > current.cut) {
        problems.push(`w/${tab}: records up to ${firstPrev} were reclaimed, past the committed cut ${current.cut}`);
      }
    }
    // A dead tab's reclaim leaves an empty tombstone last, and may be cut
    // short before it removes the segment before it: that one ends the log
    // as if it were the last (the tombstone's name must follow on from it).
    const lastSeg = segs[segs.length - 1];
    const tombstone =
      segs.length > 1 && ((await fs.read(`w/${tab}/${lastSeg}`, 0, Number.POSITIVE_INFINITY))?.byteLength ?? 0) === 0;
    for (const [i, f] of segs.entries()) {
      const [firstN, prevStamp] = f.split(".").map(Number) as [number, number];
      if (lastN !== undefined && firstN !== lastN + 1) problems.push(`w/${tab}/${f}: starts at n ${firstN} after ${lastN}`);
      if (i > 0 && prevStamp !== lastStamp) problems.push(`w/${tab}/${f}: names previous stamp ${prevStamp}, log has ${lastStamp}`);
      const bytes = (await fs.read(`w/${tab}/${f}`, 0, Number.POSITIVE_INFINITY)) ?? new Uint8Array(0);
      const frames = scanLog(bytes);
      const last = i === segs.length - 1 || (tombstone && i === segs.length - 2);
      if (frames.rest > 0 && !last) problems.push(`w/${tab}/${f}: ${frames.rest} bytes past the last frame in a segment that is not the last`);
      if (frames.rest > 0) tornTails.push(`w/${tab}/${f}`);
      if (!frames.sealed && !last) problems.push(`w/${tab}/${f}: not sealed, but a later segment exists`);
      if (frames.records[0] && frames.records[0].n !== firstN) problems.push(`w/${tab}/${f}: first record n ${frames.records[0].n}, name says ${firstN}`);
      for (const r of frames.records) {
        if (lastN !== undefined && r.n !== lastN + 1) problems.push(`w/${tab}/${f}: n ${r.n} after ${lastN}`);
        if (r.stamp <= lastStamp) problems.push(`w/${tab}/${f}: stamp ${r.stamp} not above ${lastStamp}`);
        lastN = r.n;
        lastStamp = r.stamp;
        if (r.stamp > current.cut) above.push({ stamp: r.stamp, tab, ops: r.ops });
      }
      for (const e of frames.errors) problems.push(`w/${tab}/${f}: ${e}`);
    }
  }
  above.sort((a, b) => a.stamp - b.stamp || (a.tab < b.tab ? -1 : a.tab > b.tab ? 1 : 0));
  const head = current.through + above.length;
  const ingestedThrough = current.through;

  // --- Runs of the committed manifest.
  const runs = current.runs;
  const decoded: (SstEntry[] | undefined)[] = [];
  for (const run of runs) decoded.push(await checkRun(fs, run, generation, current.through, problems));
  checkOrder(runs, decoded, problems);

  // --- Orphans: run files that no manifest from the committed one on lists.
  const live = new Set<string>();
  for (const [n, m] of manifests) if (n >= committedNumber) for (const r of m.runs) live.add(r.path);
  const orphans = (await listRuns(fs)).filter((p) => !live.has(p)).sort();

  // --- The state a reader should see: runs oldest first, then the logs above the cut, in order.
  const state = new Map<string, { key: Uint8Array; value: Uint8Array | undefined }>();
  for (let i = decoded.length - 1; i >= 0; i--) {
    for (const e of decoded[i] ?? []) {
      state.set(keyToString(e.key), { key: e.key, value: e.kind === "put" ? e.value : undefined });
    }
  }
  for (const { ops } of above) {
    for (const op of ops) state.set(keyToString(op.key), { key: op.key, value: op.value });
  }
  const live_: OracleEntry[] = [];
  for (const { key, value } of state.values()) if (value !== undefined) live_.push({ key, value });
  live_.sort((a, b) => compareBytes(a.key, b.key));

  return {
    head,
    ingestedThrough,
    generation,
    runs: runs.map((r) => r.path),
    orphans,
    staleManifests,
    emptyManifests: emptyManifests.sort((a, b) => a - b),
    swapFiles: swapFiles.sort(),
    tornTails,
    state: live_,
    problems,
  };
}

/**
 * The log frame format of src/log/frame.ts, decoded here on its own:
 * u32 bodyLen | u32 crc(kind, stamp, n, body) | u8 kind | u64 stamp | u32 n | body.
 * Kind 1 is a record, 2 a SEAL that ends the segment.
 */
function scanLog(bytes: Uint8Array): {
  records: { stamp: number; n: number; ops: WalOp[] }[];
  sealed: boolean;
  rest: number;
  errors: string[];
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: { stamp: number; n: number; ops: WalOp[] }[] = [];
  const errors: string[] = [];
  let at = 0;
  while (at + 21 <= bytes.byteLength) {
    const len = view.getUint32(at, true);
    const end = at + 21 + len;
    if (end > bytes.byteLength) break;
    if (crc32(bytes.subarray(at + 8, end)) !== view.getUint32(at + 4, true)) break;
    const kind = bytes[at + 8];
    const stamp = Number(view.getBigUint64(at + 9, true));
    const n = view.getUint32(at + 17, true);
    if (kind === 2) {
      if (end !== bytes.byteLength) errors.push(`${bytes.byteLength - end} bytes after SEAL`);
      return { records, sealed: true, rest: 0, errors };
    }
    if (kind !== 1) {
      errors.push(`frame kind ${kind}`);
      break;
    }
    try {
      records.push({ stamp, n, ops: decodeLogOps(bytes.slice(at + 21, end).buffer) });
    } catch (err) {
      errors.push(`record n ${n}: ${(err as Error).message}`);
    }
    at = end;
  }
  return { records, sealed: false, rest: bytes.byteLength - at, errors };
}

const L0_NAME = /^l0\/(\d+)-(\d+)\.sst$/;
const LEVEL_NAME = /^l(\d+)\/c(\d+)\.(\d+)-(\d+)\.sst$/;

/** One run: it exists, decodes with a good CRC, is sorted, and matches its name and manifest entry. */
async function checkRun(
  fs: AsyncFs,
  run: RunMeta,
  generation: number,
  through: number,
  problems: string[],
): Promise<SstEntry[] | undefined> {
  const { path } = run;
  const bad = (msg: string) => problems.push(`${path}: ${msg}`);
  const buf = await fs.read(path, 0, Number.POSITIVE_INFINITY);
  if (!buf) {
    bad("missing");
    return undefined;
  }
  let entries: SstEntry[];
  let codec: string;
  try {
    entries = decodeSst(buf);
    codec = readFooter(buf, buf.byteLength).codec;
  } catch (err) {
    bad((err as Error).message);
    return undefined;
  }
  for (let i = 1; i < entries.length; i++) {
    if (compareBytes(entries[i - 1]!.key, entries[i]!.key) >= 0) {
      bad(`keys not strictly increasing at entry ${i} (${show(entries[i]!.key)})`);
      break;
    }
  }
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (!first || !last) {
    if (run.range) bad("manifest gives a range for an empty run");
    else bad("empty run listed");
  } else if (
    !run.range ||
    compareBytes(run.range.smallest, first.key) !== 0 ||
    compareBytes(run.range.largest, last.key) !== 0
  ) {
    bad(`manifest range does not match keys ${show(first.key)}..${show(last.key)}`);
  }
  for (const e of entries) {
    const seq = e.seq ?? 0;
    if (seq < 1 || seq > through) {
      bad(`${show(e.key)} has seq ${seq}, past the manifest's through ${through}`);
      break;
    }
  }

  const level = levelOf(path);
  if (level === 0) {
    const m = L0_NAME.exec(path);
    if (!m) {
      bad("L0 name is not <first>-<last>.sst");
    } else {
      const [lo, hi] = [Number(m[1]), Number(m[2])];
      if (lo > hi) bad("L0 name has first > last");
      const out = entries.find((e) => (e.seq ?? 0) < lo || (e.seq ?? 0) > hi);
      if (out) bad(`${show(out.key)} has seq ${out.seq} outside the name's ${lo}-${hi}`);
    }
    if (codec !== "raw") bad(`L0 codec ${codec}`);
  } else if (level !== undefined) {
    const m = LEVEL_NAME.exec(path);
    if (!m) {
      bad("level name is not c<gen>.<i>-<bytes>.sst");
    } else {
      if (Number(m[4]) !== buf.byteLength) bad(`name says ${m[4]} bytes, file has ${buf.byteLength}`);
      if (Number(m[2]) > generation) bad(`written by generation ${m[2]}, after recorded ${generation}`);
    }
    const want = engineUsingWasm() ? codecForLevel(level) : "raw";
    if (codec !== want) bad(`codec ${codec}, level ${level} uses ${want}`);
  } else {
    bad("path names no level");
  }
  return entries;
}

/**
 * Manifest order (design.md, "Manifest format"): L0 newest first, then each
 * level by smallest key with no overlap. Reads take the first hit, so every
 * key's seqs must fall along that order.
 */
function checkOrder(
  runs: readonly RunMeta[],
  decoded: readonly (SstEntry[] | undefined)[],
  problems: string[],
): void {
  let prevLevel = 0;
  let prevL0: { path: string; lo: number; hi: number } | undefined;
  let prevInLevel: RunMeta | undefined;
  const seen = new Set<string>();
  for (const run of runs) {
    const level = levelOf(run.path) ?? Number.POSITIVE_INFINITY;
    if (level < prevLevel) problems.push(`${run.path} listed after a deeper level`);
    if (level !== prevLevel) prevInLevel = undefined;
    prevLevel = level;
    if (seen.has(run.path)) problems.push(`${run.path} listed twice`);
    seen.add(run.path);
    if (level === 0) {
      const m = L0_NAME.exec(run.path);
      if (!m) continue;
      const cur = { path: run.path, lo: Number(m[1]), hi: Number(m[2]) };
      if (prevL0 && !(prevL0.lo > cur.hi)) {
        problems.push(`L0 ${cur.path} is not newest first after ${prevL0.path}`);
      }
      prevL0 = cur;
    } else if (prevInLevel) {
      const a = prevInLevel.range;
      const b = run.range;
      if (!a || !b || compareBytes(a.largest, b.smallest) >= 0) {
        problems.push(`L${level} runs overlap or are out of order: ${prevInLevel.path}, ${run.path}`);
      }
    }
    if (level !== 0) prevInLevel = run;
  }

  // Each key: seqs must not rise along manifest order, or an older entry shadows a newer one.
  const newest = new Map<string, { seq: number; path: string }>();
  runs.forEach((run, i) => {
    for (const e of decoded[i] ?? []) {
      const id = keyToString(e.key);
      const seq = e.seq ?? 0;
      const prior = newest.get(id);
      if (prior && seq > prior.seq) {
        problems.push(`${show(e.key)}: seq ${seq} in ${run.path} under a newer seq ${prior.seq} from ${prior.path}`);
      }
      if (!prior || seq < prior.seq) newest.set(id, { seq, path: run.path });
    }
  });
}

/** A log record's body (src/log/frame.ts `encodeOps`): per op, u8 type | u32 keyLen | key | put: u32 valueLen | value. */
function decodeLogOps(raw: unknown): WalOp[] {
  if (!(raw instanceof ArrayBuffer)) throw new Error("not an ArrayBuffer");
  const bytes = new Uint8Array(raw);
  const view = new DataView(raw);
  const ops: WalOp[] = [];
  let at = 0;
  const take = (n: number) => {
    if (at + n > bytes.byteLength) throw new Error("truncated");
    const out = bytes.slice(at, at + n);
    at += n;
    return out;
  };
  const u32 = () => {
    if (at + 4 > bytes.byteLength) throw new Error("truncated");
    const n = view.getUint32(at, true);
    at += 4;
    return n;
  };
  while (at < bytes.byteLength) {
    const type = bytes[at++];
    const key = take(u32());
    if (type === 0) ops.push({ key, value: take(u32()) });
    else if (type === 1) ops.push({ key, value: undefined });
    else throw new Error(`op type ${type}`);
  }
  return ops;
}
