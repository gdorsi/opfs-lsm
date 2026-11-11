/**
 * Classic Bloom filter (double hashing). A point get consults it before
 * decoding the one block that might hold the key.
 */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function fnv1a(data: Uint8Array): number {
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

/** ~1% false-positive with 10 bits/key → k ≈ 7. */
function bloomParams(
  keyCount: number,
  bitsPerKey = 10,
): { bitCount: number; hashCount: number } {
  const n = Math.max(1, keyCount);
  const bitCount = Math.max(64, n * bitsPerKey);
  const hashCount = Math.max(1, Math.round((bitsPerKey * Math.LN2)));
  return { bitCount, hashCount };
}

export function createBloom(keyCount: number, bitsPerKey = 10): BloomFilter {
  const { bitCount, hashCount } = bloomParams(keyCount, bitsPerKey);
  return {
    bits: new Uint8Array(Math.ceil(bitCount / 8)),
    hashCount,
  };
}

function bitLen(bits: Uint8Array): number {
  return bits.byteLength * 8;
}

function setBit(bits: Uint8Array, i: number): void {
  const idx = i >>> 3;
  bits[idx] = (bits[idx] ?? 0) | (1 << (i & 7));
}

function getBit(bits: Uint8Array, i: number): boolean {
  const idx = i >>> 3;
  return ((bits[idx] ?? 0) & (1 << (i & 7))) !== 0;
}

function bloomIndex(h1: number, h2: number, i: number, m: number): number {
  return ((h1 + Math.imul(i, h2)) >>> 0) % m;
}

export function bloomAdd(filter: BloomFilter, key: Uint8Array): void {
  const m = bitLen(filter.bits);
  const h1 = fnv1a(key);
  const h2 = mix(h1) | 1;
  for (let i = 0; i < filter.hashCount; i++) {
    setBit(filter.bits, bloomIndex(h1, h2, i, m));
  }
}

export function bloomMightContain(filter: BloomFilter, key: Uint8Array): boolean {
  const m = bitLen(filter.bits);
  const h1 = fnv1a(key);
  const h2 = mix(h1) | 1;
  for (let i = 0; i < filter.hashCount; i++) {
    if (!getBit(filter.bits, bloomIndex(h1, h2, i, m))) return false;
  }
  return true;
}
