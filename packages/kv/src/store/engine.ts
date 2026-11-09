/**
 * Engine-core bridge. Loads a module that implements `crates/engine-abi.md`
 * and falls back to the TS SST codec if it is missing (before the wasm is
 * built) or traps.
 */
import type { SstCodec, SstEntry } from "./sst.js";
import * as sstTs from "./sst.js";
import { foldEntries } from "./fold.js";
import { lz4DecompressJs, useLz4Decoder } from "./lz4.js";
import { useBlockScanner } from "./block-scan.js";
import { CorruptDatabaseError } from "../errors.js";

/**
 * Bytes handed to the module's `init`. A module that reserves once serves
 * every call from this slab and never grows. Measured with the Zig
 * module's `peak_bytes` (crates/engine-zig/README.md): an encode peaks at
 * 2.75x its input bytes and a merge at about 10x its compressed input, so
 * a 73 MB flush needs 200 MiB and a merge of 40 MiB of LZ4 runs about
 * 400 MiB. A module that allocates dynamically ignores this.
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
};

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
  merge_ssts(ptr: number, len: number, drop: number, target: number, lz4: number): number;
};

/**
 * One engine module behind typed calls. Everything crosses as flat bytes;
 * this is the only place that packs and unpacks them. Results are copied
 * out of wasm memory once, so decoded entries stay valid after later calls.
 */
export type FlatEngine = {
  encodeSst(entries: readonly SstEntry[], lz4: boolean): Uint8Array;
  decodeSst(buf: Uint8Array): SstEntry[];
  lz4Decompress(src: Uint8Array, size: number): Uint8Array;
  scanBlockContains(framed: Uint8Array, lz4: boolean, patterns: Uint8Array): Uint8Array;
  mergeSsts(
    blobs: readonly Uint8Array[],
    dropTombstones: boolean,
    targetBytes: number,
    lz4: boolean,
  ): { ssts: Uint8Array[]; droppedSeq: number };
};

const TAG_PUT = 1;
const TAG_DEL = 2;
const TWO_32 = 0x1_0000_0000;

