import { defineWorkload } from "../../core/types.ts";
import { fillPhase, kvParams, scan, settlePhase } from "../kv-lib.ts";

/** The page a count-free read asks for. */
const PAGE = 50;

/** Ascending fill, then a full forward scan, random seeks of 10 and 100 keys, counts, pages an offset deep and reads of many keys. */
export default defineWorkload({
  family: "kv",
  title: "ascending fill, full scan, random seeks of 10 and 100 keys, counts, offsets and reads of many keys",
  owns: ["kv-seq-fill", "kv-scan", "kv-count", "kv-offset", "kv-multi-get"],
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
    {
      name: "count",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const { entries } = ctx.params;
        const span = Math.ceil(entries / 10);
        for (let i = 0; i < 200; i++) {
          const from = Math.floor(ctx.rng() * (entries - span + 1));
          const n = await ctx.time("count", 0, () => store.count(ctx.model.key(from), ctx.model.key(from + span)));
          ctx.check(n === span, `count from ${from} saw ${n} of ${span} keys`);
        }
      },
    },
    {
      name: "skip",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const { entries } = ctx.params;
        const offset = Math.ceil(entries / 100);
        for (let i = 0; i < 200; i++) {
          const from = Math.floor(ctx.rng() * (entries - offset - PAGE + 1));
          const n = await scan(ctx, store, from, PAGE, "skip", 1, offset);
          ctx.check(n === PAGE, `skip from ${from} read ${n} of ${PAGE} values`);
        }
      },
    },
    {
      name: "getmany",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        for (let i = 0; i < 200; i++) {
          const ids = Array.from({ length: PAGE }, () => Math.floor(ctx.rng() * ctx.params.entries));
          const values = await ctx.time("getMany", 0, () => store.getMany(ids.map((id) => ctx.model.key(id))));
          ids.forEach((id, j) => ctx.model.verify(id, values[j]));
        }
      },
    },
  ],
});
