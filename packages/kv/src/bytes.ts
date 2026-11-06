/** Unsigned bytewise compare. Negative if a < b. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

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
