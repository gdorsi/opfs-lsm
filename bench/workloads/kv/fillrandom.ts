import { defineWorkload } from "../../core/types.ts";
import { permutation } from "../../page/model.ts";
import { fillPhase, getIds, kvParams, settlePhase, uniform } from "../kv-lib.ts";

/**
 * db_bench order on one database: N/100 single puts each awaited on the empty
 * store (fillsync), random fill, reads before and after compaction settles
 * (LevelDB reports a gap between the two), misses, a cold open in a fresh tab
 * after the SharedWorker has exited, then deletes of a random tenth and the
 * space compaction gives back.
 */
export default defineWorkload({
  family: "kv",
  title: "single awaited puts, random fill, random reads before and after compaction, misses, cold open, random deletes",
  owns: ["kv-single-put", "kv-random-fill", "kv-point-get", "kv-cold-open", "kv-delete"],
  params: (size) => kvParams(size),
  phases: [
    {
      name: "fillsync",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const { keyBytes, valueBytes } = ctx.params;
        for (const id of permutation(Math.max(100, ctx.params.entries / 100), ctx.rng)) {
          const kv: [Uint8Array, Uint8Array] = [ctx.model.key(id), ctx.model.nextValue(id)];
          await ctx.time("put", keyBytes + valueBytes, () => store.putMany([kv]));
        }
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
      run: (ctx) => getIds(ctx, ctx.params.ops, () => ctx.params.entries + Math.floor(ctx.rng() * ctx.params.entries), "miss"),
    },
    {
      name: "coldopen",
      page: "fresh",
      timed: true,
      footprint: true,
      async run(ctx) {
        await ctx.store(); // timed as "open"
        await getIds(ctx, 1, uniform(ctx, ctx.params.entries), "first get");
      },
    },
    {
      name: "deleterandom",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const ids = permutation(ctx.params.entries, ctx.rng).subarray(0, Math.floor(ctx.params.entries / 10));
        const { batch, keyBytes } = ctx.params;
        for (let i = 0; i < ids.length; i += batch) {
          const slice = ids.subarray(i, i + batch);
          for (const id of slice) ctx.model.remove(id);
          await ctx.time("deleteMany", slice.length * keyBytes, () => store.deleteMany([...slice].map((id) => ctx.model.key(id))), slice.length);
        }
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
