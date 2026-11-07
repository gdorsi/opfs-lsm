import { defineWorkload } from "../../core/types.ts";
import { fillPhase, kvParams, putIds, settlePhase } from "../kv-lib.ts";

/** Random fill, then N random overwrites (keys repeat): compaction drops old versions. */
export default defineWorkload({
  family: "kv",
  title: "random fill, then N random overwrites; write amplification after compaction",
  params: (size) => kvParams(size),
  phases: [
    fillPhase("fillrandom", "random"),
    {
      name: "overwrite",
      page: "same",
      timed: true,
      async run(ctx) {
        const n = ctx.params.entries;
        await putIds(ctx, Uint32Array.from({ length: n }, () => Math.floor(ctx.rng() * n)).filter(uniqueInBatch(ctx.params.batch)));
      },
    },
    settlePhase(),
  ],
});

/** Drop a key's repeat inside one batch: a batch holds each key once on every contender. */
function uniqueInBatch(batch: number): (id: number, i: number) => boolean {
  let seen = new Set<number>();
  return (id, i) => {
    if (i % batch === 0) seen = new Set();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
}
