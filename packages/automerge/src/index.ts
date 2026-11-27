import type { Chunk, StorageAdapterInterface, StorageKey } from "@automerge/automerge-repo";
import { ConstraintError, prefixBound, type Db } from "@opfs-lsm/kv";

/**
 * kv-backed automerge storage. No caches, no queues, no key shape
 * assumptions, no sync on the read path. The adapter owns `db`; `close` closes it.
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
      await db.batch((tx) => tx.deleteRange(prefixBound(encodeKey(prefix))));
    },
    close() {
      return db.close();
    },
  };
}

const MAX_SEGMENT_BYTES = 65_535;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });

export function encodeKey(key: StorageKey): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const segment of key) {
    if (!segment.isWellFormed()) {
      throw new Error("lone surrogate in storage key segment");
    }
    const bytes = textEncoder.encode(segment);
    if (bytes.byteLength > MAX_SEGMENT_BYTES) {
      throw new ConstraintError("storage key segment longer than 65535 bytes");
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
