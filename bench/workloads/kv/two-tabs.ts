import { defineWorkload, type PhaseContext } from "../../core/types.ts";
import { permutation, rng } from "../../page/model.ts";
import { fillPhase, getIds, kvParams, putIds, settlePhase, uniform } from "../kv-lib.ts";

/** The tenth of the keys the first tab overwrites, the same for both phases that name it: only `seed` travels in `ctx.carry`. */
const writtenIds = (ctx: PhaseContext<"kv">, seed: number) =>
  permutation(ctx.params.entries, rng(seed)).subarray(0, Math.floor(ctx.params.entries / 10));

/**
 * One store, two tabs. The first tab fills and settles it and keeps it open.
 * The second tab opens it, then reads what the first tab writes after that.
 */
export default defineWorkload({
  family: "kv",
  title: "a second tab opens a store the first tab holds, then reads what the first tab just wrote",
  owns: ["kv-second-tab"],
  params: (size) => kvParams(size),
  phases: [
    { ...fillPhase("fill", "random"), timed: false },
    settlePhase(),
    {
      name: "open-second",
      page: "other",
      timed: true,
      async run(ctx) {
        await getIds(ctx, 1, uniform(ctx, ctx.params.entries), "first get"); // the store opens inside, timed as "open"
      },
    },
    {
      name: "write-first",
      page: "other",
      timed: false,
      async run(ctx) {
        const seed = Math.floor(ctx.rng() * 2 ** 32);
        ctx.carry.written = seed;
        await putIds(ctx, writtenIds(ctx, seed));
      },
    },
    {
      name: "read-second",
      page: "other",
      timed: true,
      async run(ctx) {
        const ids = writtenIds(ctx, ctx.carry.written as number);
        const reads = Math.min(ctx.params.ops, ids.length);
        let next = 0;
        const pick = () => ids[next++]!;
        await getIds(ctx, reads, pick, "get", "first get");
      },
    },
  ],
});
