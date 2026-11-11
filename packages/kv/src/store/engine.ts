/**
 * Engine-core bridge. Loads a module that implements `crates/engine-abi.md`.
 * The module is required: encoding a run and merging runs have no other
 * implementation, so a context where it does not load cannot flush.
 */
import type { EncodedRun, RunEnd, SstCodec, SstEntry } from "./sst.js";
import { lz4DecompressJs, useLz4Decoder } from "./lz4.js";
import { useBlockScanner } from "./block-scan.js";
import { CorruptDatabaseError, StorageUnavailableError } from "../errors.js";

/**
 * Bytes handed to the module's `init`. A module that reserves once serves
 * every call from this slab and never grows; the Rust module allocates
 * dynamically and ignores it. Sized from a prototype that reserved once,
 * where an encode peaked at 2.75x its input, so a 73 MB flush needs 200 MiB.
 */
const ENGINE_CAPACITY = 1024 * 1024 * 1024;

/** The module could not fit an operation in the capacity it was given. */
export class EngineCapacityError extends Error {
  constructor(op: string, inputBytes: number, capacity: number) {
    super(
      `wasm engine out of capacity in ${op}: input ${inputBytes} bytes, capacity ${capacity} bytes; raise the capacity passed to init`,
    );
    this.name = "EngineCapacityError";
  }
}

const OUT_OF_MEMORY = -11;
const SESSION_OPEN = -13;
const STATUS_NAMES: Record<number, string> = {
  [-1]: "too short",
  [-2]: "bad magic",
  [-3]: "bad version",
  [-4]: "crc mismatch",
  [-5]: "truncated",
  [-6]: "bad tag",
  [-7]: "trailing garbage",
  [-8]: "count mismatch",
  [-9]: "bad codec",
  [-10]: "bad block",
  [-12]: "patterns truncated",
  [-14]: "keys out of order",
};
/** The host broke the session protocol: a bug, not corrupt data. */
const HOST_BUGS: Record<number, string> = {
  [SESSION_OPEN]: "a session is open",
  [-15]: "no session",
  [-16]: "a demand was not fed",
};

const NEED = 1;
const WRITE = 2;
const RUN_END = 3;
const YIELD = 4;
const DONE = 5;
const DEMAND_BYTES = 16;
const RUN_HEAD_BYTES = 16;

type Exports = {
  memory: WebAssembly.Memory;
  init(capacity: number): number;
  input_ptr(len: number): number;
  result_ptr(): number;
  result_len(): number;
  encode_sst(ptr: number, len: number, lz4: number): number;
  decode_sst(ptr: number, len: number): number;
  lz4_decompress(ptr: number, len: number, size: number): number;
  scan_block_contains(ptr: number, len: number, lz4: number, patPtr: number, patLen: number): number;
  merge_open(
    ptr: number,
    len: number,
    drop: number,
    target: number,
    lz4: number,
    chunkBytes: number,
    tailBytes: number,
    yieldBytes: number,
  ): number;
  merge_pump(): number;
  merge_feed(source: number, len: number): number;
  merge_close(): number;
};

/**
 * A compaction merge that the host drives a stop at a time
 * (crates/engine-abi.md, "Merge session"), so it holds a window of each
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
  /** Close an output run once its entries' `entryRecordSize`s reach this. */
  readonly targetBytes: number;
  readonly codec: SstCodec;
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
  | { readonly kind: "done"; readonly droppedSeq: number };

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
 * this is the only place that packs and unpacks them. Results are copied
 * out of wasm memory once, so decoded entries stay valid after later calls.
 */
export type FlatEngine = {
  encodeRun(entries: readonly SstEntry[], lz4: boolean): EncodedRun;
  decodeSst(buf: Uint8Array): SstEntry[];
  lz4Decompress(src: Uint8Array, size: number): Uint8Array;
  scanBlockContains(framed: Uint8Array, lz4: boolean, patterns: Uint8Array): Uint8Array;
  /** The module's merge session. It holds one at a time, so a second open throws: the host takes turns (`inMergeSlot`). */
  openMerge(spec: MergeSpec): MergeCore;
  /** The module's memory. It only grows. */
  memoryBytes(): number;
  /** Whether a merge session is open, from its `openMerge` to its `close`. */
  sessionOpen(): boolean;
};

const TAG_PUT = 1;
const TAG_DEL = 2;
const TWO_32 = 0x1_0000_0000;

