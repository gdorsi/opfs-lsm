import { defineWorkload, type PhaseContext } from "../../core/types.ts";
import { permutation } from "../../page/model.ts";
import { type Bounded, boundedAll, fillPhase, getIds, kvParams, type Scan, scanAll, settlePhase, uniform, warmPhase } from "../kv-lib.ts";

/** The page a count-free read asks for. */
const PAGE = 50;
/** The values one page of the full scan reads. */
const READ_PAGE = 1_000;
/** The key set is cut into this many slots, and `deleterange` deletes a tenth of them, one range each. */
const SLOTS = 1_000;

/** Random gets, a tenth of them in a deleted range, then a page from the start of each deleted range, which must begin at the first live key past it. */
async function readDeletedRanges(ctx: PhaseContext<"kv">): Promise<void> {
  const span = ctx.params.entries / SLOTS;
  const deleted = Array.from({ length: SLOTS }, (_, slot) => slot * span).filter((from) => ctx.model.version(from) === 0);
  await getIds(ctx, Math.ceil(ctx.params.ops / 10), uniform(ctx, ctx.params.entries));
  await scanAll(ctx, deleted.map((from): Scan => ({ from, limit: PAGE, op: "page", count: 1 })));
}

/** Ascending fill, then a full forward scan, random seeks of 10 and 100 keys, reverse seeks, bounded scans, counts, pages an offset deep in both directions, reads of many keys, then range deletes and reads across them. */
export default defineWorkload({
  family: "kv",
  title: "ascending fill, full scan, random seeks of 10 and 100 keys, reverse seeks, bounded scans, counts, offsets, reads of many keys and range deletes",
  owns: ["kv-seq-fill", "kv-delete-range", "kv-scan", "kv-count", "kv-offset", "kv-multi-get"],
  params: (size) => kvParams(size),
  phases: [
    fillPhase("fillseq", "seq"),
    settlePhase(),
    warmPhase(),
    {
      name: "readseq",
      page: "same",
      timed: true,
      async run(ctx) {
        const { entries } = ctx.params;
        const pages = Array.from({ length: Math.ceil(entries / READ_PAGE) }, (_, i): Scan => ({ from: i * READ_PAGE, limit: READ_PAGE, op: "range page" }));
        const total = (await scanAll(ctx, pages)).reduce((sum, n) => sum + n, 0);
        ctx.check(total === entries, `readseq saw ${total} of ${entries} keys`);
      },
    },
    ...[10, 100].map((nexts) => ({
      name: `seekrandom-${nexts}`,
      page: "same" as const,
      timed: true,
      async run(ctx: Parameters<typeof scanAll>[0]) {
        const seeks = Math.ceil(ctx.params.ops / 10);
        await scanAll(ctx, Array.from({ length: seeks }, () => ({ from: Math.floor(ctx.rng() * ctx.params.entries), limit: nexts, op: "seek", count: 1 })));
      },
    })),
    {
      name: "seekreverse",
      page: "same",
      timed: true,
      async run(ctx) {
        const { entries, ops } = ctx.params;
        const reads = Array.from({ length: Math.ceil(ops / 10) }, (): Bounded => ({ lo: 0, hi: Math.floor(ctx.rng() * entries), limit: 100, op: "seek", count: 1, reverse: true }));
        await boundedAll(ctx, reads);
      },
    },
    {
      name: "scanbounded",
      page: "same",
      timed: true,
      async run(ctx) {
        const { entries } = ctx.params;
        const reads = Array.from({ length: 200 }, (): Bounded => {
          const lo = Math.floor(ctx.rng() * (entries - PAGE + 1));
          return { lo, hi: lo + PAGE, limit: 2 * PAGE, op: "bounded", count: 1 };
        });
        (await boundedAll(ctx, reads)).forEach((n, i) => ctx.check(n === PAGE, `bounded scan from ${reads[i]!.lo} read ${n} of ${PAGE} values`));
      },
    },
    {
      name: "count",
      page: "same",
      timed: true,
      async run(ctx) {
        const { entries } = ctx.params;
        const span = Math.ceil(entries / 10);
        const bounds = Array.from({ length: 200 }, () => {
          const from = Math.floor(ctx.rng() * (entries - span + 1));
          return { from, lo: ctx.model.key(from), hi: ctx.model.key(from + span) };
        });
        const store = await ctx.store();
        const counts: number[] = [];
        for (const { lo, hi } of bounds) counts.push(await ctx.time("count", 0, () => store.count(lo, hi)));
        bounds.forEach(({ from }, i) => ctx.check(counts[i] === span, `count from ${from} saw ${counts[i]} of ${span} keys`));
      },
    },
    {
      name: "skip",
      page: "same",
      timed: true,
      async run(ctx) {
        const { entries } = ctx.params;
        const offset = Math.ceil(entries / 100);
        const skips = Array.from({ length: 200 }, () => ({ from: Math.floor(ctx.rng() * (entries - offset - PAGE + 1)), limit: PAGE, op: "skip", count: 1, offset }));
        (await scanAll(ctx, skips)).forEach((n, i) => ctx.check(n === PAGE, `skip from ${skips[i]!.from} read ${n} of ${PAGE} values`));
      },
    },
    {
      name: "skipreverse",
      page: "same",
      timed: true,
      async run(ctx) {
        const { entries } = ctx.params;
        const offset = Math.ceil(entries / 100);
        const reads = Array.from({ length: 200 }, (): Bounded => {
          const hi = offset + PAGE + Math.floor(ctx.rng() * (entries - offset - PAGE + 1));
          return { lo: 0, hi, limit: PAGE, op: "skip", count: 1, reverse: true, offset };
        });
        (await boundedAll(ctx, reads)).forEach((n, i) => ctx.check(n === PAGE, `reverse skip below ${reads[i]!.hi} read ${n} of ${PAGE} values`));
      },
    },
    {
      name: "getmany",
      page: "same",
      timed: true,
      async run(ctx) {
        const batches = Array.from({ length: 200 }, () => {
          const ids = Array.from({ length: PAGE }, () => Math.floor(ctx.rng() * ctx.params.entries));
          return { ids, keys: ids.map((id) => ctx.model.key(id)) };
        });
        const store = await ctx.store();
        const got: (Uint8Array | undefined)[][] = [];
        for (const { keys } of batches) got.push(await ctx.time("getMany", 0, () => store.getMany(keys)));
        batches.forEach(({ ids }, i) => ids.forEach((id, j) => ctx.model.verify(id, got[i]![j])));
      },
    },
    {
      name: "deleterange",
      page: "same",
      timed: true,
      async run(ctx) {
        const { entries, keyBytes } = ctx.params;
        const span = entries / SLOTS;
        const slots = [...permutation(SLOTS, ctx.rng).subarray(0, SLOTS / 10)];
        const bounds = slots.map((slot) => [ctx.model.key(slot * span), ctx.model.key((slot + 1) * span)] as const);
        for (const slot of slots) for (let id = slot * span; id < (slot + 1) * span; id++) ctx.model.remove(id);
        const store = await ctx.store();
        for (const [lo, hi] of bounds) await ctx.time("deleteRange", 2 * keyBytes, () => store.deleteRange(lo, hi), 1);
      },
    },
    { name: "readdeleted", page: "same", timed: true, run: readDeletedRanges },
    settlePhase("settle-deleted"),
    { name: "check-deleted", page: "same", timed: false, run: readDeletedRanges },
  ],
});
