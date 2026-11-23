/** Bloom filter matching `packages/kv/src/store/bloom.ts`. */
import { Bytes } from "./buf";

const FNV_OFFSET: u32 = 2166136261;
const FNV_PRIME: u32 = 16777619;
const BITS_PER_KEY: usize = 10;
/** round(BITS_PER_KEY * ln 2). */
export const HASH_COUNT: u32 = 7;

/**
 * The one hash a key contributes to a filter: every probe derives from it,
 * so a writer can keep 4 bytes per key and build the filter at the end.
 */
export function keyHash(p: usize, n: usize): u32 {
  let h = FNV_OFFSET;
  const end = p + n;
  while (p < end) {
    h = (h ^ load<u8>(p)) * FNV_PRIME;
    p += 1;
  }
  return h;
}

function mix(h: u32): u32 {
  h ^= h >> 16;
  h *= 0x7feb352d;
  h ^= h >> 15;
  h *= 0x846ca68b;
  h ^= h >> 16;
  return h;
}

/**
 * Append to `out` the filter bits of the keys whose `keyHash`es `hashes`
 * holds, as u32s, and return how many bytes they take.
 */
export function appendBloom(out: Bytes, hashes: Bytes): usize {
  const keys = hashes.count;
  const bitCount = max(max<usize>(keys, 1) * BITS_PER_KEY, 64);
  const len = (bitCount + 7) >> 3;
  out.reserve(len);
  const bits = out.ptr + out.len;
  memory.fill(bits, 0, len);
  out.len += len;
  const m = <u32>(len << 3);
  for (let k: usize = 0; k < keys; k++) {
    const h1 = hashes.u32(k);
    const h2 = mix(h1) | 1;
    for (let i: u32 = 0; i < HASH_COUNT; i++) {
      const at = (h1 + i * h2) % m;
      const byte = bits + (at >> 3);
      store<u8>(byte, load<u8>(byte) | (<u8>1 << <u8>(at & 7)));
    }
  }
  return len;
}
