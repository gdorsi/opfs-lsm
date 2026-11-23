import { hashKey, type QueryClient } from "@tanstack/query-core";
import type { QueryStore } from "../../core/families.ts";
import type { Json } from "../../core/goals.ts";
import { defineWorkload, type Phase, type PhaseContext } from "../../core/types.ts";
import { permutation } from "../../page/model.ts";
import { catalogFor, queryCount, worldFor, type QueryCatalog } from "../../page/tanstack-query.ts";
import { differ } from "../goals-lib.ts";

/**
 * TanStack Query's per-query persister on the tracker workspace: list and
 * detail queries persisted one entry each, restored cold in a fresh tab, then
 * refetched in bursts while the app is open. The server is in memory, so the
 * timed work is TanStack's persister and the storage under it. Every restore
 * is compared with the model, query by query.
 */
type Ctx = PhaseContext<"tanstack-query">;

/** The queries one window focus refetches: the lists and the issue on screen. */
const BURST = 10;
const BURSTS = 20;

const catalog = (ctx: Ctx) => catalogFor(ctx.size, ctx.params.seed);

function checkCache(ctx: Ctx, client: QueryClient, cat: QueryCatalog): void {
  const cached = client.getQueryCache().getAll().length;
  ctx.check(cached === cat.keys.length, `the cache holds ${cached} queries, want ${cat.keys.length}`);
  cat.keys.forEach((key, i) => {
    const diff = differ((client.getQueryData(key) ?? null) as Json, cat.answer(i, ctx.model.version(i)));
    ctx.check(diff === undefined, `query ${hashKey(key)}: ${diff}`);
  });
}

function phase(name: string, run: (ctx: Ctx, store: QueryStore, cat: QueryCatalog) => Promise<void>, extra: Partial<Phase<"tanstack-query">> = {}): Phase<"tanstack-query"> {
  return {
    name,
    page: "same",
    timed: true,
    ...extra,
    async run(ctx) {
      const cat = catalog(ctx);
      await run(ctx, await ctx.store(), cat);
    },
  };
}

export default defineWorkload({
  family: "tanstack-query",
  title: `TanStack Query cache on the tracker workspace: restore every list and detail query cold, refetch ${BURSTS} bursts of ${BURST} queries`,
  owns: ["tanstack-query-cache"],
  params: (size) => ({ entries: queryCount(size), keyBytes: 0, valueBytes: 0, compressibility: 0, batch: BURST, ops: BURST * BURSTS }),
  phases: [
    phase(
      "fill",
      async (ctx, store, cat) => {
        const { client, fetchAndPersist } = worldFor(store, ctx.model, cat);
        for (let i = 0; i < cat.keys.length; i++) ctx.model.bump(i);
        await fetchAndPersist(cat.keys);
        checkCache(ctx, client, cat);
      },
      { timed: false },
    ),
    phase(
      "restore",
      async (ctx, store, cat) => {
        const { client, restore } = worldFor(store, ctx.model, cat);
        await ctx.time("restore", cat.totalBytes, restore, cat.keys.length);
        checkCache(ctx, client, cat);
      },
      { page: "fresh" },
    ),
    phase("refetch", async (ctx, store, cat) => {
      const { client, fetchAndPersist } = worldFor(store, ctx.model, cat);
      const bursts = Array.from({ length: BURSTS }, () => [...permutation(cat.keys.length, ctx.rng).subarray(0, BURST)]);
      for (const burst of bursts) {
        for (const i of burst) ctx.model.bump(i);
        await ctx.time(
          "refetch",
          burst.reduce((n, i) => n + cat.bytes[i]!, 0),
          () => fetchAndPersist(burst.map((i) => cat.keys[i]!)),
          burst.length,
        );
      }
      checkCache(ctx, client, cat);
    }),
    phase(
      "check-refetch",
      async (ctx, store, cat) => {
        const { client, restore } = worldFor(store, ctx.model, cat);
        await restore();
        checkCache(ctx, client, cat);
        await store.settle();
        ctx.carry.liveLogicalBytes = cat.totalBytes;
      },
      { page: "fresh", timed: false, footprint: true },
    ),
  ],
});
