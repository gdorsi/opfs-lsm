import { defineWorkload } from "../../core/types.ts";
import { fillPhase, getIds, kvParams, settlePhase, uniform } from "../kv-lib.ts";

/**
 * db_bench order on one database: random fill, reads before and after
 * compaction settles (LevelDB reports a gap between the two), misses, then
 * a cold open in a fresh tab after the SharedWorker has exited.
 */
export default defineWorkload({
  family: "kv",
  title: "random fill, then random reads before and after compaction, misses, cold open",
  params: (size) => kvParams(size),
  phases: [
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
  ],
});
