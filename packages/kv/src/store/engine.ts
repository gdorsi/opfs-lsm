/**
 * Engine-core bridge. Loads a module that implements `packages/kv/engine/abi.md`.
 * The module is required: the engine writes and merges runs only through it,
 * so a context where it does not load cannot flush.
 */
import type { EncodedRun, RunEnd, SstEntry } from "./sst.js";
import { useBlockScanner } from "./block-scan.js";
import { encodeMarks, type Marks } from "./marks.js";
import { CorruptDatabaseError, StorageUnavailableError } from "../errors.js";

/** The module could not allocate the memory an operation needed. */
export class EngineOutOfMemoryError extends Error {
  constructor(op: string, inputBytes: number) {
    super(`wasm engine out of memory in ${op}: input ${inputBytes} bytes`);
    this.name = "EngineOutOfMemoryError";
  }
}

const OUT_OF_MEMORY = -10;
const SESSION_OPEN = -12;
/** What each status of the module means, by `-code`. An empty entry is not a corruption status: 0, out of memory, a host bug. */
const STATUS_NAMES = [
  "",
  "too short",
  "bad magic",
  "bad version",
  "crc mismatch",
  "truncated",
  "bad tag",
  "trailing garbage",
  "count mismatch",
  "bad block",
  "",
  "patterns truncated",
  "",
  "keys out of order",
];
/** The host broke the session protocol: a bug, not corrupt data. */
const HOST_BUGS: Record<number, string> = {
  [SESSION_OPEN]: "a session is open",
  [-14]: "no session",
  [-15]: "a demand was not fed",
};

const NEED = 1;
const WRITE = 2;
const RUN_END = 3;
const YIELD = 4;
const DONE = 5;
const DEMAND_BYTES = 16;
const RUN_HEAD_BYTES = 16;

export type EngineExports = {
  memory: WebAssembly.Memory;
  input_ptr(len: number): number;
  result_ptr(): number;
  result_len(): number;
  encode_sst(ptr: number, len: number): number;
  scan_block_contains(ptr: number, len: number, patPtr: number, patLen: number): number;
  merge_open(ptr: number, len: number, drop: number, target: number, chunkBytes: number, tailBytes: number, yieldBytes: number): number;
  merge_pump(): number;
  merge_feed(source: number, len: number): number;
  merge_close(): number;
};

/**
 * A compaction merge that the host drives a stop at a time
 * (packages/kv/engine/abi.md, "Merge session"), so it holds a window of each
 * input instead of the whole input.
 */
export type MergeSpec = {
  /**
   * Newest first. A source is the byte sizes of runs read back to back as
   * one key-ordered stream: an L0 run, or the runs a step takes from the
   * level below it.
   */
  readonly sources: readonly (readonly number[])[];
  /** Drop the tombstones that win: only when the output is the bottom level. */
  readonly dropTombstones: boolean;
  /** The base manifest's marks: a winner one covers is dropped. */
  readonly marks: Marks;
  /**
   * Close an output run once its entries' estimated sizes reach this: a
   * record's tag, seq, u32 key length and key, and for a put a u32 value
   * length and the value.
   */
  readonly targetBytes: number;
  /** About how much of each source to hold, and the most a `write` carries. */
  readonly chunkBytes: number;
  /** How much of a run's end to read first, for its footer and index. */
  readonly tailBytes: number;
  /** About how many input bytes to merge before a `yield`. */
  readonly yieldBytes: number;
};

/** `length` bytes at `offset` of run `run` of source `source`. */
export type Demand = { readonly source: number; readonly run: number; readonly offset: number; readonly length: number };

export type MergeStop =
  /** Read each, `feed` it, then pump. */
  | { readonly kind: "need"; readonly demands: readonly Demand[] }
  /** The next bytes of the open output run. Never a view of wasm memory, so they outlive the next call. */
  | { readonly kind: "write"; readonly bytes: Uint8Array }
  /** The open output run is complete: every byte of it was in a `write`. */
  | { readonly kind: "run-end"; readonly end: RunEnd }
  /** About `yieldBytes` of input were merged since the pump began. */
  | { readonly kind: "yield" }
  /** Every input was read and every run's CRC matched: the outputs may be installed. */
  | { readonly kind: "done" };

