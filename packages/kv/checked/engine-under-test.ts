/**
 * The engine as tests, fuzzers and the gate open it: the shipped build, or
 * its checked twin (checked/build.ts), whose only imports are the shadow's
 * (checked/shadow.ts). Both take the same calls (packages/kv/engine/abi.md).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineExports } from "../src/store/engine.js";
import { createShadow } from "./shadow.ts";

export { takeCheckedReports } from "./shadow.ts";

const KV = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SHIPPED = join(KV, "wasm/engine.wasm");
/** Where checked/build.ts writes. `KV_CHECKED_DIR` points the suites at another build, such as a planted bug's. */
export const CHECKED_DIR = join(KV, "checked/.build");
export const checkedFile = (name: "engine.wasm" | "alloc.wasm" | "capped.wasm") => join(process.env.KV_CHECKED_DIR || CHECKED_DIR, name);

export function openShipped(wasm: BufferSource = readFileSync(SHIPPED)): EngineExports {
  return new WebAssembly.Instance(new WebAssembly.Module(wasm), {}).exports as unknown as EngineExports;
}

export type CheckedEngine = {
  readonly exports: EngineExports;
  /** The largest block asked for since open, refused ones included. */
  largestAllocation(): number;
  /** Instrumented loads, stores, copies, fills and edges run since open. The same calls give the same count. */
  work(): number;
};

/** A fresh twin. `coverage` gets the number of edges and returns the counters to bump. */
export function openChecked(opts: { wasm?: BufferSource; coverage?: (edges: number) => Uint8Array } = {}): CheckedEngine {
  const { imports, largestAllocation, work } = createShadow(opts.coverage);
  const module = new WebAssembly.Module(opts.wasm ?? readFileSync(checkedFile("engine.wasm")));
  const exports = new WebAssembly.Instance(module, imports).exports as unknown as EngineExports;
  return { exports, largestAllocation, work };
}

/** For the bridge under `KV_ENGINE=checked` (tests/setup.ts): how to read the twin, and what each instance of it imports. */
export const checkedForBridge = {
  read: async (): Promise<BufferSource> => readFileSync(checkedFile("engine.wasm")),
  imports: (): WebAssembly.Imports => createShadow().imports,
};
