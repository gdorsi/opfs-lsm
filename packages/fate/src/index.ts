import type { PersistenceStorage } from "@nkzw/fate/persistence";
import { prefixBound, type ChangeOp, type Db } from "@opfs-lsm/kv";

const NAMESPACE = 0x66;
const MAX_LOCK_NAME = 1024;
const MAX_LIMIT = 2 ** 32 - 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * fate persistence storage on a kv `Db`. The caller owns `db` and closes it.
 * One fate entry is one kv entry: key `f` + UTF-8 key, value the JSON text.
 */
export function kvStorage(db: Db): PersistenceStorage {
  return {
    async read(key) {
      const bytes = await db.get(encodeKey(key));
      return bytes === undefined ? undefined : JSON.parse(decoder.decode(bytes));
    },

    async writeBatch(entries) {
      const ops = entries.map(
        ([key, value]) =>
          [encodeKey(key), value === undefined ? undefined : encoder.encode(JSON.stringify(value))] as const,
      );
      await db.batch((tx) => {
        for (const [key, value] of ops) {
          if (value === undefined) tx.delete(key);
          else tx.put(key, value);
        }
      });
    },

    async scan(prefix, after, limit = 64) {
      const count = Math.min(Math.ceil(limit), MAX_LIMIT);
      if (!(count > 0)) return [];
      const bound = prefixBound(encodeKey(prefix));
      let start = bound.start;
      if (after !== undefined) {
        const next = encodeKey(after, 0);
        if (compare(next, start) > 0) start = next;
      }
      if (bound.endExclusive && compare(start, bound.endExclusive) >= 0) return [];
      const out = [];
      for await (const entry of db.range({ ...bound, start, limit: count })) {
        out.push({ key: decoder.decode(entry.key.subarray(1)), value: JSON.parse(decoder.decode(entry.value)) });
      }
      return out;
    },

    async exclusive(name, run) {
      if (typeof navigator === "undefined" || !navigator.locks) {
        throw new Error("fate kv storage needs Web Locks");
      }
      return navigator.locks.request(lockName(db.name, name), async () => {
        // fate reads inside the lock and expects to see what another tab committed before it released this lock.
        await db.sync();
        return run();
      });
    },

    subscribe(key, listener) {
      const target = encodeKey(key);
      return db.changes((event) => {
        const touches = (op: ChangeOp) =>
          op.type === "deleteRange"
            ? compare(op.start, target) <= 0 && (!op.endExclusive || compare(target, op.endExclusive) < 0)
            : compare(op.key, target) === 0;
        if (event.kind === "gap" || (event.kind === "append" && event.ops.some(touches))) listener();
      });
    },
  };
}

function encodeKey(key: string, ...suffix: number[]): Uint8Array {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(key)) {
    throw new Error("fate key has a lone surrogate and cannot round-trip through UTF-8");
  }
  const bytes = encoder.encode(key);
  const out = new Uint8Array(1 + bytes.length + suffix.length);
  out[0] = NAMESPACE;
  out.set(bytes, 1);
  out.set(suffix, 1 + bytes.length);
  return out;
}

function compare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

// Synchronous, so lock requests reach Web Locks in call order: fate queues journal writes through them.
function lockName(dbName: string, name: string): string {
  const full = `fate-kv:${JSON.stringify([dbName, name])}`;
  if (full.length <= MAX_LOCK_NAME) return full;
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(full)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `fate-kv:fnv1a64:${hash.toString(16)}`;
}
