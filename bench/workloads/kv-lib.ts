/**
 * Building blocks for kv-family workloads (db_bench and YCSB vocabulary).
 * Lives outside workloads/kv/ so the page's glob does not treat it as a
 * workload.
 */
import type { KvStore } from "../core/families.ts";
import type { Params, Phase, PhaseContext, SizeName } from "../core/types.ts";
import { permutation, zipfian } from "../page/model.ts";

type Ctx = PhaseContext<"kv">;

/** LevelDB's setup: 16-byte keys, 100-byte values compressible to about half. */
export function kvParams(size: SizeName, over: Partial<Params> = {}): Params {
  const entries = { tiny: 1_000, small: 100_000, large: 1_000_000 }[size];
  return {
    entries,
    keyBytes: 16,
    valueBytes: 100,
    compressibility: 0.5,
    batch: 1_000,
    ops: Math.min(entries, 100_000),
    seed: 1,
    ...over,
  };
}

/** Write `ids` in batches of params.batch, timing each batch. */
export async function putIds(ctx: Ctx, ids: ArrayLike<number>, op = "putMany"): Promise<void> {
  const store = await ctx.store();
  const { batch, keyBytes, valueBytes } = ctx.params;
  for (let i = 0; i < ids.length; i += batch) {
    const n = Math.min(batch, ids.length - i);
    const entries: [Uint8Array, Uint8Array][] = [];
    for (let j = 0; j < n; j++) {
      const id = ids[i + j]!;
      entries.push([ctx.model.key(id), ctx.model.nextValue(id)]);
    }
    await ctx.time(op, n * (keyBytes + valueBytes), () => store.putMany(entries), n);
  }
}

function ascending(n: number): Uint32Array {
  return Uint32Array.from({ length: n }, (_, i) => i);
}

/** Random gets of `ids()`, each verified against the model. */
export async function getIds(ctx: Ctx, ops: number, pick: () => number, op = "get"): Promise<void> {
  const store = await ctx.store();
  for (let i = 0; i < ops; i++) {
    const id = pick();
    ctx.model.verify(id, await ctx.time(op, 0, () => store.get(ctx.model.key(id))));
  }
}

/** Ordered scan of `limit` values from id `from`, each verified; checks ascending, contiguous live ids. */
export async function scan(ctx: Ctx, store: KvStore, from: number, limit: number, op: string, count = limit): Promise<number> {
  const values = await ctx.time(op, 0, () => store.range(ctx.model.key(from), undefined, limit), count);
  let prev = -1;
  for (const v of values) {
    const id = ctx.model.verifyAny(v);
    ctx.check(id > prev && id >= from, `scan out of order: ${id} after ${prev}`);
    prev = id;
  }
  return values.length;
}

export const uniform = (ctx: Ctx, n: number) => () => Math.floor(ctx.rng() * n);

/** fill + settle: the untimed-for-reads layout most read phases start from. */
export function fillPhase(name: string, order: "seq" | "random"): Phase<"kv"> {
  return {
    name,
    page: "same",
    timed: true,
    async run(ctx) {
      const n = ctx.params.entries;
      await putIds(ctx, order === "seq" ? ascending(n) : permutation(n, ctx.rng));
    },
  };
}

export function settlePhase(name = "settle"): Phase<"kv"> {
  return {
    name,
    page: "same",
    timed: false,
    footprint: true,
    async run(ctx) {
      await (await ctx.store()).settle();
    },
  };
}

// ---------------------------------------------------------------- YCSB

export type YcsbLetter = "a" | "f";

/** Core workload mixes from YCSB's workload files (not Pebble's letters), zipfian over the loaded keys. */
export const YCSB: Record<YcsbLetter, { title: string; read: number }> = {
  a: { title: "YCSB A: 50% read, 50% update", read: 0.5 },
  f: { title: "YCSB F: 50% read, 50% read-modify-write", read: 0.5 },
};

/** A: the writes are blind single-key updates. F: each write reads and rewrites its key in one transaction. */
export function ycsbPhase(letter: YcsbLetter): Phase<"kv"> {
  return {
    name: `ycsb-${letter}`,
    page: "same",
    timed: true,
    async run(ctx) {
      const store = await ctx.store();
      const { entries, keyBytes, valueBytes } = ctx.params;
      const pick = zipfian(entries, ctx.rng);
      for (let i = 0; i < ctx.params.ops; i++) {
        const read = ctx.rng() < YCSB[letter].read;
        const id = pick();
        if (read) {
          ctx.model.verify(id, await ctx.time("read", 0, () => store.get(ctx.model.key(id))));
        } else if (letter === "a") {
          const kv: [Uint8Array, Uint8Array] = [ctx.model.key(id), ctx.model.nextValue(id)];
          await ctx.time("update", keyBytes + valueBytes, () => store.putMany([kv]));
        } else {
          await ctx.time("rmw", keyBytes + valueBytes, () =>
            store.update(ctx.model.key(id), (old) => {
              ctx.model.verify(id, old);
              return ctx.model.nextValue(id);
            }),
          );
        }
      }
    },
  };
}
