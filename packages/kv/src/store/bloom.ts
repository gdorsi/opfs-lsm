/**
 * Classic Bloom filter (double hashing), read here. A point get consults it
 * before decoding the one block that might hold the key. The wasm encoder
 * builds it.
 */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** The hash of `key` that every run's filter is probed with, so a read of several runs hashes its key once. */
export function bloomHash(data: Uint8Array): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < data.byteLength; i++) {
    h ^= data[i] ?? 0;
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export type BloomFilter = {
  readonly bits: Uint8Array;
  readonly hashCount: number;
};

/**
 * Probe i tests bit `(h1 + i * h2) mod 2^32 mod m`, as the encoder set it.
 * `h` holds that sum and `m` the bit count, both as u32: with a `>>> 0` on
 * each operand V8 takes the remainder of two integers. Without it the
 * remainder is of two doubles, which costs several times the rest of the probe.
 */
export function bloomMightContain(filter: BloomFilter, hash: number): boolean {
  const { bits } = filter;
  const m = (bits.byteLength * 8) >>> 0;
  let h = hash;
  const h2 = mix(h) | 1;
  for (let i = 0; i < filter.hashCount; i++) {
    const bit = h % m;
    if (((bits[bit >>> 3] ?? 0) & (1 << (bit & 7))) === 0) return false;
    h = (h + h2) >>> 0;
  }
  return true;
}
