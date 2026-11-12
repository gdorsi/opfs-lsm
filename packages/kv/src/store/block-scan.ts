import { CorruptDatabaseError } from "../errors.js";

/**
 * Scans one data block, framed as the run's block index frames it, and returns
 * the puts not expired at `now` (epoch ms) whose value holds every pattern as
 * `u32 keyLen, u32 valueLen, key, value` records. `patterns` is each pattern
 * as a u32 length then its bytes.
 */
type BlockScanner = (framed: Uint8Array, lz4: boolean, patterns: Uint8Array, now: number) => Uint8Array;

/** Set once the wasm engine loads. Without it a run is scanned through its cursor. */
let wasmScanner: BlockScanner | undefined;

/** Returns the scanner it replaced. */
export function useBlockScanner(scanner: BlockScanner | undefined): BlockScanner | undefined {
  const prev = wasmScanner;
  wasmScanner = scanner;
  return prev;
}

export function blockScanner(): BlockScanner | undefined {
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

export function* unpackHits(hits: Uint8Array): Generator<{ key: Uint8Array; value: Uint8Array }> {
  const view = new DataView(hits.buffer, hits.byteOffset, hits.byteLength);
  let o = 0;
  while (o < hits.length) {
    if (o + 8 > hits.length) throw new CorruptDatabaseError("sst scan hits truncated");
    const keyLen = view.getUint32(o, true);
    const valueLen = view.getUint32(o + 4, true);
    o += 8;
    if (o + keyLen + valueLen > hits.length) throw new CorruptDatabaseError("sst scan hits truncated");
    yield { key: hits.slice(o, o + keyLen), value: hits.slice(o + keyLen, o + keyLen + valueLen) };
    o += keyLen + valueLen;
  }
}
