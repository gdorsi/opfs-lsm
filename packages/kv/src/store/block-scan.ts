import { CorruptDatabaseError } from "../errors.js";
import { BlockEntry, NO_PREFIX } from "./cursor.js";

/**
 * Scans one data block and returns the puts whose value holds every pattern
 * as `u32 keyLen, u32 valueLen, u64 seq, key, value` records. `patterns` is
 * each pattern as a u32 length then its bytes.
 */
type BlockScanner = (block: Uint8Array, patterns: Uint8Array) => Uint8Array;

/** Set once the wasm engine loads, which `openDb` waits for before any read. */
let wasmScanner!: BlockScanner;

export function useBlockScanner(scanner: BlockScanner): void {
  wasmScanner = scanner;
}

export function blockScanner(): BlockScanner {
  return wasmScanner;
}

export function packPatterns(patterns: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(patterns.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  let o = 0;
  for (const p of patterns) {
    view.setUint32(o, p.length, true);
    out.set(p, o + 4);
    o += 4 + p.length;
  }
  return out;
}

export function* unpackHits(hits: Uint8Array): Generator<BlockEntry> {
  const view = new DataView(hits.buffer, hits.byteOffset, hits.byteLength);
  let o = 0;
  while (o < hits.length) {
    if (o + 16 > hits.length) throw new CorruptDatabaseError("sst scan hits truncated");
    const keyLen = view.getUint32(o, true);
    const valueLen = view.getUint32(o + 4, true);
    const seqAt = o + 8;
    o += 16;
    if (o + keyLen + valueLen > hits.length) throw new CorruptDatabaseError("sst scan hits truncated");
    yield new BlockEntry(hits, "put", seqAt, o + keyLen, valueLen, NO_PREFIX, o, keyLen);
    o += keyLen + valueLen;
  }
}
