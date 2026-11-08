import { defineWorkload } from "../../core/types.ts";
import { permutation } from "../../page/model.ts";
import { fillPhase, getIds, kvParams, settlePhase, uniform } from "../kv-lib.ts";

/** Random fill, delete a random tenth, settle: space before and after, then verify reads. */
export default defineWorkload({
  family: "kv",
  title: "random fill, delete a random 10%, space before and after compaction",
  params: (size) => kvParams(size),
  phases: [
    fillPhase("fillrandom", "random"),
    settlePhase("settle-before"),
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
    settlePhase("settle-after"),
    {
      name: "readrandom",
      page: "same",
      timed: true,
      run: (ctx) => getIds(ctx, ctx.params.ops, uniform(ctx, ctx.params.entries)),
    },
  ],
});