export interface MergeCore {
  /**
   * Merge until the host has to act. A corrupt input throws
   * CorruptDatabaseError, and so does every later pump.
   */
  pump(): MergeStop;
  /** Answer `source`'s demand from the last `need`. */
  feed(source: number, bytes: Uint8Array): void;
  /** Drop the session and its buffers. Idempotent. */
  close(): void;
}

/**
 * One engine module behind typed calls. Everything crosses as flat bytes;
 * this file is the only place that packs and unpacks them. Results are
 * copied out of wasm memory once, so they stay valid after later calls.
 *
 * What a tab calls on its reads, `scanBlockContainsIn`, and what only the
 * host calls, `encodeRunIn` and `openMergeIn`, are functions over the
 * engine, so a bundle carries only the side it runs.
 */
export type FlatEngine = {
  readonly ex: EngineExports;
  /** Write `len` bytes through `fill`, run `op`, return a copy of the result. */
  call(name: string, len: number, fill: (into: Uint8Array) => void, op: (ptr: number) => number): Uint8Array;
  /** The module's memory. It only grows. */
  memoryBytes(): number;
  /** Whether a merge session is open, from its `openMergeIn` to its `close`. */
  sessionOpen: boolean;
};

const TAG_PUT = 1;
const TAG_DEL = 2;
const TWO_32 = 0x1_0000_0000;

export function flatEngine(instance: { readonly exports: WebAssembly.Exports }): FlatEngine {
  const ex = instance.exports as unknown as EngineExports;

  function call(
    name: string,
    len: number,
    fill: (into: Uint8Array) => void,
    op: (ptr: number) => number,
  ): Uint8Array {
    const ptr = ex.input_ptr(len);
    if (ptr === 0 && len > 0) throw new EngineOutOfMemoryError(name, len);
    fill(new Uint8Array(ex.memory.buffer, ptr, len));
    const code = op(ptr);
    if (code < 0) throw statusError(name, code, len);
    const at = ex.result_ptr();
    return new Uint8Array(ex.memory.buffer).slice(at, at + ex.result_len());
  }

  return { ex, call, memoryBytes: () => ex.memory.buffer.byteLength, sessionOpen: false };
}

/** The hits of `patterns` in one block, as `engine` packs them. */
export function scanBlockContainsIn(engine: FlatEngine, block: Uint8Array, patterns: Uint8Array): Uint8Array {
  return engine.call(
    "scan_block_contains",
    block.byteLength + patterns.byteLength,
    (into) => {
      into.set(block);
      into.set(patterns, block.byteLength);
    },
    (ptr) => engine.ex.scan_block_contains(ptr, block.byteLength, ptr + block.byteLength, patterns.byteLength),
  );
}

/** `entries` as one run, encoded by `engine`: in any key order, and of the entries of one key the last is kept. */
export function encodeRunIn(engine: FlatEngine, entries: readonly SstEntry[]): EncodedRun {
  let size = 0;
  for (const e of entries) {
    size += 1 + 8 + 4 + e.key.byteLength + (e.kind === "put" ? 4 + e.value.byteLength : 0);
  }
  const out = engine.call(
    "encode_sst",
    size,
    (into) => {
      const view = new DataView(into.buffer, into.byteOffset, into.byteLength);
      let o = 0;
      for (const e of entries) {
        const seq = e.seq;
        view.setUint8(o, e.kind === "put" ? TAG_PUT : TAG_DEL);
        view.setUint32(o + 1, seq % TWO_32, true);
        view.setUint32(o + 5, Math.floor(seq / TWO_32), true);
        view.setUint32(o + 9, e.key.byteLength, true);
        into.set(e.key, o + 13);
        o += 13 + e.key.byteLength;
        if (e.kind === "put") {
          view.setUint32(o, e.value.byteLength, true);
          into.set(e.value, o + 4);
          o += 4 + e.value.byteLength;
        }
      }
    },
    (ptr) => engine.ex.encode_sst(ptr, size),
  );
  return readRun(out);
}

