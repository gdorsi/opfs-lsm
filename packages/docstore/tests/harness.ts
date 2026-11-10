import type { BatchTx, Db, Entry } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import { ROOT } from "../src/keys.js";

let dbs = 0;

/** A database name no other test in this process uses. */
export function freshName(): string {
  return `docstore-${process.pid}-${++dbs}`;
}

/** One handle on `name`. Handles on one name share the WAL and the run files, like tabs of one origin. */
export function openKv(name: string): Promise<Db> {
  return openHarnessDb({ name, forceMemory: true, ingestPolicy: { maxWalBytes: 1 << 30 } });
}

/** Every key this package wrote, in key order. */
export async function docstoreKeys(kv: Db): Promise<Entry[]> {
  const out: Entry[] = [];
  for await (const e of kv.range({ start: Uint8Array.of(ROOT), endExclusive: Uint8Array.of(ROOT + 1) })) out.push(e);
  return out;
}

export async function keysUnder(kv: Db, prefix: Uint8Array): Promise<number> {
  let n = 0;
  const end = Uint8Array.from(prefix);
  end[end.length - 1]! += 1;
  for await (const _ of kv.range({ start: prefix, endExclusive: end })) n++;
  return n;
}

export type UpdateRecord = { readonly reads: number; readonly puts: number; readonly deletes: number };

/** `kv` with each `update` call recorded: keys read and ops written. */
export function recording(kv: Db): { readonly db: Db; readonly updates: UpdateRecord[] } {
  const updates: UpdateRecord[] = [];
  const update: Db["update"] = (keys, body) =>
    kv.update(keys, (values, tx) => {
      const record = { reads: keys.length, puts: 0, deletes: 0 };
      const counted: BatchTx = {
        put: (k, v) => {
          record.puts++;
          tx.put(k, v);
        },
        delete: (k) => {
          record.deletes++;
          tx.delete(k);
        },
      };
      const out = body(values, counted);
      updates.push(record);
      return out;
    });
  return { db: wrap(kv, { update }), updates };
}

/** `kv` with some methods replaced. */
export function wrap(kv: Db, over: Partial<Db>): Db {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop in over) return over[prop as keyof Db];
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    throw err;
  }
  return "no error";
}
