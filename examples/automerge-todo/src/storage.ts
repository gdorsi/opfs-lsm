import type { Chunk, StorageAdapterInterface, StorageKey } from "@automerge/react";
import { prefixBound, type Db } from "@opfs-lsm/kv";

/**
 * kv-backed automerge storage. `db` must be an openDb handle that has resolved
 * (its open-time sync guarantees writes acked before open are visible). The
 * adapter owns db afterwards; `close` closes it. No caches, no queues, no key
 * shape assumptions, no sync on the read path.
 */
export function kvStorage(db: Db): StorageAdapterInterface {
  return {
    async load(key) {
      return db.get(encodeKey(key));
    },
    async save(key, data) {
      await db.put(encodeKey(key), data);
    },
    async remove(key) {
      await db.delete(encodeKey(key));
    },
    async loadRange(prefix) {
      const chunks: Chunk[] = [];
      for await (const entry of db.range(prefixBound(encodeKey(prefix)))) {
        chunks.push({ key: decodeKey(entry.key), data: entry.value });
      }
      return chunks;
    },
    async removeRange(prefix) {
      const keys: Uint8Array[] = [];
      for await (const entry of db.range(prefixBound(encodeKey(prefix)))) {
        keys.push(entry.key);
      }
      for (let i = 0; i < keys.length; i += REMOVE_BATCH) {
        const slice = keys.slice(i, i + REMOVE_BATCH);
        await db.batch((tx) => {
          for (const key of slice) tx.delete(key);
        });
      }
    },
    close() {
      return db.close();
    } };
}

const REMOVE_BATCH = 1000;
const MAX_SEGMENT_BYTES = 65_535;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function encodeKey(key: StorageKey): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const segment of key) {
    rejectLoneSurrogate(segment);
    const bytes = textEncoder.encode(segment);
    if (bytes.byteLength > MAX_SEGMENT_BYTES) {
      throw new Error("storage key segment longer than 65535 bytes");
    }
    const frame = new Uint8Array(2 + bytes.byteLength);
    frame[0] = bytes.byteLength >> 8;
    frame[1] = bytes.byteLength & 0xff;
    frame.set(bytes, 2);
    parts.push(frame);
    total += frame.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function decodeKey(bytes: Uint8Array): StorageKey {
  const key: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 2 > bytes.byteLength) {
      throw new Error("truncated storage key");
    }
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    offset += 2;
    if (offset + length > bytes.byteLength) {
      throw new Error("truncated storage key");
    }
    let segment: string;
    try {
      segment = textDecoder.decode(bytes.subarray(offset, offset + length));
    } catch {
      throw new Error("implausible storage key frame");
    }
    key.push(segment);
    offset += length;
  }
  return key;
}

function rejectLoneSurrogate(segment: string): void {
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = segment.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      throw new Error("lone surrogate in storage key segment");
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("lone surrogate in storage key segment");
    }
  }
}
