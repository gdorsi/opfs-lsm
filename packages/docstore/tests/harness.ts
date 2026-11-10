import { prefixBound, type BatchTx, type Db, type Entry } from "@opfs-lsm/kv";
import { openHarnessDb } from "@opfs-lsm/kv/testing";
import type { StoredCatalog } from "../src/catalog.js";
import { CATALOG_KEY, ROOT, collectionPrefix, indexPrefix, type CollectionId, type IndexId } from "../src/keys.js";

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
  for await (const _ of kv.range(prefixBound(prefix))) n++;
  return n;
}

/** The catalog as stored, parsed. */
export async function storedCatalog(kv: Db): Promise<StoredCatalog> {
  return JSON.parse(new TextDecoder().decode(await kv.get(CATALOG_KEY))) as StoredCatalog;
}

/** `64 CC CC` of a collection, or `64 CC CC II` of one of its indexes, as the stored catalog names them now. */
export async function storedPrefix(kv: Db, collection: string, index?: string): Promise<Uint8Array> {
  const c = (await storedCatalog(kv)).collections[collection]!;
  const id = c.id as CollectionId;
  return index === undefined ? collectionPrefix(id) : indexPrefix(id, c.indexes[index]!.id as IndexId);
}

/**
 * `kv` whose `method` lets `free` calls through and holds the later ones
 * until `release`. `arrived(n)` resolves once n calls have been made.
 */
export function gate(kv: Db, method: "range" | "batch", free: number) {
  let allowed = free;
  let calls = 0;
  let wake: (() => void)[] = [];
  const watchers: { n: number; resolve: () => void }[] = [];
  const pass = async () => {
    const mine = ++calls;
    for (const w of watchers.filter((w) => calls >= w.n)) w.resolve();
    while (mine > allowed) await new Promise<void>((r) => wake.push(r));
  };
  const over: Partial<Db> =
    method === "range"
      ? {
          range: async function* (range) {
            await pass();
            yield* kv.range(range);
          },
        }
      : { batch: async (build) => (await pass(), kv.batch(build)) };
  return {
    db: wrap(kv, over),
    arrived: (n: number) =>
      calls >= n ? Promise.resolve() : new Promise<void>((resolve) => watchers.push({ n, resolve })),
    release(n = Number.POSITIVE_INFINITY) {
      allowed = n === Number.POSITIVE_INFINITY ? n : allowed + n;
      const woken = wake;
      wake = [];
      for (const w of woken) w();
    },
  };
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
