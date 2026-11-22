/**
 * The wasm engine (its checked twin under `KV_ENGINE=checked`), instantiated here,
 * so the differential tests call it directly (its errors are not wrapped
 * into fallbacks) and its memory is registered with `bounded`.
 */
import { ensureEngine, flatEngine, type FlatEngine } from "../src/store/engine.js";
import { useBlockScanner } from "../src/store/block-scan.js";
import { watchWasmMemory } from "./targets.js";
import { openChecked, openShipped } from "../checked/engine-under-test.ts";

export type { FlatEngine };

export async function loadWasm(): Promise<FlatEngine> {
  await ensureEngine();
  const exports = process.env.KV_ENGINE === "checked" ? openChecked().exports : openShipped();
  watchWasmMemory(() => exports.memory.buffer.byteLength);
  return flatEngine({ exports });
}

/** Run `fn` with a tab's TypeScript scan in place of the wasm block scanner. */
export async function withoutWasm<T>(fn: () => Promise<T>): Promise<T> {
  const scan = useBlockScanner(undefined);
  try {
    return await fn();
  } finally {
    useBlockScanner(scan);
  }
}