export function flatEngine(instance: WebAssembly.Instance, capacity = ENGINE_CAPACITY): FlatEngine {
  const ex = instance.exports as unknown as Exports;
  const status = ex.init(capacity);
  if (status < 0) throw statusError("init", status, 0, capacity);
  let sessionIsOpen = false;

  /** Write `len` bytes through `fill`, run `op`, return a copy of the result. */
  function call(
    name: string,
    len: number,
    fill: (into: Uint8Array) => void,
    op: (ptr: number) => number,
  ): Uint8Array {
    const ptr = ex.input_ptr(len);
    if (ptr === 0 && len > 0) throw new EngineCapacityError(name, len, capacity);
    fill(new Uint8Array(ex.memory.buffer, ptr, len));
    const code = op(ptr);
    if (code < 0) throw statusError(name, code, len, capacity);
    const at = ex.result_ptr();
    return new Uint8Array(ex.memory.buffer).slice(at, at + ex.result_len());
  }

  return {
    encodeRun(entries, lz4) {
      let size = 0;
      for (const e of entries) {
        size += 1 + 8 + 4 + e.key.byteLength + (e.kind === "put" ? 4 + e.value.byteLength : 0);
      }
      const out = call(
        "encode_sst",
        size,
        (into) => {
          const view = new DataView(into.buffer, into.byteOffset, into.byteLength);
          let o = 0;
          for (const e of entries) {
            const seq = e.seq ?? 0;
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
        (ptr) => ex.encode_sst(ptr, size, lz4 ? 1 : 0),
      );
      return readRun(out);
    },

    decodeSst(buf) {
      const out = call("decode_sst", buf.byteLength, (into) => into.set(buf), (ptr) =>
        ex.decode_sst(ptr, buf.byteLength),
      );
      return unpackEntries(out);
    },

    lz4Decompress(src, size) {
      return call("lz4_decompress", src.byteLength, (into) => into.set(src), (ptr) =>
        ex.lz4_decompress(ptr, src.byteLength, size),
      );
    },

    scanBlockContains(framed, lz4, patterns) {
      const len = framed.byteLength + patterns.byteLength;
      return call(
        "scan_block_contains",
        len,
        (into) => {
          into.set(framed);
          into.set(patterns, framed.byteLength);
        },
        (ptr) =>
          ex.scan_block_contains(ptr, framed.byteLength, lz4 ? 1 : 0, ptr + framed.byteLength, patterns.byteLength),
      );
    },

    openMerge(spec) {
      let words = 1;
      let inputBytes = 0;
      for (const runs of spec.sources) {
        words += 1 + runs.length;
        for (const size of runs) inputBytes += size;
      }
      const len = 4 * words;
      // Addresses are u32 and come back as i32: past 2 GiB they read negative.
      const ptr = ex.input_ptr(len) >>> 0;
      if (ptr === 0) throw new EngineCapacityError("merge_open", len, capacity);
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
      const opened = ex.merge_open(
        ptr,
        len,
        spec.dropTombstones ? 1 : 0,
        spec.targetBytes,
        spec.codec === "lz4" ? 1 : 0,
        spec.chunkBytes,
        spec.tailBytes,
        spec.yieldBytes,
      );
      if (opened < 0) throw statusError("merge_open", opened, inputBytes, capacity);
      sessionIsOpen = true;
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
          if (code < 0) throw statusError("merge_pump", code, inputBytes, capacity);
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
              return { kind: "done", droppedSeq: view.getUint32(0, true) + view.getUint32(4, true) * TWO_32 };
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
          sessionIsOpen = false;
          ex.merge_close();
        },
      };
    },

    memoryBytes: () => ex.memory.buffer.byteLength,

    sessionOpen: () => sessionIsOpen,
  };
}

/**
 * A run record (crates/engine-abi.md). The body is a view into `bytes`. The
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

function statusError(op: string, code: number, inputBytes: number, capacity: number): Error {
  if (code === OUT_OF_MEMORY) return new EngineCapacityError(op, inputBytes, capacity);
  const bug = HOST_BUGS[code];
  if (bug) return new Error(`${op}: ${bug} (status ${code})`);
  return new CorruptDatabaseError(`${op}: ${STATUS_NAMES[code] ?? "corrupt"} (status ${code})`);
}

/** Key and value are views into `bytes`, the one copy the call made. */
function unpackEntries(bytes: Uint8Array): SstEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: SstEntry[] = [];
  let o = 0;
  while (o < bytes.byteLength) {
    const tag = view.getUint8(o);
    const seq = view.getUint32(o + 1, true) + view.getUint32(o + 5, true) * TWO_32;
    const keyLen = view.getUint32(o + 9, true);
    const key = bytes.subarray(o + 13, o + 13 + keyLen);
    o += 13 + keyLen;
    if (tag === TAG_PUT) {
      const valueLen = view.getUint32(o, true);
      entries.push({ kind: "put", key, value: bytes.subarray(o + 4, o + 4 + valueLen), seq });
      o += 4 + valueLen;
    } else {
      entries.push({ kind: "del", key, seq });
    }
  }
  return entries;
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

/**
 * A test swaps the engine by setting `globalThis.__OPFS_LSM_ENGINE_URL`
 * (a URL or path of a conformant `.wasm`) before the first engine call in
 * that context; it is read only here.
 */