export function flatEngine(instance: WebAssembly.Instance, capacity = ENGINE_CAPACITY): FlatEngine {
  const ex = instance.exports as unknown as Exports;
  const status = ex.init(capacity);
  if (status < 0) throw statusError("init", status, 0, capacity);

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
    encodeSst(entries, lz4) {
      let size = 0;
      for (const e of entries) {
        size += 1 + 8 + 4 + e.key.byteLength + (e.kind === "put" ? 4 + e.value.byteLength : 0);
      }
      return call(
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

    mergeSsts(blobs, dropTombstones, targetBytes, lz4) {
      let size = 4;
      for (const b of blobs) size += 4 + b.byteLength;
      const out = call(
        "merge_ssts",
        size,
        (into) => {
          const view = new DataView(into.buffer, into.byteOffset, into.byteLength);
          view.setUint32(0, blobs.length, true);
          let o = 4;
          for (const b of blobs) {
            view.setUint32(o, b.byteLength, true);
            into.set(b, o + 4);
            o += 4 + b.byteLength;
          }
        },
        (ptr) => ex.merge_ssts(ptr, size, dropTombstones ? 1 : 0, targetBytes, lz4 ? 1 : 0),
      );
      const view = new DataView(out.buffer);
      const droppedSeq = view.getUint32(0, true) + view.getUint32(4, true) * TWO_32;
      const count = view.getUint32(8, true);
      const ssts: Uint8Array[] = [];
      let o = 12;
      for (let i = 0; i < count; i++) {
        const len = view.getUint32(o, true);
        ssts.push(out.subarray(o + 4, o + 4 + len));
        o += 4 + len;
      }
      return { ssts, droppedSeq };
    },
  };
}

function statusError(op: string, code: number, inputBytes: number, capacity: number): Error {
  if (code === OUT_OF_MEMORY) return new EngineCapacityError(op, inputBytes, capacity);
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
let initOnce: Promise<void> | undefined;

/**
 * Benchmarks swap the engine by setting `globalThis.__OPFS_LSM_ENGINE_URL`
 * (a URL or path of a conformant `.wasm`) before the first engine call in
 * that context; it is read only here.
 */
function engineUrl(): URL {
  const override = (globalThis as { __OPFS_LSM_ENGINE_URL?: unknown }).__OPFS_LSM_ENGINE_URL;
  if (typeof override === "string") return new URL(override, import.meta.url);
  return new URL("../../wasm/engine.wasm", import.meta.url);
}

async function loadWasm(): Promise<FlatEngine | undefined> {
  try {
    const url = engineUrl();
    // Node/vitest: file:// fetch is broken, so pass bytes. Browser: stream from the URL.
    const bytes = await readWasmBytes(url);
    const module = await WebAssembly.compile((bytes ?? (await fetchWasm(url))) as BufferSource);
    return flatEngine(await WebAssembly.instantiate(module, {}));
  } catch (err) {
    const env = (globalThis as { process?: { env?: Record<string, string> } })
      .process?.env;
    if (env?.OPFS_LSM_DEBUG_WASM) {
      console.error("wasm load failed", err);
    }
    return undefined;
  }
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

export async function ensureEngine(): Promise<void> {
  if (!initOnce) {
    initOnce = (async () => {
      engine = await loadWasm();
      const mod = engine;
      if (mod) {
        useLz4Decoder((src, size) => {
          try {
            return mod.lz4Decompress(src, size);
          } catch (err) {
            return afterWasmError(err, "sst lz4 block corrupt", () => lz4DecompressJs(src, size));
          }
        });
        useBlockScanner((framed, lz4, patterns) => {
          try {
            return mod.scanBlockContains(framed, lz4, patterns);
          } catch (err) {
            if (err instanceof WebAssembly.RuntimeError) dropWasm();
            if (err instanceof CorruptDatabaseError || err instanceof EngineCapacityError) throw err;
            throw new CorruptDatabaseError(`sst block corrupt: ${String(err)}`);
          }
        });
      }
    })();
  }
  await initOnce;
}

/**
 * Stop using wasm in this context. A trap does not unwind, so the trapped
 * call's frames stay on the instance's shadow stack: a few thousand traps use
 * it up and every later call fails. The TypeScript codec takes over instead.
 */
function dropWasm(): void {
  engine = undefined;
  useLz4Decoder(undefined);
  useBlockScanner(undefined);
}

/**
 * A wasm call over run bytes failed. A bad status means the bytes are
 * corrupt (or the capacity is too small) and is rethrown as is. A trap drops
 * wasm and runs the call again in TypeScript, which gives the honest answer.
 */
function afterWasmError<T>(err: unknown, what: string, fallback: () => T): T {
  if (err instanceof WebAssembly.RuntimeError) {
    dropWasm();
    return fallback();
  }
  if (err instanceof CorruptDatabaseError || err instanceof EngineCapacityError) throw err;
  throw new CorruptDatabaseError(`${what}: ${String(err)}`);
}

export function engineUsingWasm(): boolean {
  return engine !== undefined;
}

/** Without wasm, every run is written raw: readers take either codec. */
export async function encodeSst(
  entries: readonly SstEntry[],
  codec: SstCodec = "raw",
): Promise<Uint8Array> {
  await ensureEngine();
  if (!engine) return sstTs.encodeSst(entries);
  try {
    return engine.encodeSst(entries, codec === "lz4");
  } catch (err) {
    if (!(err instanceof WebAssembly.RuntimeError)) throw err;
    dropWasm();
    return sstTs.encodeSst(entries);
  }
}

export async function decodeSst(buf: Uint8Array): Promise<SstEntry[]> {
  await ensureEngine();
  if (!engine) return sstTs.decodeSst(buf);
  try {
    return engine.decodeSst(buf);
  } catch (err) {
    return afterWasmError(err, "sst corrupt", () => sstTs.decodeSst(buf));
  }
}

/**
 * Merge newest-first runs into runs of about `targetBytes`, in key order,
 * written with `codec` (raw without wasm).
 * With `dropTombstones`, also returns the highest seq among the dropped
 * tombstones, 0 when none was dropped.
 */
export async function mergeSsts(
  blobsNewestFirst: readonly Uint8Array[],
  dropTombstones: boolean,
  targetBytes = Number.MAX_SAFE_INTEGER,
  codec: SstCodec = "raw",
): Promise<{ readonly ssts: readonly Uint8Array[]; readonly droppedSeq: number }> {
  await ensureEngine();
  if (engine) {
    try {
      return engine.mergeSsts(blobsNewestFirst, dropTombstones, targetBytes, codec === "lz4");
    } catch (err) {
      return afterWasmError(err, "sst corrupt", () => mergeSstsTs(blobsNewestFirst, dropTombstones, targetBytes));
    }
  }
  return mergeSstsTs(blobsNewestFirst, dropTombstones, targetBytes);
}

/** `mergeSsts` without wasm: every output run is raw. */
function mergeSstsTs(
  blobsNewestFirst: readonly Uint8Array[],
  dropTombstones: boolean,
  targetBytes: number,
): { readonly ssts: readonly Uint8Array[]; readonly droppedSeq: number } {
  let entries = foldEntries(blobsNewestFirst.map((b) => sstTs.decodeSst(b)));
  let droppedSeq = 0;
  if (dropTombstones) {
    for (const e of entries) {
      if (e.kind === "del") droppedSeq = Math.max(droppedSeq, e.seq ?? 0);
    }
    entries = entries.filter((e) => e.kind === "put");
  }
  const ssts: Uint8Array[] = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < entries.length; i++) {
    size += sstTs.entryRecordSize(entries[i]!);
    if (size >= targetBytes) {
      ssts.push(sstTs.encodeSst(entries.slice(start, i + 1)));
      start = i + 1;
      size = 0;
    }
  }
  if (start < entries.length) ssts.push(sstTs.encodeSst(entries.slice(start)));
  return { ssts, droppedSeq };
}
