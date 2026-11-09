import { CorruptDatabaseError } from "../errors.js";

function corrupt(): never {
  throw new CorruptDatabaseError("sst lz4 block corrupt");
}

type Decoder = (src: Uint8Array, size: number) => Uint8Array;

/** Set once the wasm engine loads. It decodes a block about 3x faster. */
let wasmDecoder: Decoder | undefined;

/** Returns the decoder it replaced. */
export function useLz4Decoder(decoder: Decoder | undefined): Decoder | undefined {
  const prev = wasmDecoder;
  wasmDecoder = decoder;
  return prev;
}

/** Unpack one LZ4 block of exactly `size` bytes. */
export function lz4Decompress(src: Uint8Array, size: number): Uint8Array {
  if (!wasmDecoder) return lz4DecompressJs(src, size);
  return wasmDecoder(src, size);
}

/**
 * The largest size `src` can unpack to. LZ4 writes at most 255 bytes per
 * input byte (each match-length byte adds 255), so a larger claimed size
 * is corrupt and must not size a buffer. `lz4_unpack` in
 * `crates/engine-core/src/sst.rs` uses the same bound.
 */
const maxUnpacked = (src: Uint8Array) => 255 * src.byteLength + 16;

/**
 * Decode one LZ4 block (the block format, not the frame format) that
 * unpacks to exactly `size` bytes. The wasm encoder writes these with
 * `lz4_flex::block::compress`.
 */
export function lz4DecompressJs(src: Uint8Array, size: number): Uint8Array {
  if (size > maxUnpacked(src)) corrupt();
  const out = new Uint8Array(size);
  const n = src.length;
  let s = 0;
  let d = 0;
  while (s < n) {
    const token = src[s++]!;
    let lit = token >>> 4;
    if (lit === 15) {
      let b: number;
      do {
        if (s >= n) corrupt();
        b = src[s++]!;
        lit += b;
      } while (b === 255);
    }
    if (s + lit > n || d + lit > size) corrupt();
    if (lit < 32) {
      for (let i = 0; i < lit; i++) out[d + i] = src[s + i]!;
    } else {
      out.set(src.subarray(s, s + lit), d);
    }
    s += lit;
    d += lit;
    if (s === n) break;

    if (s + 2 > n) corrupt();
    const offset = src[s]! | (src[s + 1]! << 8);
    s += 2;
    if (offset === 0 || offset > d) corrupt();
    let len = token & 15;
    if (len === 15) {
      let b: number;
      do {
        if (s >= n) corrupt();
        b = src[s++]!;
        len += b;
      } while (b === 255);
    }
    len += 4;
    if (d + len > size) corrupt();
    let m = d - offset;
    if (offset >= len && len >= 32) {
      out.copyWithin(d, m, m + len);
      d += len;
    } else {
      // A match may overlap the bytes it is writing, so copy one at a time.
      const end = d + len;
      while (d < end) out[d++] = out[m++]!;
    }
  }
  if (d !== size) corrupt();
  return out;
}
