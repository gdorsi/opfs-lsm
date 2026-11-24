/** Unsigned bytewise compare. Negative if a < b. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** `compareBytes` of two keys whose first `from` bytes are equal. */
export function compareFrom(a: Uint8Array, b: Uint8Array, from: number): number {
  const n = Math.min(a.length, b.length);
  for (let i = from; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** How many leading bytes `a` and `b` share. */
export function sharedPrefix(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * A read hands out each key and value as a copy, and a write keeps a copy of
 * each key and value it is given. Chrome and Node keep an array of at most 64 bytes on the
 * JS heap and give a longer one its own buffer, which costs several times the
 * copy, so a copy of up to `POOLED` bytes is a view of a shared `POOL_BYTES`
 * buffer, as Node's Buffer pool does. Like Node's, each copy starts at a
 * multiple of 8, so any typed array fits over it. A Node Buffer's `slice` is
 * a view, so a short copy uses the constructor.
 */
const POOLED = 1024;
const POOL_BYTES = 8192;
/**
 * A copier with a pool of its own. Reads and writes each keep one, so an app
 * that transfers the buffer of a value it read detaches no stored value.
 */
export function pooledCopier(): (src: Uint8Array) => Uint8Array {
  let pool = new Uint8Array(0);
  let used = 0;
  return (src) => {
    const n = src.length;
    if (n <= 64 || n > POOLED) return new Uint8Array(src);
    if (used + n > pool.length) {
      pool = new Uint8Array(POOL_BYTES);
      used = 0;
    }
    const at = used;
    used = (at + n + 7) & ~7;
    pool.set(src, at);
    return pool.subarray(at, at + n);
  };
}

/** A copy of `src` to hand out. Its buffer may hold other copies: it starts at `byteOffset`. */
export const copyOut = pooledCopier();

/** A copy of `src` to store. Its buffer may hold other stored keys and values. */
export const copyIn = pooledCopier();

/** Smallest key strictly after every key that starts with `prefix`. */
export function successor(prefix: Uint8Array): Uint8Array | undefined {
  const out = new Uint8Array(prefix);
  for (let i = out.length - 1; i >= 0; i--) {
    const v = out[i]!;
    if (v < 0xff) {
      out[i] = v + 1;
      return out.slice(0, i + 1);
    }
  }
  return undefined;
}

export function keyToString(key: Uint8Array): string {
  // Stable map key for in-memory overlays (hex).
  let s = "";
  for (let i = 0; i < key.length; i++) {
    s += (key[i] ?? 0).toString(16).padStart(2, "0");
  }
  return s;
}

/** True when `hay` holds `needle` as a contiguous run of bytes. */
function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0];
  if (first === undefined) return true;
  const last = hay.length - needle.length;
  for (let i = hay.indexOf(first); i >= 0 && i <= last; i = hay.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}

export function containsAll(hay: Uint8Array, needles: readonly Uint8Array[]): boolean {
  for (const needle of needles) if (!containsBytes(hay, needle)) return false;
  return true;
}
