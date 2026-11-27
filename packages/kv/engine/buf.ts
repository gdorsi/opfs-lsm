/**
 * Growable byte buffers in linear memory. Nothing in the module is managed
 * by a garbage collector: each buffer and each object is freed by its owner.
 */
import { tryRealloc } from "./alloc";

/** `len` bytes at `ptr`, with room for `cap`. */
@final @unmanaged
export class Bytes {
  ptr: usize = 0;
  len: usize = 0;
  cap: usize = 0;

  /** Room for `cap` bytes in all. False, and nothing changed, when memory cannot grow. */
  tryCapacity(cap: usize): bool {
    if (cap <= this.cap) return true;
    const ptr = tryRealloc(this.ptr, cap);
    if (!ptr) return false;
    this.ptr = ptr;
    this.cap = cap;
    return true;
  }

  /** Room for `extra` more bytes. A growth at least doubles the capacity, to 8 bytes or more. */
  tryReserve(extra: usize): bool {
    const need = this.len + extra;
    if (need <= this.cap) return true;
    return this.tryCapacity(max(max(this.cap << 1, need), 8));
  }

  /** `tryReserve` that traps when memory cannot grow. */
  @inline reserve(extra: usize): void {
    if (this.len + extra > this.cap && !this.tryReserve(extra)) unreachable();
  }

  /** Make it `len` bytes long with exactly the room that takes. New bytes are not zeroed: every caller writes them before reading. */
  tryResize(len: usize): bool {
    if (!this.tryCapacity(len)) return false;
    this.len = len;
    return true;
  }

  @inline clear(): void {
    this.len = 0;
  }

  append(src: usize, n: usize): void {
    this.reserve(n);
    memory.copy(this.ptr + this.len, src, n);
    this.len += n;
  }

  @inline push(b: u8): void {
    this.reserve(1);
    store<u8>(this.ptr + this.len, b);
    this.len += 1;
  }

  @inline pushU16(v: u16): void {
    this.reserve(2);
    store<u16>(this.ptr + this.len, v);
    this.len += 2;
  }

  @inline pushU32(v: u32): void {
    this.reserve(4);
    store<u32>(this.ptr + this.len, v);
    this.len += 4;
  }

  @inline pushU64(v: u64): void {
    this.reserve(8);
    store<u64>(this.ptr + this.len, v);
    this.len += 8;
  }

  /** The `i`th u32 of a buffer used as a `u32` array. */
  @inline u32(i: usize): u32 {
    return load<u32>(this.ptr + (i << 2));
  }

  @inline setU32(i: usize, v: u32): void {
    store<u32>(this.ptr + (i << 2), v);
  }

  /** How many u32s a buffer used as a `u32` array holds. */
  @inline get count(): usize {
    return this.len >> 2;
  }

  /** Swap the bytes of two buffers, so each keeps a capacity it can reuse. */
  swap(other: Bytes): void {
    const ptr = this.ptr;
    const len = this.len;
    const cap = this.cap;
    this.ptr = other.ptr;
    this.len = other.len;
    this.cap = other.cap;
    other.ptr = ptr;
    other.len = len;
    other.cap = cap;
  }

  free(): void {
    if (this.ptr) heap.free(this.ptr);
    heap.free(changetype<usize>(this));
  }
}

/** Lexicographic order of two byte strings: negative, zero or positive. */
export function compareBytes(a: usize, an: usize, b: usize, bn: usize): i32 {
  const n = min(an, bn);
  let i: usize = 0;
  while (i + 8 <= n) {
    const x = load<u64>(a + i);
    const y = load<u64>(b + i);
    if (x != y) return bswap<u64>(x) < bswap<u64>(y) ? -1 : 1;
    i += 8;
  }
  while (i < n) {
    const x = load<u8>(a + i);
    const y = load<u8>(b + i);
    if (x != y) return x < y ? -1 : 1;
    i += 1;
  }
  return an < bn ? -1 : an > bn ? 1 : 0;
}

@inline
export function equalBytes(a: usize, an: usize, b: usize, bn: usize): bool {
  return an == bn && compareBytes(a, an, b, bn) == 0;
}

/** How many leading bytes `a` and `b` share. */
export function commonPrefix(a: usize, an: usize, b: usize, bn: usize): usize {
  const n = min(an, bn);
  let i: usize = 0;
  while (i + 8 <= n) {
    const x = load<u64>(a + i) ^ load<u64>(b + i);
    if (x) return i + <usize>(ctz<u64>(x) >> 3);
    i += 8;
  }
  while (i < n && load<u8>(a + i) == load<u8>(b + i)) i += 1;
  return i;
}