/**
 * `engine`'s merge session. The module holds one at a time, so a second open
 * throws: the host takes turns (`inMergeSlot`).
 */
export function openMergeIn(engine: FlatEngine, spec: MergeSpec): MergeCore {
  named = nameStatus;
  const { ex } = engine;
  let words = 1;
  let inputBytes = 0;
  for (const runs of spec.sources) {
    words += 1 + runs.length;
    for (const size of runs) inputBytes += size;
  }
  const marks = encodeMarks(spec.marks);
  const len = 4 * words + marks.byteLength;
  // Addresses are u32 and come back as i32: past 2 GiB they read negative.
  const ptr = ex.input_ptr(len) >>> 0;
  if (ptr === 0) throw new EngineOutOfMemoryError("merge_open", len);
  const list = new DataView(ex.memory.buffer, ptr, len);
  let o = 0;
  const put = (v: number) => {
    list.setUint32(o, v, true);
    o += 4;
  };
  put(spec.sources.length);
  for (const runs of spec.sources) {
    put(runs.length);
    for (const size of runs) put(size);
  }
  new Uint8Array(ex.memory.buffer, ptr + o, marks.byteLength).set(marks);
  const opened = ex.merge_open(
    ptr,
    len,
    spec.dropTombstones ? 1 : 0,
    spec.targetBytes,
    spec.chunkBytes,
    spec.tailBytes,
    spec.yieldBytes,
  );
  if (opened < 0) throw statusError("merge_open", opened, inputBytes);
  engine.sessionOpen = true;
  // The module holds one session and `merge_close` drops whichever is
  // open, so a closed handle must not reach a session opened after it.
  let closed = false;
  const live = () => {
    if (closed) throw new Error("merge session closed");
  };
  return {
    pump() {
      live();
      const code = ex.merge_pump();
      if (code < 0) throw statusError("merge_pump", code, inputBytes);
      const result = new Uint8Array(ex.memory.buffer, ex.result_ptr() >>> 0, ex.result_len());
      const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
      switch (code) {
        case NEED: {
          const demands: Demand[] = [];
          for (let o = 0; o < result.byteLength; o += DEMAND_BYTES) {
            demands.push({
              source: view.getUint32(o, true),
              run: view.getUint32(o + 4, true),
              offset: view.getUint32(o + 8, true),
              length: view.getUint32(o + 12, true),
            });
          }
          return { kind: "need", demands };
        }
        case WRITE:
          return { kind: "write", bytes: result.slice() };
        case RUN_END:
          return { kind: "run-end", end: readEnd(result, view, RUN_HEAD_BYTES) };
        case YIELD:
          return { kind: "yield" };
        case DONE:
          return { kind: "done" };
        default:
          throw new Error(`merge_pump: unknown stop ${code}`);
      }
    },
    feed(source, bytes) {
      live();
      const at = ex.merge_feed(source, bytes.byteLength) >>> 0;
      if (at === 0) throw new Error(`merge_feed: source ${source} has no unfed demand of ${bytes.byteLength} bytes`);
      new Uint8Array(ex.memory.buffer, at, bytes.byteLength).set(bytes);
    },
    close() {
      if (closed) return;
      closed = true;
      engine.sessionOpen = false;
      ex.merge_close();
    },
  };
}

/**
 * A run record (packages/kv/engine/abi.md). The body is a view into `bytes`. The
 * keys are copies, so the manifest does not keep `bytes` alive.
 */
function readRun(bytes: Uint8Array): EncodedRun {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keys = RUN_HEAD_BYTES + view.getUint32(4, true);
  return { body: bytes.subarray(RUN_HEAD_BYTES, keys), end: readEnd(bytes, view, keys) };
}

/** The `RunEnd` of the run head that `bytes` starts with, whose two keys start at `keys`. Copies the keys. */
function readEnd(bytes: Uint8Array, view: DataView, keys: number): RunEnd {
  const entries = view.getUint32(0, true);
  const size = view.getUint32(4, true);
  const firstLen = view.getUint32(8, true);
  const lastLen = view.getUint32(12, true);
  if (entries === 0) return { bytes: size };
  return {
    bytes: size,
    range: { smallest: bytes.slice(keys, keys + firstLen), largest: bytes.slice(keys + firstLen, keys + firstLen + lastLen) },
  };
}

