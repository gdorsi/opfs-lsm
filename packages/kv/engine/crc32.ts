/** CRC-32 (IEEE), matching packages/kv/src/store/crc32.ts. */

/** Bytes in each of the four lanes `crcUpdate` runs at once. */
const LANE: usize = 64;
const POLY: u32 = 0xedb88320;

/**
 * Twelve tables of 256 u32s, filled on first use: eight for slicing-by-8,
 * then four for what appending `LANE` zero bytes does to a register, one per
 * register byte, which carries a lane's result past the lanes after it.
 * Zeroed static memory takes no bytes in the module.
 */
const TABLES: usize = memory.data(12 << 10, 16);
let ready = false;

@inline function t(s: usize, i: u32): u32 {
  return load<u32>(TABLES + (s << 10) + (<usize>i << 2));
}

function fill(): void {
  for (let i: u32 = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? POLY ^ (c >> 1) : c >> 1;
    store<u32>(TABLES + (<usize>i << 2), c);
  }
  for (let s: usize = 1; s < 8; s++) {
    for (let i: u32 = 0; i < 256; i++) {
      const prev = t(s - 1, i);
      store<u32>(TABLES + (s << 10) + (<usize>i << 2), (prev >> 8) ^ t(0, prev & 0xff));
    }
  }
  // Appending zeros is linear, so its effect on a register is the XOR of its
  // effect on each set bit.
  for (let k: usize = 0; k < 4; k++) {
    const table = TABLES + ((8 + k) << 10);
    store<u32>(table, 0);
    for (let b: u32 = 1; b < 256; b++) {
      const low = b & (0 - b);
      let v: u32;
      if (b == low) {
        v = 1 << ((<u32>k << 3) + ctz(b));
        for (let n: usize = 0; n < LANE; n++) v = (v >> 8) ^ t(0, v & 0xff);
      } else {
        v = load<u32>(table + (<usize>low << 2)) ^ load<u32>(table + (<usize>(b ^ low) << 2));
      }
      store<u32>(table + (<usize>b << 2), v);
    }
  }
  ready = true;
}

@inline function step8(c: u32, p: usize): u32 {
  const lo = load<u32>(p) ^ c;
  const hi = load<u32>(p, 4);
  return (
    t(7, lo & 0xff) ^
    t(6, (lo >> 8) & 0xff) ^
    t(5, (lo >> 16) & 0xff) ^
    t(4, lo >> 24) ^
    t(3, hi & 0xff) ^
    t(2, (hi >> 8) & 0xff) ^
    t(1, (hi >> 16) & 0xff) ^
    t(0, hi >> 24)
  );
}

/** `r` after `LANE` zero bytes. */
@inline function shift(r: u32): u32 {
  return t(8, r & 0xff) ^ t(9, (r >> 8) & 0xff) ^ t(10, (r >> 16) & 0xff) ^ t(11, r >> 24);
}

/**
 * The register `c` after the `n` bytes at `p`, as slicing-by-8 computes it.
 * It runs four `LANE`-byte lanes at once: their lookup chains do not depend
 * on each other, so the CPU overlaps them, and `shift` joins the four
 * results. A lane is short so that a 4 KiB block gains from it.
 */
export function crcUpdate(c: u32, p: usize, n: usize): u32 {
  if (!ready) fill();
  const end = p + n;
  while (end - p >= 4 * LANE) {
    let ra = c;
    let rb: u32 = 0;
    let re: u32 = 0;
    let rd: u32 = 0;
    for (let i: usize = 0; i < LANE; i += 8) {
      ra = step8(ra, p + i);
      rb = step8(rb, p + LANE + i);
      re = step8(re, p + 2 * LANE + i);
      rd = step8(rd, p + 3 * LANE + i);
    }
    c = shift(shift(shift(ra) ^ rb) ^ re) ^ rd;
    p += 4 * LANE;
  }
  while (end - p >= 8) {
    c = step8(c, p);
    p += 8;
  }
  while (p < end) {
    c = t(0, (c ^ load<u8>(p)) & 0xff) ^ (c >> 8);
    p += 1;
  }
  return c;
}

export function crc32(p: usize, n: usize): u32 {
  return ~crcUpdate(~0, p, n);
}

/** `a * b` modulo the CRC-32 polynomial, in its reflected bit order, where bit 31 is x^0. */
function multModP(a: u32, b: u32): u32 {
  let p: u32 = 0;
  for (let i: u32 = 0; i < 32; i++) {
    if (a & (1 << (31 - i))) p ^= b;
    b = b & 1 ? (b >> 1) ^ POLY : b >> 1;
  }
  return p;
}

/**
 * The CRC of `a` followed by `b`, from `crc32(a)`, `crc32(b)` and the length
 * of `b` (zlib's `crc32_combine`). A run read in pieces checks its stored
 * CRC with this: the tail's bytes arrive before the data they follow.
 */
export function crc32Combine(crcA: u32, crcB: u32, lenB: usize): u32 {
  // x^(8 * lenB) by squaring x^8.
  let shift: u32 = 1 << 31;
  let square: u32 = 1 << (31 - 8);
  let n = lenB;
  while (n != 0) {
    if (n & 1) shift = multModP(square, shift);
    square = multModP(square, square);
    n >>= 1;
  }
  return multModP(shift, crcA) ^ crcB;
}
