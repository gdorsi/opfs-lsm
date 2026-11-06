/** One derived kv entry of a row: an index key with an empty value, or the search key with its text. */
export type IndexEntry = { readonly key: Uint8Array; readonly value: Uint8Array };

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length - b.length;
}

function keyId(key: Uint8Array): string {
  return String.fromCharCode(...key);
}

/**
 * What a row change writes: `remove` holds keys of `before` that `after` lacks,
 * `write` holds entries of `after` that are new or whose value changed. An
 * entry present and equal on both sides costs nothing.
 */
export function diffEntries(
  before: readonly IndexEntry[],
  after: readonly IndexEntry[],
): { remove: Uint8Array[]; write: IndexEntry[] } {
  const old = new Map<string, IndexEntry>();
  for (const entry of before) old.set(keyId(entry.key), entry);
  const write: IndexEntry[] = [];
  for (const entry of after) {
    const id = keyId(entry.key);
    const prev = old.get(id);
    if (prev !== undefined) {
      old.delete(id);
      if (sameBytes(prev.value, entry.value)) continue;
    }
    write.push(entry);
  }
  return { remove: [...old.values()].map((entry) => entry.key), write };
}