/**
 * Names a status. Set where the host first asks for the module: its
 * operations decode whole runs and drive sessions, so the bundle of a tab,
 * whose one call fails only on a bad block, leaves the names out.
 */
let named: ((op: string, code: number) => Error) | undefined;

function statusError(op: string, code: number, inputBytes: number): Error {
  if (code === OUT_OF_MEMORY) return new EngineOutOfMemoryError(op, inputBytes);
  return named?.(op, code) ?? new CorruptDatabaseError(`${op}: corrupt (status ${code})`);
}

function nameStatus(op: string, code: number): Error {
  const bug = HOST_BUGS[code];
  if (bug) return new Error(`${op}: ${bug} (status ${code})`);
  return new CorruptDatabaseError(`${op}: ${STATUS_NAMES[-code] || "corrupt"} (status ${code})`);
}

let engine: FlatEngine | undefined;
/** Kept so a new instance can be made without fetching or compiling again. */
let wasmModule: WebAssembly.Module | undefined;
let initOnce: Promise<void> | undefined;
/** The most memory any instance this context dropped had reached. */
let droppedPeakBytes = 0;
let mergeReservedBytes = 0;
let recycleCount = 0;

/** Every swap goes through here, so the memory a dropped instance reached is not lost. */
function setEngine(next: FlatEngine | undefined): void {
  droppedPeakBytes = Math.max(droppedPeakBytes, engine?.memoryBytes() ?? 0);
  engine = next;
}

async function loadWasm(): Promise<FlatEngine> {
  // Keep this a literal `new URL(..., import.meta.url)`: bundlers emit the .wasm only for that form.
  const module = await WebAssembly.compile(await readEngine(new URL("../../wasm/engine.wasm", import.meta.url)));
  const loaded = flatEngine(await WebAssembly.instantiate(module, engineImports()));
  wasmModule = module;
  return loaded;
}

