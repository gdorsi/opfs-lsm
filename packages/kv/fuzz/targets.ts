/**
 * Decoder targets for the corruption suite (docs/research/corruption-hardening-test-suite.md,
 * technique 7). The fast-check properties (`fuzz/*.test.ts`) and the
 * Jazzer.js targets (`fuzz/jazzer/`) call these on arbitrary bytes. Each
 * one runs a decoder the way the engine runs it and throws `RuleBroken` when
 * the outcome breaks the rules of the note's "Decisions":
 *
 * - Everywhere: no hang, no endless cursor, no allocation sized by a length
 *   field, and no error but the documented one. A `RangeError` from a
 *   `DataView` is an out-of-bounds read the runtime caught, so it breaks the
 *   rule too.
 * - Where the engine checks a CRC (`decodeSst`, which the SharedWorker runs
 *   before compacting; `decodeGeneration`): changed bytes must throw
 *   `CorruptDatabaseError`, never decode.
 * - Where it does not (a tab's `SstReader`, LZ4 unpack, block scans, WAL
 *   rows): any answer is allowed, within the rules above.
 */
import { compareBytes } from "../src/bytes.js";
import { CommitError, CorruptDatabaseError } from "../src/errors.js";
import { decodeOps } from "../src/idb/wal.js";
import { crc32 } from "../src/store/crc32.js";
import { Miss, type LayerCursor, type LayerEntry, type Maybe } from "../src/store/cursor.js";
import { decodeGeneration, type GenerationMeta, type KeyRange } from "../src/store/generation.js";
import { lz4DecompressJs } from "../src/store/lz4.js";
import { PageCache } from "../src/store/page-cache.js";
import { bytesFile, SstReader } from "../src/store/sst-reader.js";
import { decodeSst, type SstEntry } from "../src/store/sst.js";

export class RuleBroken extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleBroken";
  }
}

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/** Wall time one target call may take. A healthy call takes well under 50 ms. */
const TIME_LIMIT_MS = Number(env.KV_FUZZ_TIME_LIMIT_MS ?? 2000);
/** Bytes one target call may allocate in ArrayBuffers or wasm memory. */
const ALLOC_LIMIT = 64 << 20;

const FOOTER_BYTES = 44;

const u32 = (b: Uint8Array, o: number): number | undefined =>
  o >= 0 && o + 4 <= b.byteLength ? new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true) : undefined;

/** Rewrite an SST footer's CRC so a decoder reaches the structure behind it. */
export function fixSstCrc(buf: Uint8Array): void {
  if (buf.byteLength < FOOTER_BYTES) return;
  const at = buf.byteLength - 12;
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(at, crc32(buf.subarray(0, at)), true);
}

/**
 * How much of a mutated run to repair so a decoder gets past its first
 * checks: nothing, the CRC, or the version, magic and CRC.
 */
export type Repair = "none" | "crc" | "trailer";

export function repairSst(buf: Uint8Array, how: Repair): void {
  if (how === "trailer" && buf.byteLength >= FOOTER_BYTES) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    view.setUint32(buf.byteLength - 8, 1, true);
    view.setUint32(buf.byteLength - 4, 0x4f4c5354, true);
  }
  if (how !== "none") fixSstCrc(buf);
}

/** Rewrite a manifest's trailing CRC. */
export function fixManifestCrc(buf: Uint8Array): void {
  if (buf.byteLength < 4) return;
  const at = buf.byteLength - 4;
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(at, crc32(buf.subarray(0, at)), true);
}

type Footer = { entryCount: number; blockCount: number; dataLen: number; hashCount: number; indexStart: number; codec: number };

export function footerOf(buf: Uint8Array): Footer | undefined {
  if (buf.byteLength < FOOTER_BYTES) return undefined;
  const at = buf.byteLength - FOOTER_BYTES;
  const f = (i: number) => u32(buf, at + 4 * i)!;
  return { entryCount: f(0), blockCount: f(1), dataLen: f(2), hashCount: f(4), indexStart: f(5), codec: f(7) };
}

/**
 * The framed bytes of each block the index names, read without trusting it.
 * A block counts when it lies inside the file, as `blockBytes` checks it,
 * even past `dataLen`: `decodeSst` does not compare the two.
 */
export function framedBlocks(buf: Uint8Array): Uint8Array[] {
  const f = footerOf(buf);
  if (!f) return [];
  const out: Uint8Array[] = [];
  let o = f.indexStart;
  for (let i = 0; i < Math.min(f.blockCount, 4096); i++) {
    const first = u32(buf, o);
    if (first === undefined) break;
    o += 4 + first;
    const last = u32(buf, o);
    if (last === undefined) break;
    o += 4 + last;
    const offset = u32(buf, o);
    const length = u32(buf, o + 4);
    if (offset === undefined || length === undefined) break;
    o += 8;
    if (offset + length > buf.byteLength) break;
    out.push(buf.subarray(offset, offset + length));
  }
  return out;
}

