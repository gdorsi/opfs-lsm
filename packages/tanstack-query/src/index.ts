import {
  experimental_createQueryPersister,
  type StoragePersisterOptions,
} from "@tanstack/query-persist-client-core";
import { prefixBound, type Db } from "@opfs-lsm/kv";

const NAMESPACE = 0x71;
const MAX_KEY_BYTES = 8 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * TanStack Query's per-query persister on a kv `Db`. The caller owns `db` and closes it.
 * One persisted query is one kv entry: key `q` + UTF-8 storage key, value the UTF-8 serialized query.
 */
export function createQueryPersister(
  db: Db,
  options: Omit<StoragePersisterOptions<string>, "storage"> = {},
): ReturnType<typeof experimental_createQueryPersister<string>> {
  return experimental_createQueryPersister({
    ...options,
    storage: {
      async getItem(key) {
        const encoded = encodeKey(key);
        // kv rejects a longer key, so no entry has one, and the query falls back to queryFn.
        if (encoded.byteLength > MAX_KEY_BYTES) return null;
        const bytes = await db.get(encoded);
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
    },
  });
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
