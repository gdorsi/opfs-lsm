/**
 * Building blocks for kv-family workloads (db_bench and YCSB vocabulary).
 * Lives outside workloads/kv/ so the page's glob does not treat it as a
 * workload.
 */
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

/**
 * Write `ids` in batches of params.batch, timing each batch. Every batch is built before the first call, so the calls run
 * back to back: a phase's rate spans the gaps between calls, and a store that flushes in the background while the harness
 * builds the next batch would otherwise be credited for that work. Holds all of `ids` as entries in memory meanwhile.
 */
export async function putIds(ctx: Ctx, ids: ArrayLike<number>, op = "putMany"): Promise<void> {
  const { batch, keyBytes, valueBytes } = ctx.params;
  const batches: [Uint8Array, Uint8Array][][] = [];
  for (let i = 0; i < ids.length; i += batch) {
    const entries: [Uint8Array, Uint8Array][] = [];
    for (let j = i; j < Math.min(i + batch, ids.length); j++) entries.push([ctx.model.key(ids[j]!), ctx.model.nextValue(ids[j]!)]);
    batches.push(entries);
  }
  const store = await ctx.store();
  for (const entries of batches) await ctx.time(op, entries.length * (keyBytes + valueBytes), () => store.putMany(entries), entries.length);
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.byteLength === b.byteLength && a.every((x, i) => x === b[i]));
}

function ascending(n: number): Uint32Array {
  return Uint32Array.from({ length: n }, (_, i) => i);
}

/**
 * `ops` random gets, `first` naming the first one's op. Keys are built before the first call and every value is checked
 * against the model after the last, so the calls run back to back.
 */
export async function getIds(ctx: Ctx, ops: number, pick: () => number, op = "get", first = op): Promise<void> {
  const ids = Array.from({ length: ops }, pick);
  const keys = ids.map((id) => ctx.model.key(id));
  const store = await ctx.store();
  const got: (Uint8Array | undefined)[] = [];
  for (let i = 0; i < ops; i++) got.push(await ctx.time(i === 0 ? first : op, 0, () => store.get(keys[i]!)));
  ids.forEach((id, i) => ctx.model.verify(id, got[i]));
}

/** Random gets of keys that fall between two stored keys, so a read cannot stop at the fence of the key range. Each must come back absent. Built before and checked after, like `getIds`. */
export async function getMisses(ctx: Ctx, ops: number, pick: () => number, op = "miss"): Promise<void> {
  const ids = Array.from({ length: ops }, pick);
  const keys = ids.map((id) => ctx.model.missKey(id));
  const store = await ctx.store();
  const got: (Uint8Array | undefined)[] = [];
  for (let i = 0; i < ops; i++) got.push(await ctx.time(op, 0, () => store.get(keys[i]!)));
  ids.forEach((id, i) => ctx.check(got[i] === undefined, `miss key after id ${id} is present`));
}

/** One ordered read: up to `limit` values from id `from`, past `offset` live ids, counting `count` ops. */
export type Scan = { from: number; limit: number; op: string; count?: number; offset?: number };

/**
 * Runs `scans` back to back, every start key built before the first call. After the last call each result is checked
 * against the model: every value is the next live id after the one before it, and the scan stops at `limit` or at the
 * last live id, never earlier. Returns the number of values each scan read.
 */
export async function scanAll(ctx: Ctx, scans: readonly Scan[]): Promise<number[]> {
  const starts = scans.map((s) => ctx.model.key(s.from));
  const store = await ctx.store();
  const results: Uint8Array[][] = [];
  for (const [i, s] of scans.entries()) {
    results.push(await ctx.time(s.op, 0, () => store.range(starts[i]!, undefined, s.limit, s.offset ?? 0), s.count ?? s.limit));
  }
  scans.forEach(({ from, limit, offset = 0 }, i) => {
    const values = results[i]!;
    let want = ctx.model.nextLive(from);
    for (let skipped = 0; skipped < offset && want !== undefined; skipped++) want = ctx.model.nextLive(want + 1);
    for (const v of values) {
      const id = ctx.model.verifyAny(v);
      ctx.check(id === want, `scan from ${from} past ${offset}: got id ${id}, want ${want}`);
      want = ctx.model.nextLive(id + 1);
    }
    ctx.check(values.length <= limit, `scan from ${from}: ${values.length} values for a limit of ${limit}`);
    ctx.check(values.length === limit || want === undefined, `scan from ${from}: stopped after ${values.length} of ${limit} values, id ${want} is live`);
  });
  return results.map((values) => values.length);
}

