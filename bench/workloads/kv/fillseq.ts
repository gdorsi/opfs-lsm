import { defineWorkload } from "../../core/types.ts";
import { fillPhase, kvParams, scan, settlePhase } from "../kv-lib.ts";

/** Ascending fill, then a full forward scan and random seeks of 10 and 100 keys. */
export default defineWorkload({
  family: "kv",
  title: "ascending fill, full scan, random seeks of 10 and 100 keys",
  params: (size) => kvParams(size),
  phases: [
    fillPhase("fillseq", "seq"),
    settlePhase(),
    {
      name: "readseq",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        let total = 0;
        for (let from = 0; from < ctx.params.entries; ) {
          const n = await scan(ctx, store, from, 1_000, "range page");
          if (n === 0) break;
          total += n;
          from += n;
        }
        ctx.check(total === ctx.params.entries, `readseq saw ${total} of ${ctx.params.entries} keys`);
      },
    },
    ...[10, 100].map((nexts) => ({
      name: `seekrandom-${nexts}`,
      page: "same" as const,
      timed: true,
      async run(ctx: Parameters<typeof scan>[0]) {
        const store = await ctx.store();
        const seeks = Math.ceil(ctx.params.ops / 10);
        for (let i = 0; i < seeks; i++) {
          await scan(ctx, store, Math.floor(ctx.rng() * ctx.params.entries), nexts, "seek", 1);
        }
      },
    })),
  ],
});
