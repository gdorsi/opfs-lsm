import { defineWorkload } from "../../core/types.ts";
import { permutation } from "../../page/model.ts";
import { fillPhase, getIds, getMisses, kvParams, settlePhase, uniform, warmPhase } from "../kv-lib.ts";

/**
 * db_bench order on one database: N/100 single puts each awaited on the empty
 * store (fillsync), random fill, reads while compaction still runs, then reads
 * and misses over warm pages once it has settled, a cold open in a fresh tab
 * after the SharedWorker has exited, the same reads over that tab's cold
 * pages, then deletes of a random tenth and the space compaction gives back.
 */
export default defineWorkload({
  family: "kv",
  title: "single awaited puts, random fill, random reads during compaction, then warm, misses, cold open, cold reads, random deletes",
  owns: ["kv-single-put", "kv-random-fill", "kv-point-get", "kv-cold-open", "kv-delete"],
  params: (size) => kvParams(size),
  phases: [
    {
      name: "fillsync",
      page: "same",
      timed: true,
      async run(ctx) {
        const { keyBytes, valueBytes } = ctx.params;
        const puts = Array.from(permutation(Math.max(100, ctx.params.entries / 100), ctx.rng), (id): [Uint8Array, Uint8Array] => [ctx.model.key(id), ctx.model.nextValue(id)]);
        const store = await ctx.store();
        for (const kv of puts) await ctx.time("put", keyBytes + valueBytes, () => store.putMany([kv]));
      },
    },
    fillPhase("fillrandom", "random"),
    {
      name: "readrandom-unsettled",
      page: "same",
      timed: true,
      run: (ctx) => getIds(ctx, ctx.params.ops, uniform(ctx, ctx.params.entries)),
    },
    settlePhase(),
    warmPhase(),
    {
      name: "readrandom",
      page: "same",
      timed: true,
      run: (ctx) => getIds(ctx, ctx.params.ops, uniform(ctx, ctx.params.entries)),
    },
    {
      name: "readmissing",
      page: "same",
      timed: true,
      run: (ctx) => getMisses(ctx, ctx.params.ops, uniform(ctx, ctx.params.entries)),
    },
    {
      name: "coldopen",
      page: "fresh",
      rounds: 5,
      timed: true,
      footprint: true,
      async run(ctx) {
        await getIds(ctx, 1, uniform(ctx, ctx.params.entries), "first get"); // the store opens inside, timed as "open"
      },
    },
    {
      name: "readrandom-cold",
      page: "same",
      timed: true,
      run: (ctx) => getIds(ctx, ctx.params.ops, uniform(ctx, ctx.params.entries)),
    },
    {
      name: "deleterandom",
      page: "same",
      timed: true,
      async run(ctx) {
        const ids = permutation(ctx.params.entries, ctx.rng).subarray(0, Math.floor(ctx.params.entries / 10));
        const { batch, keyBytes } = ctx.params;
        const batches: Uint8Array[][] = [];
        for (let i = 0; i < ids.length; i += batch) {
          const slice = ids.subarray(i, i + batch);
          for (const id of slice) ctx.model.remove(id);
          batches.push([...slice].map((id) => ctx.model.key(id)));
        }
        const store = await ctx.store();
        for (const keys of batches) await ctx.time("deleteMany", keys.length * keyBytes, () => store.deleteMany(keys), keys.length);
      },
    },
    {
      name: "settle-deleted",
      page: "same",
      timed: false,
      footprint: true,
      async run(ctx) {
        await (await ctx.store()).settle();
        // Untimed: a tenth of the keys are gone, and every read must say so.
        await getIds(ctx, ctx.params.ops / 10, uniform(ctx, ctx.params.entries));
      },
    },
  ],
});
