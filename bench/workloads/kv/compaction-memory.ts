import { defineWorkload } from "../../core/types.ts";
import { getIds, kvParams, putIds, settlePhase, uniform } from "../kv-lib.ts";

const ROUNDS = 20;
/** Keys are drawn from a pool this many times one round, so the live set grows to a few rounds' worth and later rounds overwrite. */
const POOL_FACTOR = 4;

/**
 * Random-key rounds into a pool of keys: every L0 to L1 step spans all of L1,
 * the shape that makes one compaction step hold several times its input in
 * memory. The numbers of interest are the memory peaks in the run record.
 */
export default defineWorkload({
  family: "kv",
  contenders: ["kv"],
  title: `${ROUNDS} rounds of N random puts into a ${POOL_FACTOR}N key pool; SharedWorker and tab memory peaks`,
  params: (size) => kvParams(size),
  phases: [
    {
      name: "rounds",
      page: "same",
      timed: true,
      async run(ctx) {
        const n = ctx.params.entries;
        const pool = n * POOL_FACTOR;
        for (let round = 0; round < ROUNDS; round++) {
          const ids = new Set<number>();
          while (ids.size < n) ids.add(Math.floor(ctx.rng() * pool));
          await putIds(ctx, Uint32Array.from(ids));
          ctx.progress(`round ${round + 1}/${ROUNDS}`);
        }
      },
    },
    settlePhase(),
    {
      name: "verify",
      page: "same",
      timed: false,
      async run(ctx) {
        await getIds(ctx, Math.min(ctx.params.ops, 20_000), uniform(ctx, ctx.params.entries * POOL_FACTOR));
      },
    },
  ],
});