/** How often each target ran, for `KV_FUZZ_REPORT=1`. */
export const tally = new Map<string, number>();
const count = (what: string) => tally.set(what, (tally.get(what) ?? 0) + 1);

/** Wasm memory in bytes, when a test registers the module's memory. */
let wasmBytes: () => number = () => 0;
export function watchWasmMemory(read: () => number): void {
  wasmBytes = read;
}

function arrayBufferBytes(): number {
  const p = (globalThis as { process?: { memoryUsage?: () => { arrayBuffers: number } } }).process;
  return p?.memoryUsage?.().arrayBuffers ?? 0;
}

/**
 * Run `fn` and check the bounds every target shares: wall time, and bytes
 * allocated in ArrayBuffers and wasm memory. GC during the call can only
 * hide bytes, so a report is never false.
 */
export async function bounded<T>(what: string, fn: () => Promise<T> | T): Promise<T> {
  count(what);
  const t0 = performance.now();
  const ab0 = arrayBufferBytes();
  const wasm0 = wasmBytes();
  const out = await fn();
  const ms = performance.now() - t0;
  if (ms > TIME_LIMIT_MS) throw new RuleBroken(`${what} took ${ms.toFixed(0)} ms`);
  const grew = Math.max(arrayBufferBytes() - ab0, wasmBytes() - wasm0);
  if (grew > ALLOC_LIMIT) throw new RuleBroken(`${what} allocated ${grew} bytes`);
  return out;
}

const describe = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : `a thrown ${typeof err} (${String(err)})`);

/** `err` must be the documented error, else the rule is broken. */
function expectCorrupt(what: string, err: unknown): void {
  if (err instanceof RuleBroken) throw err;
  if (err instanceof CorruptDatabaseError) return;
  throw new RuleBroken(`${what} threw ${describe(err)}, not CorruptDatabaseError`);
}

/** Re-run a sync read until it stops missing, at most `tries` times. */
async function settleBounded<T>(what: string, attempt: () => Maybe<T>, tries = 64): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const r = attempt();
    if (!(r instanceof Miss)) return r;
    await r.ready;
  }
  throw new RuleBroken(`${what} kept missing`);
}

/** Every entry of `cursor`, failing when it yields more than `max`. */
async function drainBounded(what: string, cursor: LayerCursor, max: number): Promise<LayerEntry[]> {
  const out: LayerEntry[] = [];
  let misses = 0;
  for (;;) {
    const e = cursor.peek();
    if (e instanceof Miss) {
      if (++misses > 4096) throw new RuleBroken(`${what} kept missing`);
      await e.ready;
      continue;
    }
    if (!e) return out;
    out.push(e);
    if (out.length > max) throw new RuleBroken(`${what} yielded more than ${max} entries`);
    cursor.next();
  }
}

export type ReadProbe = {
  /** Keys to get. */
  readonly keys: readonly Uint8Array[];
  /** What the manifest would record for the run; undefined reads unrouted. */
  readonly range?: KeyRange | undefined;
  /** One pattern for `scanContains`. */
  readonly pattern: Uint8Array;
};

export type ReadResult = {
  readonly gets: (SstEntry | undefined | "error")[];
  readonly scan: LayerEntry[] | "error";
  readonly seek: LayerEntry[] | "error";
  readonly contains: LayerEntry[] | "error";
};

/**
 * A tab's read of one run file, as `SstReader` does it: get each probe key,
 * scan it all, scan from the middle key, and a filtered scan. No CRC is
 * checked, so any answer is allowed; each read may throw only
 * `CorruptDatabaseError`, and must end in bounded time and memory.
 */
export async function checkRunRead(buf: Uint8Array, probe: ReadProbe): Promise<ReadResult> {
  return bounded("a tab read of a run", async () => {
    const reader = new SstReader(bytesFile(buf), new PageCache(), probe.range);
    const max = 255 * buf.byteLength + 16;
    const one = async <T>(what: string, run: () => Promise<T>): Promise<T | "error"> => {
      try {
        return await run();
      } catch (err) {
        expectCorrupt(what, err);
        return "error";
      }
    };
    const gets: ReadResult["gets"] = [];
    for (const key of probe.keys) gets.push(await one("SstReader.get", () => settleBounded("SstReader.get", () => reader.get(key))));
    const scan = await one("SstReader.cursor", () => drainBounded("SstReader.cursor", reader.cursor(), max));
    const mid = probe.keys[probe.keys.length >> 1];
    const seek = await one("SstReader.cursor (seek)", () =>
      drainBounded("SstReader.cursor (seek)", reader.cursor(mid ? { start: mid } : undefined), max),
    );
    const contains = await one("SstReader.scanContains", () =>
      drainBounded("SstReader.scanContains", reader.scanContains([probe.pattern]), max),
    );
    reader.close();
    return { gets, scan, seek, contains };
  });
}

