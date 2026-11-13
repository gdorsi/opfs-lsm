import { compareBytes, keyToString } from "../../src/bytes.js";
import { throughAt } from "../../src/store/marks.js";
import type { AsyncFs } from "../../src/opfs/async-fs.js";
import {
  decodeGeneration,
  GENERATION_ZERO,
  listRuns,
  type GenerationMeta,
  type RunMeta,
} from "../../src/store/generation.js";
import { codecForLevel, levelOf } from "../../src/store/levels.js";
import { decodeSst, readFooter, type SstEntry } from "../../src/store/sst.js";
import { show, type OracleEntry } from "./oracle.js";

/**
 * The analogue of SQLite's `PRAGMA integrity_check` for one database: walks
 * IndexedDB `meta` and `wal`, the recorded manifest, and every run it lists,
 * and checks the on-disk rules of docs/design.md. It reads through its own
 * decoders where the engine's are private (WAL rows), so a bug in the
 * engine's reader does not hide a bug in its writer.
 *
 * Call it on a quiet database: no ingest or compaction in flight.
 */
export type DatabaseReport = {
  readonly head: number;
  readonly ingestedThrough: number;
  readonly generation: number | undefined;
  /** Runs of the recorded manifest, in manifest order. */
  readonly runs: readonly string[];
  /** Run files no manifest at or after the recorded one lists. Allowed (design.md, "Crash behavior"). */
  readonly orphans: readonly string[];
  /** Manifests older than the recorded one. Reclaim is best-effort, so allowed. */
  readonly staleManifests: readonly number[];
  /** Empty manifest files newer than the recorded one: a crash before the writer closed. Ignored. */
  readonly emptyManifests: readonly number[];
  /**
   * Chrome's `createWritable` swap files (`<name>.crswap`) in `m/`. A
   * browser killed mid-write leaves one, and Chrome never removes it. The
   * engine removes it once its generation is recorded, so one found here
   * is not a problem.
   */
  readonly swapFiles: readonly string[];
  /** Live entries of the runs plus the WAL, newest wins, in key order. */
  readonly state: readonly OracleEntry[];
  /** Every broken rule. Empty for a healthy database. */
  readonly problems: readonly string[];
};

/** IndexedDB layout from docs/design.md, "Storage layout" (`src/idb/wal.ts`). */
const walName = (name: string) => `opfs-lsm-wal/${name}`;

type Meta = {
  head: number;
  ingestedThrough: number;
  generation: number | undefined;
};

