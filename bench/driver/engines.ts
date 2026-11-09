import path from "node:path";
import { BENCH_DIR } from "./build.ts";

/**
 * Contenders that run kv on another engine module, by contender id. The
 * runner serves this file for every `.wasm` request during the run, so the
 * contender file is the same code as the default one.
 */
export const ENGINE_WASM: Readonly<Record<string, string>> = {
  "kv/kv-zig": path.resolve(BENCH_DIR, "../crates/engine-zig/engine_small.wasm"),
};
