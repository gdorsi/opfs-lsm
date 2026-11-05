/**
 * WASM engine-core bridge. Falls back to the TS SST codec if wasm is missing
 * (e.g. before `pnpm run build:wasm`).
 */
import type { SstCodec, SstEntry } from "./sst.js";
import * as sstTs from "./sst.js";
import { foldEntries } from "./fold.js";
import { useLz4Decoder } from "./lz4.js";

type WasmMod = {
  default: (module_or_path?: unknown) => Promise<unknown>;
  encode_sst_js: (entries: unknown, lz4: boolean) => Uint8Array;
  decode_sst_js: (buf: Uint8Array) => unknown[];
  lz4_decompress_js: (src: Uint8Array, size: number) => Uint8Array;
  merge_ssts_js: (
    blobs: unknown,
    dropTombstones: boolean,
    targetBytes: number,
    lz4: boolean,
  ) => { ssts: Uint8Array[]; droppedSeq: number };
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
      const mod = wasm;
      if (mod) useLz4Decoder((src, size) => mod.lz4_decompress_js(src, size));
    })();
  }
  await initOnce;
}

export function engineUsingWasm(): boolean {
  return wasm !== undefined;
}

/** Without wasm, every run is written raw: readers take either codec. */
export async function encodeSst(
  entries: readonly SstEntry[],
  codec: SstCodec = "raw",
): Promise<Uint8Array> {
  await ensureEngine();
  if (!wasm) return sstTs.encodeSst(entries);
  const arr = entries.map((e) =>
    e.kind === "put"
      ? { kind: "put", key: e.key, value: e.value, seq: e.seq ?? 0 }
      : { kind: "del", key: e.key, seq: e.seq ?? 0 },
  );
  return wasm.encode_sst_js(arr, codec === "lz4");
}

export async function decodeSst(buf: Uint8Array): Promise<SstEntry[]> {
  await ensureEngine();
  if (!wasm) return sstTs.decodeSst(buf);
  const rows = wasm.decode_sst_js(buf) as {
    kind: string;
    key: Uint8Array;
    value?: Uint8Array;
    seq: number;
  }[];
  return rows.map((r) => {
    if (r.kind === "put") {
      return {
        kind: "put" as const,
        key: new Uint8Array(r.key),
        value: new Uint8Array(r.value!),
        seq: r.seq,
      };
    }
    return { kind: "del" as const, key: new Uint8Array(r.key), seq: r.seq };
  });
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
  if (wasm) {
    return wasm.merge_ssts_js([...blobsNewestFirst], dropTombstones, targetBytes, codec === "lz4");
  }
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