/** One bounded read over the ids in [lo, hi), ascending or `reverse`, past `offset` entries, at most `limit` values, counting `count` ops. */
export type Bounded = { lo: number; hi: number; limit: number; op: string; reverse?: boolean; offset?: number; count?: number };

/**
 * Runs `reads` back to back, bounds built before the first call. Each result is checked after the last against the model:
 * the live ids of the range in scan order past `offset`, cut at `limit`, no more and no fewer. Returns the number of values each read read.
 */
export async function boundedAll(ctx: Ctx, reads: readonly Bounded[]): Promise<number[]> {
  const bounds = reads.map((r) => [ctx.model.key(r.lo), ctx.model.key(r.hi)] as const);
  const store = await ctx.store();
  const results: Uint8Array[][] = [];
  for (const [i, r] of reads.entries()) {
    results.push(await ctx.time(r.op, 0, () => store.range(bounds[i]![0], bounds[i]![1], r.limit, r.offset ?? 0, r.reverse ?? false), r.count ?? r.limit));
  }
  reads.forEach(({ lo, hi, limit, reverse, offset = 0 }, i) => {
    const want: number[] = [];
    let skipped = 0;
    for (let k = 0; k < hi - lo && want.length < limit; k++) {
      const id = reverse ? hi - 1 - k : lo + k;
      if (ctx.model.version(id) > 0 && skipped++ >= offset) want.push(id);
    }
    const got = results[i]!.map((v) => ctx.model.verifyAny(v));
    ctx.check(
      got.length === want.length && got.every((id, j) => id === want[j]),
      `${reverse ? "reverse " : ""}read of [${lo}, ${hi}) past ${offset} limit ${limit}: got ${got.length} ids from ${got[0]}, want ${want.length} from ${want[0]}`,
    );
  });
  return results.map((values) => values.length);
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

type YcsbOp =
  | { kind: "read"; id: number; key: Uint8Array; want: Uint8Array | undefined }
  | { kind: "update"; kv: [Uint8Array, Uint8Array] }
  | { kind: "rmw"; id: number; key: Uint8Array; was: Uint8Array | undefined; next: Uint8Array };

/**
 * A: the writes are blind single-key updates. F: each write reads and rewrites its key in one transaction. The op stream
 * (kind, key, the value a read must see and the next value a write stores) is built before the first call and every read
 * is checked after the last, so the calls run back to back. The function of a read-modify-write only records what it
 * read: a contender may run it again, and its last run is the one that counts.
 */
export function ycsbPhase(letter: YcsbLetter): Phase<"kv"> {
  return {
    name: `ycsb-${letter}`,
    page: "same",
    timed: true,
    async run(ctx) {
      const { entries, keyBytes, valueBytes } = ctx.params;
      const pick = zipfian(entries, ctx.rng);
      const stream: YcsbOp[] = [];
      for (let i = 0; i < ctx.params.ops; i++) {
        const read = ctx.rng() < YCSB[letter].read;
        const id = pick();
        const key = ctx.model.key(id);
        const was = ctx.model.expected(id);
        if (read) stream.push({ kind: "read", id, key, want: was });
        else if (letter === "a") stream.push({ kind: "update", kv: [key, ctx.model.nextValue(id)] });
        else stream.push({ kind: "rmw", id, key, was, next: ctx.model.nextValue(id) });
      }
      const store = await ctx.store();
      const seen: (Uint8Array | undefined)[] = [];
      for (const op of stream) {
        if (op.kind === "read") seen.push(await ctx.time("read", 0, () => store.get(op.key)));
        else if (op.kind === "update") await ctx.time("update", keyBytes + valueBytes, () => store.putMany([op.kv]));
        else {
          let old: Uint8Array | undefined;
          await ctx.time("rmw", keyBytes + valueBytes, () =>
            store.update(op.key, (current) => {
              old = current;
              return op.next;
            }),
          );
          seen.push(old);
        }
      }
      let next = 0;
      for (const op of stream) {
        if (op.kind === "update") continue;
        const got = seen[next++];
        const want = op.kind === "read" ? op.want : op.was;
        ctx.check(sameBytes(got, want), `${op.kind} of key ${op.id} saw ${got === undefined ? "nothing" : "another value"}, want the value it last wrote`);
      }
    },
  };
}
