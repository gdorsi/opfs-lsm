/**
 * The wasm engine (its checked twin under `KV_ENGINE=checked`), instantiated here,
 * so the differential tests call it directly and its memory is registered
 * with `bounded`.
 */
import { ensureEngine, flatEngine, type FlatEngine } from "../src/store/engine.js";
import { watchWasmMemory } from "./targets.js";
import { openChecked, openShipped } from "../checked/engine-under-test.ts";

export type { FlatEngine };

export async function loadWasm(): Promise<FlatEngine> {
  await ensureEngine();
  const exports = process.env.KV_ENGINE === "checked" ? openChecked().exports : openShipped();
  watchWasmMemory(() => exports.memory.buffer.byteLength);
  return flatEngine({ exports });
}