export async function checkDatabase(fs: AsyncFs, name: string): Promise<DatabaseReport> {
  const problems: string[] = [];
  const meta = await walMeta(name);
  const { head, ingestedThrough, generation } = meta;

  // --- WAL: keys are (ingestedThrough, head] with no gap, and may start
  // lower: the last ingest's records stay until the next one (design.md,
  // "Truncation"). Every row decodes. Only the rows above ingestedThrough
  // are uningested.
  const rows = await walRows(name);
  if (ingestedThrough > head) problems.push(`ingestedThrough ${ingestedThrough} past head ${head}`);
  const keys = rows.map((r) => r.seq);
  const low = Math.min(keys[0] ?? ingestedThrough + 1, ingestedThrough + 1) - 1;
  const expected = Array.from({ length: Math.max(0, head - low) }, (_, i) => low + 1 + i);
  if (keys.join(",") !== expected.join(",")) {
    problems.push(`wal keys [${span(keys)}], expected (${ingestedThrough}, ${head}] and a gapless run below`);
  }
  const wal: { seq: number; ops: WalOp[] }[] = [];
  for (const { seq, raw } of rows) {
    try {
      const ops = decodeWalRow(raw);
      if (ops.length === 0) problems.push(`wal row ${seq} has no ops`);
      if (seq <= ingestedThrough) continue;
      wal.push({ seq, ops });
    } catch (err) {
      problems.push(`wal row ${seq}: ${(err as Error).message}`);
    }
  }

  // --- Manifests.
  if (generation === undefined) problems.push("meta.generation is not recorded");
  const recorded = generation ?? 0;
  const manifests = new Map<number, GenerationMeta>();
  const staleManifests: number[] = [];
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
    if (n < recorded) {
      staleManifests.push(n);
      continue;
    }
    const buf = await fs.read(`m/${file}`, 0, Number.POSITIVE_INFINITY);
    // A crash between creating a manifest and closing its writer leaves an
    // empty file (OPFS creates the entry first). The engine skips it.
    if (buf?.byteLength === 0 && n > recorded) {
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
  const current: GenerationMeta | undefined =
    recorded === 0 ? GENERATION_ZERO : manifests.get(recorded);
  if (!current) problems.push(`recorded generation ${recorded} has no readable manifest`);
  if (current && current.tombstoneSeq > current.through) {
    problems.push(`tombstoneSeq ${current.tombstoneSeq} past the manifest's through ${current.through}`);
  }
  if (current && current.through > ingestedThrough) {
    problems.push(`manifest through ${current.through} past ingestedThrough ${ingestedThrough}`);
  }
  // A manifest past the recorded one must not hold seqs past the head: a
  // reopen would adopt it (design.md, "Recovery").
  for (const m of manifests.values()) {
    if (m.generation > recorded && m.through > head) problems.push(`manifest ${m.generation} through ${m.through} past head ${head}`);
  }

  // --- Runs of the recorded manifest.
  const runs = current?.runs ?? [];
  const marks = current?.marks ?? [];
  const decoded: (SstEntry[] | undefined)[] = [];
  for (const run of runs) decoded.push(await checkRun(fs, run, recorded, current?.through ?? 0, problems));
  checkOrder(runs, decoded, problems);
  // A run holds no version that a range delete it applied covers.
  runs.forEach((run, i) => {
    const applied = marks.filter((m) => m.at <= run.marksThrough);
    const covering = (decoded[i] ?? []).find((e) => e.seq <= throughAt(applied, e.key));
    if (covering) problems.push(`${run.path}: holds ${show(covering.key)} at seq ${covering.seq}, covered by a mark it applied`);
  });

  // --- Orphans: run files that no manifest from the recorded one on lists.
  const live = new Set<string>();
  for (const m of manifests.values()) for (const r of m.runs) live.add(r.path);
  const orphans = (await listRuns(fs)).filter((p) => !live.has(p)).sort();

  // --- The state a reader should see: runs oldest first under the
  // manifest's marks, then the WAL with its range deletes.
  const state = new Map<string, { key: Uint8Array; value: Uint8Array | undefined; seq: number }>();
  for (let i = decoded.length - 1; i >= 0; i--) {
    for (const e of decoded[i] ?? []) {
      state.set(keyToString(e.key), { key: e.key, value: e.kind === "put" ? e.value : undefined, seq: e.seq });
    }
  }
  for (const [id, row] of state) {
    if (row.seq <= (throughAt(marks, row.key))) state.delete(id);
  }
  for (const { seq, ops } of wal) {
    for (const op of ops) {
      if ("key" in op) {
        state.set(keyToString(op.key), { key: op.key, value: op.value, seq });
        continue;
      }
      const through = Math.min(op.through, seq - 1);
      for (const [id, row] of state) {
        const inside = compareBytes(row.key, op.start) >= 0 && (!op.endExclusive || compareBytes(row.key, op.endExclusive) < 0);
        if (inside && row.seq <= through) state.delete(id);
      }
    }
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
    staleManifests: staleManifests.sort((a, b) => a - b),
    emptyManifests: emptyManifests.sort((a, b) => a - b),
    swapFiles: swapFiles.sort(),
    state: live_,
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
    const want = codecForLevel(level);
    if (codec !== want) bad(`codec ${codec}, level ${level} uses ${want}`);
  } else {
    bad("path names no level");
  }
  return entries;
}

/**
 * Manifest order (docs/manifest-format.md): L0 newest first, then each
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

/** A put (`value`) or a delete; or a range delete with the `through` its writer asked for. */
export type WalOp =
  | { key: Uint8Array; value: Uint8Array | undefined }
  | { start: Uint8Array; endExclusive?: Uint8Array; through: number };

/**
 * design.md, "WAL records": per op, u8 type | u32 keyLen | key | put: u32
 * valueLen | value; a range delete: u8 3 | u32 startLen | start | u8 has end
 * | end: u32 endLen | end | u64 through.
 */
export function decodeWalRow(raw: unknown): WalOp[] {
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
    else if (type === 3) {
      const end = take(1)[0] === 1 ? take(u32()) : undefined;
      const through = Number(new DataView(take(8).buffer).getBigUint64(0, true));
      ops.push({ start: key, ...(end ? { endExclusive: end } : {}), through });
    } else throw new Error(`op type ${type}`);
  }
  return ops;
}

function span(keys: readonly number[]): string {
  if (keys.length <= 6) return keys.join(",");
  return `${keys.slice(0, 3).join(",")},…,${keys.slice(-3).join(",")} (${keys.length})`;
}

// --- Raw IndexedDB access for the checker and for tests that damage a WAL.

function openRaw(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(walName(name));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run `fn` over the `wal` and `meta` stores in one transaction. */
export async function walStore<T>(
  name: string,
  mode: IDBTransactionMode,
  fn: (wal: IDBObjectStore, meta: IDBObjectStore) => IDBRequest<T> | Promise<T> | T,
): Promise<T> {
  const db = await openRaw(name);
  try {
    if (!db.objectStoreNames.contains("wal") || !db.objectStoreNames.contains("meta")) {
      throw new Error(`${walName(name)} has no wal/meta stores`);
    }
    const tx = db.transaction(["wal", "meta"], mode);
    const finished = done(tx);
    const out = fn(tx.objectStore("wal"), tx.objectStore("meta"));
    const value = out instanceof IDBRequest ? await result(out) : await out;
    await finished;
    return value;
  } finally {
    db.close();
  }
}

/** `head` is the last WAL key, or `ingestedThrough` when no record is past it (`src/idb/wal.ts`). */
export function walMeta(name: string): Promise<Meta> {
  return walStore(name, "readonly", async (wal, meta) => {
    const [ingested, generation, last] = await Promise.all([
      ...["ingestedThrough", "generation"].map((k) => result(meta.get(k))),
      result(wal.openKeyCursor(null, "prev")).then((cursor) => cursor?.key),
    ]);
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    return {
      head: Math.max(num(ingested) ?? 0, num(last) ?? 0),
      ingestedThrough: num(ingested) ?? 0,
      generation: num(generation),
    };
  });
}

export function walRows(name: string): Promise<{ seq: number; raw: unknown }[]> {
  return walStore(name, "readonly", async (wal) => {
    const [keys, values] = await Promise.all([result(wal.getAllKeys()), result(wal.getAll())]);
    return keys.map((k, i) => ({ seq: Number(k), raw: values[i] }));
  });
}

export function deleteWal(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(walName(name));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
