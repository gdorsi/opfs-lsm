/**
 * The wasm engine, instantiated here from the same bytes `engine.ts` loads,
 * so the differential tests call it directly (its errors are not wrapped
 * into fallbacks) and its memory is registered with `bounded`.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ensureEngine, engineUsingWasm, flatEngine, type FlatEngine } from "../src/store/engine.js";
import { useBlockScanner } from "../src/store/block-scan.js";
import { useLz4Decoder } from "../src/store/lz4.js";
import { watchWasmMemory } from "./targets.js";

export type { FlatEngine };

export async function loadWasm(): Promise<FlatEngine> {
  await ensureEngine();
  if (!engineUsingWasm()) throw new Error("wasm did not load: run `pnpm --filter @opfs-lsm/kv build:wasm`");
  const bytes = await readFile(fileURLToPath(new URL("../wasm/engine.wasm", import.meta.url)));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const { memory } = instance.exports as { memory: WebAssembly.Memory };
  watchWasmMemory(() => memory.buffer.byteLength);
  return flatEngine(instance);
}

/**
 * Run `fn` with the JS decoders in place of the wasm ones: the
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
