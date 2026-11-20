/**
 * Building blocks for kv-family workloads (db_bench and YCSB vocabulary).
 * Lives outside workloads/kv/ so the page's glob does not treat it as a
 * workload.
 */
import type { KvStore } from "../core/families.ts";
import type { Phase, PhaseContext, SizeName, WorkloadParams } from "../core/types.ts";
import { permutation, zipfian } from "../page/model.ts";

type Ctx = PhaseContext<"kv">;

/** LevelDB's setup: 16-byte keys, 100-byte values compressible to about half. */
export function kvParams(size: SizeName, over: Partial<WorkloadParams> = {}): WorkloadParams {
  const entries = { tiny: 1_000, small: 100_000, large: 1_000_000 }[size];
  return {
    entries,
    keyBytes: 16,
    valueBytes: 100,
    compressibility: 0.5,
    batch: 1_000,
    ops: Math.min(entries, 100_000),
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

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.byteLength === b.byteLength && a.every((x, i) => x === b[i]));
}

function ascending(n: number): Uint32Array {
  return Uint32Array.from({ length: n }, (_, i) => i);
}

/** Random gets of `ids()`, each verified against the model. */
export async function getIds(ctx: Ctx, ops: number, pick: () => number, op = "get"): Promise<void> {
  const store = await ctx.store();
  for (let i = 0; i < ops; i++) {
    const id = pick();
    const key = ctx.model.key(id);
    ctx.model.verify(id, await ctx.time(op, 0, () => store.get(key)));
  }
}

/** Random gets of keys that fall between two stored keys, so a read cannot stop at the fence of the key range. Each must come back absent. */
export async function getMisses(ctx: Ctx, ops: number, pick: () => number, op = "miss"): Promise<void> {
  const store = await ctx.store();
  for (let i = 0; i < ops; i++) {
    const id = pick();
    const key = ctx.model.missKey(id);
    const got = await ctx.time(op, 0, () => store.get(key));
    ctx.check(got === undefined, `miss key after id ${id} is present`);
  }
}

/**
 * Ordered scan of up to `limit` values from id `from`, past `offset` live ids, outside the timer checked against the
 * model: every value is the next live id after the one before it, and the scan stops at `limit` or at the last live id, never earlier.
 */
export async function scan(ctx: Ctx, store: KvStore, from: number, limit: number, op: string, count = limit, offset = 0): Promise<number> {
  const start = ctx.model.key(from);
  const values = await ctx.time(op, 0, () => store.range(start, undefined, limit, offset), count);
  let want = ctx.model.nextLive(from);
  for (let skipped = 0; skipped < offset && want !== undefined; skipped++) want = ctx.model.nextLive(want + 1);
  for (const v of values) {
    const id = ctx.model.verifyAny(v);
    ctx.check(id === want, `scan from ${from} past ${offset}: got id ${id}, want ${want}`);
    want = ctx.model.nextLive(id + 1);
  }
  ctx.check(values.length <= limit, `scan from ${from}: ${values.length} values for a limit of ${limit}`);
  ctx.check(values.length === limit || want === undefined, `scan from ${from}: stopped after ${values.length} of ${limit} values, id ${want} is live`);
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

/**
 * Reads every key once, untimed, so the timed reads after it find every page
 * in the tab's cache. Without it a read phase after a settle pays the page
 * loads only in the runs where compaction rewrote the files after the last read.
 */
export function warmPhase(name = "warm"): Phase<"kv"> {
  return {
    name,
    page: "same",
    timed: false,
    async run(ctx) {
      const store = await ctx.store();
      for (let from = 0; from < ctx.params.entries; from += 1_000) await store.range(ctx.model.key(from), undefined, 1_000);
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
          const key = ctx.model.key(id);
          ctx.model.verify(id, await ctx.time("read", 0, () => store.get(key)));
        } else if (letter === "a") {
          const kv: [Uint8Array, Uint8Array] = [ctx.model.key(id), ctx.model.nextValue(id)];
          await ctx.time("update", keyBytes + valueBytes, () => store.putMany([kv]));
        } else {
          const key = ctx.model.key(id);
          const was = ctx.model.expected(id);
          const next = ctx.model.nextValue(id);
          let old: Uint8Array | undefined;
          await ctx.time("rmw", keyBytes + valueBytes, () =>
            store.update(key, (current) => {
              old = current;
              return next;
            }),
          );
          ctx.check(sameBytes(old, was), `rmw of key ${id} read ${old === undefined ? "nothing" : "another value"}, want the value it last wrote`);
        }
      }
    },
  };
}
