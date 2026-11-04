/**
 * WASM engine-core bridge. Falls back to the TS SST codec if wasm is missing
 * (e.g. before `pnpm run build:wasm`).
 */
import type { SstEntry } from "./sst.js";
import * as sstTs from "./sst.js";
import { foldEntries } from "./fold.js";

type WasmMod = {
  default: (module_or_path?: unknown) => Promise<unknown>;
  encode_sst_js: (entries: unknown) => Uint8Array;
  decode_sst_js: (buf: Uint8Array) => unknown[];
  merge_ssts_js: (blobs: unknown) => Uint8Array;
  plan_l0_compaction_js: (
    runs: unknown,
  ) => { inputs: string[]; keep: string[] } | null;
  l0_compact_threshold: () => number;
};

let wasm: WasmMod | undefined;
let initOnce: Promise<void> | undefined;

async function loadWasm(): Promise<WasmMod | undefined> {
  try {
    const mod = (await import("../../wasm/engine_wasm.js")) as unknown as WasmMod;
    const wasmUrl = new URL("../../wasm/engine_wasm_bg.wasm", import.meta.url);
    // Node/vitest: file:// fetch is broken — pass bytes. Browser: URL is fine.
    const bytes = await readWasmBytes(wasmUrl);
    if (bytes) {
      await mod.default({ module_or_path: bytes });
    } else {
      await mod.default({ module_or_path: wasmUrl });
    }
    return mod;
  } catch (err) {
    const env = (globalThis as { process?: { env?: Record<string, string> } })
      .process?.env;
    if (env?.OPFS_LSM_DEBUG_WASM) {
      console.error("wasm load failed", err);
    }
    return undefined;
  }
}

async function readWasmBytes(wasmUrl: URL): Promise<Uint8Array | undefined> {
  try {
    const g = globalThis as {
      process?: { versions?: { node?: string } };
    };
    if (!g.process?.versions?.node) return undefined;
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
      wasm = await loadWasm();
    })();
  }
  await initOnce;
}

export function engineUsingWasm(): boolean {
  return wasm !== undefined;
}

export async function encodeSst(entries: readonly SstEntry[]): Promise<Uint8Array> {
  await ensureEngine();
  if (!wasm) return sstTs.encodeSst(entries);
  const arr = entries.map((e) =>
    e.kind === "put"
      ? { kind: "put", key: e.key, value: e.value }
      : { kind: "del", key: e.key },
  );
  return wasm.encode_sst_js(arr);
}

export async function decodeSst(buf: Uint8Array): Promise<SstEntry[]> {
  await ensureEngine();
  if (!wasm) return sstTs.decodeSst(buf);
  const rows = wasm.decode_sst_js(buf) as {
    kind: string;
    key: Uint8Array;
    value?: Uint8Array;
  }[];
  return rows.map((r) => {
    if (r.kind === "put") {
      return {
        kind: "put" as const,
        key: new Uint8Array(r.key),
        value: new Uint8Array(r.value!),
      };
    }
    return { kind: "del" as const, key: new Uint8Array(r.key) };
  });
}

export async function mergeSsts(
  blobsNewestFirst: readonly Uint8Array[],
): Promise<Uint8Array> {
  await ensureEngine();
  if (!wasm) {
    const groups = blobsNewestFirst.map((blob) => sstTs.decodeSst(blob));
    return sstTs.encodeSst(foldEntries(groups));
  }
  return wasm.merge_ssts_js([...blobsNewestFirst]);
}

export async function planL0Compaction(
  runs: readonly string[],
): Promise<{ inputs: string[]; keep: string[] } | undefined> {
  await ensureEngine();
  if (!wasm) {
    const l0 = runs.filter((p) => p.startsWith("l0/"));
    if (l0.length < 4) return undefined;
    return {
      inputs: [...l0],
      keep: runs.filter((p) => !p.startsWith("l0/")),
    };
  }
  const plan = wasm.plan_l0_compaction_js([...runs]);
  return plan ?? undefined;
}

export async function l0CompactThreshold(): Promise<number> {
  await ensureEngine();
  return wasm?.l0_compact_threshold() ?? 4;
}