function engineUrl(): URL {
  const override = (globalThis as { __OPFS_LSM_ENGINE_URL?: unknown }).__OPFS_LSM_ENGINE_URL;
  if (typeof override === "string") return new URL(override, import.meta.url);
  return new URL("../../wasm/engine.wasm", import.meta.url);
}

async function loadWasm(): Promise<FlatEngine> {
  const url = engineUrl();
  // Node/vitest: file:// fetch is broken, so pass bytes. Browser: stream from the URL.
  const bytes = await readWasmBytes(url);
  const module = await WebAssembly.compile((bytes ?? (await fetchWasm(url))) as BufferSource);
  const loaded = flatEngine(await WebAssembly.instantiate(module, {}));
  wasmModule = module;
  return loaded;
}

async function fetchWasm(url: URL): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`engine wasm ${url.href}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function readWasmBytes(wasmUrl: URL): Promise<Uint8Array | undefined> {
  try {
    const g = globalThis as {
      process?: { versions?: { node?: string } };
    };
    if (!g.process?.versions?.node || wasmUrl.protocol !== "file:") return undefined;
    // Avoid hard dependency on @types/node in a browser package.
    const fsMod = "node:fs/promises";
    const urlMod = "node:url";
    const fs = (await import(/* @vite-ignore */ fsMod)) as {
      readFile: (path: string) => Promise<Uint8Array>;
    };
    const url = (await import(/* @vite-ignore */ urlMod)) as {
      fileURLToPath: (u: URL) => string;
    };
    return await fs.readFile(url.fileURLToPath(wasmUrl));
  } catch {
    return undefined;
  }
}

/**
 * Load the module once per context. Rejects with `StorageUnavailableError`
 * when it does not load, and the next call tries again.
 */
export function ensureEngine(): Promise<void> {
  initOnce ??= (async () => {
    try {
      setEngine(await loadWasm());
    } catch (cause) {
      initOnce = undefined;
      const detail = cause instanceof Error ? ` (${cause.message})` : "";
      throw new StorageUnavailableError(`the wasm engine failed to load${detail}`, { cause });
    }
    // They read `engine` at each call: it is replaced when the instance is.
    useLz4Decoder((src, size) => {
      try {
        return engine!.lz4Decompress(src, size);
      } catch (err) {
        if (!afterTrap(err)) throw corrupt(err, "sst lz4 block corrupt");
        // The JS decoder says whether the block is corrupt or the module is wrong.
        return lz4DecompressJs(src, size);
      }
    });
    useBlockScanner((framed, lz4, patterns) => {
      try {
        return engine!.scanBlockContains(framed, lz4, patterns);
      } catch (err) {
        afterTrap(err);
        throw corrupt(err, "sst block corrupt");
      }
    });
  })();
  return initOnce;
}

/** The loaded engine. */
async function loaded(): Promise<FlatEngine> {
  await ensureEngine();
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

/** A bad status means the bytes are corrupt, or the capacity is too small, and is thrown as is. */
function corrupt(err: unknown, what: string): unknown {
  if (err instanceof CorruptDatabaseError || err instanceof EngineCapacityError) return err;
  return new CorruptDatabaseError(`${what}: ${String(err)}`);
}

function restartEngine(): void {
  if (!wasmModule) return;
  try {
    setEngine(flatEngine(new WebAssembly.Instance(wasmModule, {})));
  } catch {
    // No memory for a second instance: the old one stays.
  }
}

export function engineUsingWasm(): boolean {
  return engine !== undefined;
}

/** What this context's wasm engine holds, for `HostStats.memory`. Zero before it loads. */
type EngineMemory = {
  /** The current instance's memory. Talc never gives memory back, so it only grows until a recycle. */
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
 * are copies, and the decoder hooks read `engine` at each call.
 */
export function recycleEngine(maxBytes: number): boolean {
  if (!engine || !wasmModule || engine.sessionOpen() || engine.memoryBytes() <= maxBytes) return false;
  try {
    setEngine(flatEngine(new WebAssembly.Instance(wasmModule, {})));
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
export async function encodeRun(
  entries: readonly SstEntry[],
  codec: SstCodec = "raw",
): Promise<EncodedRun> {
  const wasm = await loaded();
  try {
    return wasm.encodeRun(entries, codec === "lz4");
  } catch (err) {
    afterTrap(err);
    throw err;
  }
}

/** `encodeRun`'s bytes. */
export async function encodeSst(
  entries: readonly SstEntry[],
  codec: SstCodec = "raw",
): Promise<Uint8Array> {
  return (await encodeRun(entries, codec)).body;
}

export async function decodeSst(buf: Uint8Array): Promise<SstEntry[]> {
  const wasm = await loaded();
  try {
    return wasm.decodeSst(buf);
  } catch (err) {
    afterTrap(err);
    throw corrupt(err, "sst corrupt");
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
  const core = guard(() => wasm.openMerge(spec));
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
