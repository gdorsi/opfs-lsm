import type { AsyncStorage } from "@tanstack/query-persist-client-core";
import { prefixBound, type Db } from "@opfs-lsm/kv";

const NAMESPACE = 0x71;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * TanStack Query persister storage on a kv `Db`. The caller owns `db` and closes it.
 * One storage item is one kv entry: key `q` + UTF-8 key, value the UTF-8 string.
 */
export function kvStorage(db: Db): Required<AsyncStorage<string>> {
  return {
    async getItem(key) {
      const bytes = await db.get(encodeKey(key));
      return bytes === undefined ? null : decoder.decode(bytes);
    },

    async setItem(key, value) {
      await db.put(encodeKey(key), encodeText(value));
    },

    async removeItem(key) {
      await db.delete(encodeKey(key));
    },

    async entries() {
      const out: [string, string][] = [];
      for await (const entry of db.range(prefixBound(Uint8Array.of(NAMESPACE)))) {
        out.push([decoder.decode(entry.key.subarray(1)), decoder.decode(entry.value)]);
      }
      return out;
    },
  };
}

function encodeKey(key: string): Uint8Array {
  const bytes = encodeText(key);
  const out = new Uint8Array(1 + bytes.length);
  out[0] = NAMESPACE;
  out.set(bytes, 1);
  return out;
}

function encodeText(text: string): Uint8Array {
  if (!text.isWellFormed()) {
    throw new Error("TanStack Query storage text has a lone surrogate and cannot round-trip through UTF-8");
  }
  return encoder.encode(text);
}
