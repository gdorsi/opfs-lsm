/**
 * The wasm engine, loaded the way the engine loads it, with its raw exports
 * for the differential tests and its memory registered with `bounded`.
 */
import { ensureEngine, engineUsingWasm } from "../src/store/engine.js";
import { useBlockScanner } from "../src/store/block-scan.js";
import { useLz4Decoder } from "../src/store/lz4.js";
import { watchWasmMemory } from "./targets.js";

export type WasmExports = {
  decode_sst_js(buf: Uint8Array): { kind: string; key: Uint8Array; value?: Uint8Array; seq: number }[];
  encode_sst_js(entries: unknown[], lz4: boolean): Uint8Array;
  lz4_decompress_js(src: Uint8Array, size: number): Uint8Array;
  scan_block_contains_js(framed: Uint8Array, lz4: boolean, patterns: Uint8Array): Uint8Array;
  merge_ssts_js(blobs: Uint8Array[], drop: boolean, target: number, lz4: boolean): { ssts: Uint8Array[]; droppedSeq: number };
};

export async function loadWasm(): Promise<WasmExports> {
  await ensureEngine();
  if (!engineUsingWasm()) throw new Error("wasm did not load: run `pnpm --filter @opfs-lsm/kv build:wasm`");
  const mod = (await import("../wasm/engine_wasm.js")) as unknown as WasmExports & {
    default: () => Promise<{ memory: WebAssembly.Memory }>;
  };
  const { memory } = await mod.default();
  watchWasmMemory(() => memory.buffer.byteLength);
  return mod;
}

/**
 * Run `fn` with the TypeScript fallbacks a tab uses before wasm loads: the
 * LZ4 decoder and the block scanner.
 */
export async function withoutWasm<T>(fn: () => Promise<T>): Promise<T> {
  const lz4 = useLz4Decoder(undefined);
  const scan = useBlockScanner(undefined);
  try {
    return await fn();
  } finally {
    useLz4Decoder(lz4);
    useBlockScanner(scan);
  }
}