/** What a reader of an intact run must return for `probe`. */
export function expectedRead(entries: readonly SstEntry[], probe: ReadProbe): ReadResult {
  const sorted = [...entries].sort((a, b) => compareBytes(a.key, b.key));
  const layer = (e: SstEntry): LayerEntry => (e.kind === "put" ? { key: e.key, kind: "put", value: e.value } : { key: e.key, kind: "del" });
  const mid = probe.keys[probe.keys.length >> 1];
  const holds = (v: Uint8Array) => {
    const p = probe.pattern;
    if (p.byteLength === 0) return true;
    outer: for (let i = 0; i + p.byteLength <= v.byteLength; i++) {
      for (let j = 0; j < p.byteLength; j++) if (v[i + j] !== p[j]) continue outer;
      return true;
    }
    return false;
  };
  return {
    gets: probe.keys.map((k) => sorted.find((e) => compareBytes(e.key, k) === 0)),
    scan: sorted.map(layer),
    seek: sorted.filter((e) => !mid || compareBytes(e.key, mid) >= 0).map(layer),
    contains: sorted.filter((e) => e.kind === "put" && holds(e.value)).map(layer),
  };
}

/**
 * The SharedWorker's full decode of a run (TypeScript fallback). It checks
 * the CRC, so when `changed` (the bytes differ from what the encoder wrote
 * and the CRC was not rewritten to match) it must throw.
 */
export async function checkDecodeSst(buf: Uint8Array, changed: boolean): Promise<SstEntry[] | undefined> {
  return bounded("decodeSst", () => {
    try {
      const entries = decodeSst(buf);
      if (changed) throw new RuleBroken("decodeSst accepted a run whose bytes changed under its CRC");
      return entries;
    } catch (err) {
      expectCorrupt("decodeSst", err);
      return undefined;
    }
  });
}

/** `decodeGeneration`: CRC-checked, so the same rules as `checkDecodeSst`. */
export async function checkManifest(buf: Uint8Array, changed: boolean): Promise<GenerationMeta | undefined> {
  return bounded("decodeGeneration", () => {
    try {
      const meta = decodeGeneration(buf);
      if (changed) throw new RuleBroken("decodeGeneration accepted a manifest whose bytes changed under its CRC");
      return meta;
    } catch (err) {
      expectCorrupt("decodeGeneration", err);
      return undefined;
    }
  });
}

/**
 * A WAL row (`decodeOps`). Rows have no checksum: a changed row may decode
 * to other ops. It must throw only `CommitError("corrupt wal ...")`
 * (design.md, "WAL records"), and what it decodes must encode back to the
 * same bytes, so the decoder never invents or drops a byte.
 */
export async function checkWalRow(raw: unknown): Promise<void> {
  await bounded("decodeOps", () => {
    let ops: ReturnType<typeof decodeOps>;
    try {
      ops = decodeOps(raw);
    } catch (err) {
      if (err instanceof CommitError && /corrupt wal/.test(err.message)) return;
      throw new RuleBroken(`decodeOps threw ${describe(err)}, not CommitError("corrupt wal ...")`);
    }
    const back = encodeWalRow(ops.map((op) => (op.type === "put" ? { put: op.key, value: op.value } : { del: op.key })));
    const bytes = new Uint8Array(raw as ArrayBuffer);
    if (back.byteLength !== bytes.byteLength || back.some((b, i) => b !== bytes[i])) {
      throw new RuleBroken("decodeOps returned ops that do not encode back to the row");
    }
  });
}

export type RowOp = { readonly put: Uint8Array; readonly value: Uint8Array } | { readonly del: Uint8Array };

/** A WAL row in the format of design.md, "WAL records", written by the harness. */
export function encodeWalRow(ops: readonly RowOp[]): Uint8Array {
  let size = 0;
  for (const op of ops) size += "put" in op ? 9 + op.put.byteLength + op.value.byteLength : 5 + op.del.byteLength;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const op of ops) {
    const key = "put" in op ? op.put : op.del;
    out[o] = "put" in op ? 0 : 1;
    view.setUint32(o + 1, key.byteLength, true);
    out.set(key, o + 5);
    o += 5 + key.byteLength;
    if ("put" in op) {
      view.setUint32(o, op.value.byteLength, true);
      out.set(op.value, o + 4);
      o += 4 + op.value.byteLength;
    }
  }
  return out;
}

/**
 * The TypeScript LZ4 block decoder. No CRC guards it in a tab. It must
 * return exactly `size` bytes or throw `CorruptDatabaseError`.
 */
export async function checkLz4(src: Uint8Array, size: number): Promise<Uint8Array | undefined> {
  return bounded("lz4DecompressJs", () => {
    try {
      const out = lz4DecompressJs(src, size);
      if (out.byteLength !== size) throw new RuleBroken(`lz4DecompressJs returned ${out.byteLength} bytes, not ${size}`);
      return out;
    } catch (err) {
      expectCorrupt("lz4DecompressJs", err);
      return undefined;
    }
  });
}
