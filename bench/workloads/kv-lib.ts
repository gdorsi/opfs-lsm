/**
 * Building blocks for kv-family workloads (db_bench and YCSB vocabulary).
 * Lives outside workloads/kv/ so the page's glob does not treat it as a
 * workload.
 */
import type { KvStore } from "../core/families.ts";
import type { Params, Phase, PhaseContext, SizeName } from "../core/types.ts";
import { latest, permutation, zipfian } from "../page/model.ts";

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

export type YcsbLetter = "a" | "b" | "c" | "d" | "e" | "f";

/** Core workload mixes from YCSB's workload files (not Pebble's letters). */
export const YCSB: Record<YcsbLetter, { title: string; read: number; update: number; insert: number; scan: number; rmw: number; dist: "zipfian" | "latest" }> = {
  a: { title: "YCSB A: 50% read, 50% update, zipfian", read: 0.5, update: 0.5, insert: 0, scan: 0, rmw: 0, dist: "zipfian" },
  b: { title: "YCSB B: 95% read, 5% update, zipfian", read: 0.95, update: 0.05, insert: 0, scan: 0, rmw: 0, dist: "zipfian" },
  c: { title: "YCSB C: 100% read, zipfian", read: 1, update: 0, insert: 0, scan: 0, rmw: 0, dist: "zipfian" },
  d: { title: "YCSB D: 95% read, 5% insert, latest", read: 0.95, update: 0, insert: 0.05, scan: 0, rmw: 0, dist: "latest" },
  e: { title: "YCSB E: 95% scan (1-100 keys), 5% insert, zipfian", read: 0, update: 0, insert: 0.05, scan: 0.95, rmw: 0, dist: "zipfian" },
  f: { title: "YCSB F: 50% read, 50% read-modify-write, zipfian", read: 0.5, update: 0, insert: 0, scan: 0, rmw: 0.5, dist: "zipfian" },
};

export function ycsbPhase(letter: YcsbLetter): Phase<"kv"> {
  const mix = YCSB[letter];
  return {
    name: `ycsb-${letter}`,
    page: "same",
    timed: true,
    async run(ctx) {
      const store = await ctx.store();
      const { entries, keyBytes, valueBytes } = ctx.params;
      const ops = letter === "e" ? Math.ceil(ctx.params.ops / 10) : ctx.params.ops;
      let end = ctx.model.end;
      const pick =
        mix.dist === "latest" ? latest(() => end, ctx.rng, entries + ops) : zipfian(entries, ctx.rng);
      for (let i = 0; i < ops; i++) {
        let r = ctx.rng();
        if ((r -= mix.read) < 0) {
          const id = pick();
          ctx.model.verify(id, await ctx.time("read", 0, () => store.get(ctx.model.key(id))));
        } else if ((r -= mix.update) < 0) {
          const id = pick();
          const kv: [Uint8Array, Uint8Array] = [ctx.model.key(id), ctx.model.nextValue(id)];
          await ctx.time("update", keyBytes + valueBytes, () => store.putMany([kv]));
        } else if ((r -= mix.insert) < 0) {
          const id = end++;
          const kv: [Uint8Array, Uint8Array] = [ctx.model.key(id), ctx.model.nextValue(id)];
          await ctx.time("insert", keyBytes + valueBytes, () => store.putMany([kv]));
        } else if ((r -= mix.scan) < 0) {
          await scan(ctx, store, pick(), 1 + Math.floor(ctx.rng() * 100), "scan", 1);
        } else {
          const id = pick();
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
