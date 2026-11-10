import { compareBytes, keyToString } from "../../src/bytes.js";
import type { AsyncFs } from "../../src/opfs/async-fs.js";
import { engineUsingWasm } from "../../src/store/engine.js";
import { RECLAIM_LAG } from "../../src/host/queues.js";
import { scanLog, type ListedSegment } from "../../src/log/queue-scan.js";
import { segmentPath } from "../../src/log/segment.js";
import { decodeGeneration, listLogs, listRuns, type GenerationMeta, type RunMeta } from "../../src/store/generation.js";
import { codecForLevel, levelOf } from "../../src/store/levels.js";
import { decodeSst, readFooter, type SstEntry } from "../../src/store/sst.js";
import { show, type OracleEntry } from "./oracle.js";

/**
 * The analogue of SQLite's `PRAGMA integrity_check` for one database: walks
 * the manifests in `m/`, every run the newest one lists, and the per-tab
 * logs in `w/`, and checks the on-disk rules of docs/design.md. Runs are
 * read through `decodeSst` and the manifest decoder, not through a tab's
 * reader, so a bug in the engine's reader does not hide a bug in its writer.
 *
 * Call it on a quiet database: no ingest or compaction in flight.
 */
export type DatabaseReport = {
  /** The newest manifest that decodes. 0 when there is none. */
  readonly generation: number;
  /** Its `through`: the runs hold ingest seqs 1..through. */
  readonly through: number;
  /** Runs of the newest manifest, in manifest order. */
  readonly runs: readonly string[];
  /** Run files no manifest lists. Allowed (design.md, "Crash behavior"). */
  readonly orphans: readonly string[];
  /** Decodable manifests older than the newest RECLAIM_LAG + 1 decodable ones. Reclaim is best-effort, so allowed. */
  readonly staleManifests: readonly number[];
  /** Empty manifest files: a crash before the writer closed. Ignored. */
  readonly emptyManifests: readonly number[];
  /**
   * Chrome's `createWritable` swap files (`<name>.crswap`) in `m/`. A
   * browser killed mid-write leaves one, and Chrome never removes it. The
   * engine skips the name, so it is a leak, not a problem.
   */
  readonly swapFiles: readonly string[];
  /** Log directories in `w/`. */
  readonly logs: readonly string[];
  /** Whole records in the logs past the newest manifest's cursors: written, not ingested yet. */
  readonly pending: number;
  /** Live entries of the newest manifest's runs, newest wins, in key order. */
  readonly state: readonly OracleEntry[];
  /** Every broken rule. Empty for a healthy database. */
  readonly problems: readonly string[];
};

export async function checkDatabase(fs: AsyncFs): Promise<DatabaseReport> {
  const problems: string[] = [];

  // --- Manifests.
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
    // A crash between creating a manifest and closing its writer leaves an
    // empty file (OPFS creates the entry first). The engine skips it.
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
  const generation = Math.max(0, ...manifests.keys());
  const current: GenerationMeta = manifests.get(generation) ?? { generation: 0, runs: [], tombstoneSeq: 0, through: 0 };
  if (current.tombstoneSeq > current.through) {
    problems.push(`tombstoneSeq ${current.tombstoneSeq} past the manifest's through ${current.through}`);
  }
  const staleManifests = [...manifests.keys()].sort((a, b) => b - a).slice(RECLAIM_LAG + 1);
  let prevThrough = 0;
  for (const n of [...manifests.keys()].sort((a, b) => a - b)) {
    const m = manifests.get(n)!;
    if (m.through < prevThrough) problems.push(`manifest ${n} through ${m.through} below an older manifest's ${prevThrough}`);
    prevThrough = Math.max(prevThrough, m.through);
  }

  // --- Runs of the newest manifest.
  const decoded: (SstEntry[] | undefined)[] = [];
  for (const run of current.runs) decoded.push(await checkRun(fs, run, generation, current.through, problems));
  checkOrder(current.runs, decoded, problems);

  // --- Orphans: run files that no manifest lists.
  const live = new Set<string>();
  for (const m of manifests.values()) for (const r of m.runs) live.add(r.path);
  const orphans = (await listRuns(fs)).filter((p) => !live.has(p)).sort();

  // --- Logs: what is written past the newest manifest's cursors.
  const cursors = new Map((current.queues ?? []).map((c) => [c.log, c]));
  const logs: string[] = [];
  let pending = 0;
  for (const { log, segments } of await listLogs(fs)) {
    logs.push(log);
    const cursor = cursors.get(log);
    if (cursor && cursor.state !== "open") continue;
    const listed: ListedSegment[] = [];
    for (const firstN of segments) {
      listed.push({ firstN, bytes: (await fs.read(segmentPath(log, firstN), 0, Number.POSITIVE_INFINITY)) ?? "unreadable" });
    }
    pending += scanLog(log, cursor?.n ?? 0, true, listed).records.length;
  }

  // --- The state the runs hold: oldest first, newest wins.
  const state = new Map<string, { key: Uint8Array; value: Uint8Array | undefined }>();
  for (let i = decoded.length - 1; i >= 0; i--) {
    for (const e of decoded[i] ?? []) {
      state.set(keyToString(e.key), { key: e.key, value: e.kind === "put" ? e.value : undefined });
    }
  }
  const entries: OracleEntry[] = [];
  for (const { key, value } of state.values()) if (value !== undefined) entries.push({ key, value });
  entries.sort((a, b) => compareBytes(a.key, b.key));

  return {
    generation,
    through: current.through,
    runs: current.runs.map((r) => r.path),
    orphans,
    staleManifests: staleManifests.sort((a, b) => a - b),
    emptyManifests: emptyManifests.sort((a, b) => a - b),
    swapFiles: swapFiles.sort(),
    logs: logs.sort(),
    pending,
    state: entries,
    problems,
  };
}

const L0_NAME = /^l0\/(\d+)-(\d+)\.sst$/;
const LEVEL_NAME = /^l(\d+)\/c(\d+)\.(\d+)\.sst$/;

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
  if (run.bytes !== buf.byteLength) bad(`manifest says ${run.bytes} bytes, file has ${buf.byteLength}`);
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
      bad("level name is not c<gen>.<i>.sst");
    } else {
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
