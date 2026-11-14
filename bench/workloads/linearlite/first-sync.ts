import { defineWorkload, type Phase, type PhaseContext } from "../../core/types.ts";
import { buildServer, currentWorld, openWorld, shows } from "../../page/linearlite.ts";
import { LIST_WINDOW } from "../../../examples/linearlite-tanstackdb/src/model/views.ts";
import { parseIssueFilter } from "../../../examples/linearlite-tanstackdb/src/model/filter.ts";
import { STREAMS } from "../../../examples/linearlite-tanstackdb/src/domain/stores.ts";

type Ctx = PhaseContext<"linearlite">;

const ISSUES = { tiny: 1_000, small: 100_000, large: 1_000_000 } as const;
const HOME = parseIssueFilter({});
/** Rows per `getMany` or `read` while the replica is compared with the server. */
const CHECK_CHUNK = 5_000;

function phase(name: string, extra: Partial<Phase<"linearlite">>, run: (ctx: Ctx) => Promise<void>): Phase<"linearlite"> {
  return { name, page: "same", timed: true, ...extra, run };
}

/**
 * A new tab's first visit to the app: the replica is empty, so the leader pulls every issue from the server in pages
 * of 2,000 while the list on screen fills. The server is in memory, so the timed work is the model's sync loop and
 * the storage under it, plus the memory transport's JSON copy of each page, which is the same for every contender.
 * The oracle compares the first rows when they appear, and after the sync every stored issue with the server's.
 */
export default defineWorkload({
  family: "linearlite",
  title: "first sync: an empty tab pulls every issue while the issue list fills",
  params: (size) => ({ entries: ISSUES[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 2_000, ops: 0, seed: 1 }),
  phases: [
    phase("build-server", { timed: false }, async (ctx) => void buildServer(ctx.params.entries)),
    phase("first-sync", { mainThread: true }, async (ctx) => {
      const { reference, issueBytes } = buildServer(ctx.params.entries);
      const world = openWorld(await ctx.store(), ctx.params.entries);
      const list = world.model.issues.list(HOME);
      const want = Math.min(LIST_WINDOW, ctx.params.entries);
      await ctx.time(
        "catch-up",
        issueBytes,
        async () => {
          world.lead();
          const settled = world.settled();
          const held = world.screen.hold(list);
          const first = await ctx.time("first-rows", 0, () => shows(held, (v) => v.rows.length >= want, () => `${held.get().rows.length} rows of ${want}`), 0);
          world.later("the first rows", () => reference.window(HOME, 0, want, first.rows));
          await settled;
        },
        ctx.params.entries,
      );
      world.screen.commit();
      const total = world.screen.hold(list);
      const counts = world.screen.hold(world.model.issues.counts(HOME));
      world.screen.commit();
      await ctx.time("total", 0, () => shows(total, (v) => v.total === reference.total(HOME), () => `total ${total.get().total}, the server has ${reference.total(HOME)}`));
      const per = await ctx.time(
        "counts",
        0,
        () => shows(counts, (c) => c !== undefined && c.join() === reference.counts(HOME).join(), () => `counts ${counts.get()?.join()}, the server has ${reference.counts(HOME).join()}`),
      );
      world.later("the counts", () => (per!.join() === reference.counts(HOME).join() ? undefined : `${per!.join()} want ${reference.counts(HOME).join()}`));
      world.later("the list", () => reference.window(HOME, 0, LIST_WINDOW, total.get().rows));
    }),
    phase("check-sync", { timed: false, footprint: true }, async (ctx) => {
      const store = await ctx.store();
      const world = currentWorld();
      const { server, reference, issueBytes } = world.server;
      await world.settled();
      world.verify(ctx.check);
      const ids = [...server.rows().issues.keys()];
      for (let at = 0; at < ids.length; at += CHECK_CHUNK) {
        const slice = ids.slice(at, at + CHECK_CHUNK);
        const stored = await store.backend.read("issues", slice);
        for (const [i, id] of slice.entries()) {
          const wrong = reference.row("issues", id, stored[i]);
          if (wrong) ctx.check(false, wrong);
        }
      }
      const [sync] = await store.backend.read("sync", ["sync"]);
      ctx.check(STREAMS.every((s) => sync?.caughtUp[s]) && sync?.cursors.issues === server.head(), `the sync row after the first sync: ${JSON.stringify(sync)}`);
      const threads = await store.backend.read("bodies", ids.slice(0, 200));
      ctx.check(threads.every((b) => b === undefined), "a first sync pulled a body: threads load when an issue is opened");
      await store.settle();
      ctx.carry.liveLogicalBytes = issueBytes;
      await world.stop();
    }),
  ],
});