async function fetchWasm(url: URL): Promise<BufferSource> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`engine wasm ${url.href}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

let readEngine: (url: URL) => Promise<BufferSource> = fetchWasm;

/**
 * Test seam: how this context reads the `.wasm` file. Node's fetch cannot
 * read a `file:` URL, so `@opfs-lsm/kv/testing` passes a file reader there.
 */
export function readEngineWith(read: (url: URL) => Promise<BufferSource>): void {
  readEngine = read;
}

let engineImports = (): WebAssembly.Imports => ({});

/** Test seam: what each new instance imports. The module this context loads imports nothing, its checked twin a shadow memory. */
export function importEngineWith(imports: () => WebAssembly.Imports): void {
  engineImports = imports;
}

/**
 * Load the module once per context. Rejects with `StorageUnavailableError`
 * when it does not load, and the next call tries again.
 */
function loadEngine(): Promise<void> {
  initOnce ??= loadWasm().then(setEngine, (cause: unknown) => {
    initOnce = undefined;
    const detail = cause instanceof Error ? ` (${cause.message})` : "";
    throw new StorageUnavailableError(`the wasm engine failed to load${detail}`, { cause });
  });
  return initOnce;
}

let scanHook = false;

/**
 * Load the module, then route block scans through it. Only the tab scans
 * blocks, so the host loads through `loadEngine` and its bundle leaves out
 * the hook.
 */
export async function ensureEngine(): Promise<void> {
  await loadEngine();
  if (scanHook) return;
  scanHook = true;
  // It reads `engine` at each call: it is replaced when the instance is.
  useBlockScanner((block, patterns) => onEngine("sst block corrupt", () => scanBlockContainsIn(engine!, block, patterns)));
}

/**
 * `run`, and once more after a trap: the fresh instance says whether the
 * block is corrupt or the old instance was spent.
 */
function onEngine<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (!afterTrap(err)) throw corrupt(err, what);
    try {
      return run();
    } catch (again) {
      afterTrap(again);
      throw corrupt(again, what);
    }
  }
}

/** The loaded engine. */
async function loaded(): Promise<FlatEngine> {
  named = nameStatus;
  await loadEngine();
  return engine!;
}

/**
 * True when `err` is a wasm trap. A trap does not unwind, so the trapped
 * call's frames stay on the instance's shadow stack: a few thousand traps use
 * it up and every later call fails. A fresh instance takes over.
 */
function afterTrap(err: unknown): boolean {
  if (!(err instanceof WebAssembly.RuntimeError)) return false;
  restartEngine();
  return true;
}

/** A bad status means the bytes are corrupt, or the module ran out of memory, and is thrown as is. */
function corrupt(err: unknown, what: string): unknown {
  if (err instanceof CorruptDatabaseError || err instanceof EngineOutOfMemoryError) return err;
  return new CorruptDatabaseError(`${what}: ${String(err)}`);
}

function restartEngine(): void {
  if (!wasmModule) return;
  try {
    setEngine(flatEngine(new WebAssembly.Instance(wasmModule, engineImports())));
  } catch {
    // No memory for a second instance: the old one stays.
  }
}

/** What this context's wasm engine holds, for `HostStats.memory`. Zero before it loads. */
type EngineMemory = {
  /** The current instance's memory. Wasm memory never shrinks, so it only grows until a recycle. */
  wasmBytes: number;
  /** The most memory any instance reached. */
  wasmPeakBytes: number;
  /** The most a merge session was asked to reserve: a window per source and one for the output run. */
  mergeReservedBytes: number;
  /** Instances replaced by `recycleEngine`. */
  recycles: number;
};

export function engineMemory(): EngineMemory {
  const wasmBytes = engine?.memoryBytes() ?? 0;
  return {
    wasmBytes,
    wasmPeakBytes: Math.max(droppedPeakBytes, wasmBytes),
    mergeReservedBytes,
    recycles: recycleCount,
  };
}

/**
 * Replace the instance with a fresh one when its memory passed `maxBytes`.
 * Wasm memory never shrinks, so a new instance is the only way to give it
 * back, and the dropped one's memory returns once it is collected. Skipped
 * while a merge session is open, since the session lives in the old
 * instance. Nothing holds a view of the old memory across an await: results
 * are copies, and the scan hook reads `engine` at each call.
 */
export function recycleEngine(maxBytes: number): boolean {
  if (!engine || !wasmModule || engine.sessionOpen || engine.memoryBytes() <= maxBytes) return false;
  try {
    setEngine(flatEngine(new WebAssembly.Instance(wasmModule, engineImports())));
  } catch {
    // No memory for a second instance: the old one still works.
    return false;
  }
  recycleCount += 1;
  return true;
}

/**
 * A process that dies mid-merge leaves no session behind, since its successor
 * has an engine of its own. A test that freezes a host to stand in for that
 * death restarts the engine for the next host.
 */
export function __restartEngineForTests(): void {
  if (engine) restartEngine();
}

/**
 * A run of `entries` with what the encoder reports at its end: the size and
 * the key range the manifest records.
 */
export async function encodeRun(entries: readonly SstEntry[]): Promise<EncodedRun> {
  const wasm = await loaded();
  try {
    return encodeRunIn(wasm, entries);
  } catch (err) {
    afterTrap(err);
    throw err;
  }
}

/**
 * A merge session over `spec`. A trap in it restarts the engine, as any
 * trap does, and the session is gone with the old instance. The caller
 * holds the merge slot, since the module has one session.
 */
export async function openMerge(spec: MergeSpec): Promise<MergeCore> {
  const wasm = await loaded();
  mergeReservedBytes = Math.max(mergeReservedBytes, (spec.sources.length + 1) * spec.chunkBytes);
  const guard = <T>(call: () => T): T => {
    try {
      return call();
    } catch (err) {
      afterTrap(err);
      throw err;
    }
  };
  const core = guard(() => openMergeIn(wasm, spec));
  return {
    pump: () => guard(() => core.pump()),
    feed: (source, bytes) => guard(() => core.feed(source, bytes)),
    close: () => {
      try {
        core.close();
      } catch (err) {
        // The instance trapped and was replaced: nothing is left to close.
        if (!afterTrap(err)) throw err;
      }
    },
  };
}
