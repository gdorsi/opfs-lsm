import { defineWorkload } from "../../core/types.ts";
import { putIds, settlePhase } from "../kv-lib.ts";
import { kvParams } from "../kv-lib.ts";
import { permutation } from "../../page/model.ts";

/** db_bench fillsync: N/100 single puts, each awaited until acknowledged. Per-op ack latency. */
export default defineWorkload({
  family: "kv",
  title: "N/100 single-key puts, each awaited (acknowledged write latency)",
  params: (size) => {
    const p = kvParams(size);
    return { ...p, entries: Math.max(100, p.entries / 100), batch: 1 };
  },
  phases: [
    {
      name: "fillsync",
      page: "same",
      timed: true,
      run: (ctx) => putIds(ctx, permutation(ctx.params.entries, ctx.rng), "put"),
    },
    settlePhase(),
  ],
});
