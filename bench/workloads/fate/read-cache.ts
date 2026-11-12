import type { FateStore } from "../../core/families.ts";
import { defineWorkload, type Phase, type PhaseContext } from "../../core/types.ts";
import { jsonBytes, PAGE, pageRequest, record, verifyFromStorage, worldFor } from "../../page/fate.ts";
import { permutation } from "../../page/model.ts";

/**
 * fate's request cache: a client saves list requests of 100 records, refreshes
 * some of them, and a later client loads them from storage alone. The server is
 * in memory, so the timed work is fate's persistence over the storage. Untimed
 * check phases load every page again through a client whose server throws, and
 * compare every record with the model.
 */
type Ctx = PhaseContext<"fate">;

const pages = (ctx: Ctx) => Math.ceil(ctx.params.entries / PAGE);
const span = (ctx: Ctx, k: number) => ({ from: k * PAGE, to: Math.min(ctx.params.entries, (k + 1) * PAGE) });

function pageBytes(ctx: Ctx, k: number): number {
  const { from, to } = span(ctx, k);
  let bytes = 0;
  for (let i = from; i < to; i++) bytes += jsonBytes(record(i, ctx.model.version(i)));
  return bytes;
}

function bumpPage(ctx: Ctx, k: number): number {
  const { from, to } = span(ctx, k);
  for (let i = from; i < to; i++) ctx.model.bump(i);
  return to - from;
}

function phase(name: string, run: (ctx: Ctx, store: FateStore) => Promise<void>, extra: Partial<Phase<"fate">> = {}): Phase<"fate"> {
  return { name, page: "same", timed: true, ...extra, run: async (ctx) => run(ctx, await ctx.store()) };
}

function check(name: string, footprint: boolean): Phase<"fate"> {
  return phase(
    name,
    async (ctx, store) => {
      const { entries } = ctx.params;
      await verifyFromStorage(store.storage, ctx.model, entries, (i) => record(i, ctx.model.version(i)), ctx.check);
      await store.settle();
      let live = 0;
      for (let i = 0; i < entries; i++) live += jsonBytes(record(i, ctx.model.version(i)));
      ctx.carry.liveLogicalBytes = live;
    },
    { timed: false, footprint },
  );
}

export default defineWorkload({
  family: "fate",
  title: "fate request cache: save lists of 100 records, refresh a tenth of them, cold load every list (persistence budget 1 GiB, nothing evicted)",
  params: (size) => ({ entries: { tiny: 1_000, small: 10_000, large: 100_000 }[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: PAGE, ops: 0, seed: 1 }),
  phases: [
    phase("save", async (ctx, store) => {
      const { client } = worldFor(store.storage, ctx.model, { count: ctx.params.entries });
      for (let k = 0; k < pages(ctx); k++) {
        const records = bumpPage(ctx, k);
        await ctx.time(
          "save",
          pageBytes(ctx, k),
          async () => {
            await client.request(pageRequest(k) as never, { mode: "network-only" });
            await client.persistence!.flush();
          },
          records,
        );
      }
    }),
    check("check-save", true),
    phase("refresh", async (ctx, store) => {
      const { client } = worldFor(store.storage, ctx.model, { count: ctx.params.entries });
      for (const k of permutation(pages(ctx), ctx.rng).subarray(0, Math.max(1, Math.floor(pages(ctx) / 10)))) {
        const records = bumpPage(ctx, k);
        await ctx.time(
          "refresh",
          pageBytes(ctx, k),
          async () => {
            await client.request(pageRequest(k) as never, { mode: "network-only" });
            await client.persistence!.flush();
          },
          records,
        );
      }
    }),
    check("check-refresh", true),
    phase(
      "cold-load",
      async (ctx, store) => {
        const { client } = worldFor(store.storage, ctx.model, { count: ctx.params.entries, serve: false });
        for (let k = 0; k < pages(ctx); k++) {
          const { from, to } = span(ctx, k);
          await ctx.time("load", pageBytes(ctx, k), () => client.request(pageRequest(k) as never), to - from);
        }
        await ctx.time("flush", 0, () => client.persistence!.flush(), 0);
      },
      { page: "fresh" },
    ),
    check("check-cold", false),
  ],
});
