import { defineWorkload, type Phase, type PhaseContext } from "../../core/types.ts";
import { buildServer, currentWorld, openWorld, shows } from "../../page/linearlite.ts";
import { yieldTask } from "../../page/main-thread.ts";
import { STATUSES, type StatusCode } from "../../../examples/linearlite-tanstackdb/src/domain/model.ts";
import { parseIssueFilter, SORT_FIELDS, type IssueFilter } from "../../../examples/linearlite-tanstackdb/src/model/filter.ts";
import { LIST_WINDOW, type Thread } from "../../../examples/linearlite-tanstackdb/src/model/views.ts";

type Ctx = PhaseContext<"linearlite">;

const ISSUES = { tiny: 1_000, small: 100_000, large: 1_000_000 } as const;
const HOME = parseIssueFilter({});
/** Rows a board column holds, as the model sizes it. */
const COLUMN_WINDOW = 50;
const THREADS = 20;
const WORDS_TYPED = 3;

/** What the phases do, chosen once from the oracle's rows so every contender does the same interactions. */
type Plan = {
  readonly sorts: readonly IssueFilter[];
  readonly filters: readonly IssueFilter[];
  readonly typed: readonly IssueFilter[];
  readonly jumps: readonly number[];
  readonly boards: readonly IssueFilter[];
  readonly threads: readonly string[];
};
let plan: Plan | undefined;
const planned = (): Plan => {
  if (!plan) throw new Error("no plan: the prepare phase did not run on this page");
  return plan;
};

const same = (a: readonly number[] | undefined, b: readonly number[]) => a !== undefined && a.join() === b.join();

function phase(name: string, extra: Partial<Phase<"linearlite">>, run: (ctx: Ctx) => Promise<void>): Phase<"linearlite"> {
  return { name, page: "same", timed: true, idleFirst: true, ...extra, run };
}

/** A list under `filter` that shows its first rows, and its total, as the oracle has them. Kept on screen only when `commit` is set. */
async function showList(ctx: Ctx, filter: IssueFilter, op: string, commit = true) {
  const world = currentWorld();
  const { reference } = world.server;
  ctx.progress(`${op} ${filter.sort} ${filter.dir} status=${filter.status} priority=${filter.priority} q=${filter.q}`);
  const held = world.screen.hold(world.model.issues.list(filter));
  const total = reference.total(filter);
  const rows = Math.min(LIST_WINDOW, total);
  const ready = (v: { rows: readonly object[]; total: number | undefined }) =>
    v.total === total && v.rows.length === rows && reference.window(filter, 0, 1, v.rows.slice(0, 1)) === undefined;
  const view = await ctx.time(op, 0, () => shows(held, ready, () => reference.window(filter, 0, LIST_WINDOW, held.get().rows) ?? `total ${held.get().total}, want ${total}`));
  world.later(`${op} ${JSON.stringify(filter)}`, () => reference.window(filter, 0, LIST_WINDOW, view.rows));
  if (commit) world.screen.commit();
}

async function showCounts(ctx: Ctx, filter: IssueFilter, op: string) {
  const world = currentWorld();
  const { reference } = world.server;
  const held = world.screen.hold(world.model.issues.counts(filter));
  const want = reference.counts(filter);
  const counts = await ctx.time(op, 0, () => shows(held, (c) => same(c, want), () => `counts ${held.get()?.join()}, the server has ${want.join()}`));
  world.later(`${op} ${JSON.stringify(filter)}`, () => (same(counts, want) ? undefined : `${counts?.join()} want ${want.join()}`));
}

/**
 * Opens the app on a replica that is already synced and moves through its screens the way a user does: the list under
 * each sort, status and priority filters with their counts, a search typed key by key, jumps deep into the list, the
 * board, and the threads of issues the replica holds or must fetch. Every view must show what the oracle computes from
 * the server's rows. The first screen is timed from a cold tab, so it pays for opening the backend; the other screens
 * are timed warm.
 */
export default defineWorkload({
  family: "linearlite",
  title: "browse: open the app on a synced replica, sort, filter, search, jump deep, open the board and the threads",
  params: (size) => ({ entries: ISSUES[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 2_000, ops: 0, seed: 1 }),
  phases: [
    phase("seed", { timed: false, footprint: true }, async (ctx) => {
      const store = await ctx.store();
      const world = openWorld(store, ctx.params.entries);
      world.lead();
      await world.settled();
      await store.settle();
      ctx.carry.liveLogicalBytes = world.server.issueBytes;
      await world.stop();
    }),
    phase("build-server", { page: "fresh", timed: false }, async (ctx) => void buildServer(ctx.params.entries)),
    phase("cold-open", { mainThread: true }, async (ctx) => {
      const world = openWorld(await ctx.store(), ctx.params.entries);
      world.lead();
      const settled = world.settled();
      const { reference } = world.server;
      const list = world.model.issues.list(HOME);
      const held = world.screen.hold(list);
      const want = Math.min(LIST_WINDOW, ctx.params.entries);
      const view = await ctx.time("first-rows", 0, () => shows(held, (v) => v.rows.length === want && reference.window(HOME, 0, 1, v.rows.slice(0, 1)) === undefined, () => reference.window(HOME, 0, want, held.get().rows) ?? `${held.get().rows.length} rows of ${want}`));
      world.later("the first rows", () => reference.window(HOME, 0, want, view.rows));
      await ctx.time("total", 0, () => shows(held, (v) => v.total === reference.total(HOME), () => `total ${held.get().total}`));
      world.screen.commit();
      await showCounts(ctx, HOME, "counts");
      world.screen.commit();
      await settled;
    }),
    phase("prepare", { timed: false }, async (ctx) => {
      const { reference, server } = currentWorld().server;
      const home = reference.list(HOME);
      const titles = home.map((i) => i.title.toLowerCase().split(" ").filter((w) => w.length >= 5));
      const typed: IssueFilter[] = [];
      for (let w = 0; w < WORDS_TYPED; w++) {
        const word = titles[Math.floor(ctx.rng() * titles.length)]?.[0] ?? "lorem";
        for (let k = 1; k <= word.length; k++) typed.push(parseIssueFilter({ q: word.slice(0, k) }));
      }
      const ids = [...server.rows().issues.keys()];
      const threads = new Set<string>();
      while (threads.size < Math.min(THREADS, ids.length)) threads.add(ids[Math.floor(ctx.rng() * ids.length)]!);
      plan = {
        sorts: [...SORT_FIELDS.filter((s) => s !== "modified").map((sort) => parseIssueFilter({ sort })), parseIssueFilter({ sort: "modified", dir: "asc" }), HOME],
        filters: [
          ...STATUSES.map((_, s) => parseIssueFilter({ status: String(s) })),
          ...STATUSES.map((_, p) => parseIssueFilter({ priority: String(p) })),
          parseIssueFilter({ status: "1,2", priority: "0,1" }),
          parseIssueFilter({ status: "1,2", priority: "0,1", sort: "priority" }),
        ],
        typed,
        jumps: [0.05, 0.5, 0.9].map((at) => Math.floor(ctx.params.entries * at)),
        boards: [HOME, parseIssueFilter({ priority: "0,1" })],
        threads: [...threads],
      };
      // The oracle sorts and filters the whole server per view, which a timed phase must not pay for.
      for (const filter of [...plan.sorts, ...plan.filters, ...plan.typed, ...plan.boards]) {
        reference.list(filter);
        reference.counts(filter);
        for (let s = 0; s < STATUSES.length; s++) reference.board(filter, s);
      }
    }),
    phase("sort", { mainThread: true }, async (ctx) => {
      for (const filter of planned().sorts) {
        await showList(ctx, filter, "sort");
        await yieldTask();
      }
    }),
    phase("filter", { mainThread: true }, async (ctx) => {
      for (const filter of planned().filters) {
        await showList(ctx, filter, "filter", false);
        await showCounts(ctx, filter, "filter-counts");
        currentWorld().screen.commit();
        await yieldTask();
      }
    }),
    phase("search", { mainThread: true }, async (ctx) => {
      for (const filter of planned().typed) {
        await showList(ctx, filter, "keystroke", false);
        await showCounts(ctx, filter, "keystroke-counts");
        currentWorld().screen.commit();
        await yieldTask();
      }
    }),
    phase("jump", { mainThread: true }, async (ctx) => {
      const world = currentWorld();
      const list = world.model.issues.list(HOME);
      const held = world.screen.hold(list);
      const { reference } = world.server;
      await shows(held, (v) => v.rows.length > 0 && v.total === reference.total(HOME), () => "the list did not open");
      for (const from of planned().jumps) {
        const rows = Math.min(LIST_WINDOW, reference.total(HOME) - from);
        list.setRange(from, from + LIST_WINDOW);
        const view = await ctx.time("jump", 0, () =>
          shows(held, (v) => v.offset === from && v.rows.length === rows && reference.window(HOME, from, 1, v.rows.slice(0, 1)) === undefined, () => reference.window(HOME, from, LIST_WINDOW, held.get().rows) ?? `offset ${held.get().offset}, want ${from}`),
        );
        world.later(`jump to row ${from}`, () => reference.window(HOME, from, LIST_WINDOW, view.rows));
        await yieldTask();
      }
      world.screen.commit();
    }),
    phase("board", { mainThread: true }, async (ctx) => {
      const world = currentWorld();
      const { reference } = world.server;
      for (const filter of planned().boards) {
        const columns = await ctx.time("board", 0, async () => {
          const held = STATUSES.map((_, status) => ({ status, column: world.screen.hold(world.model.issues.column(filter, status as StatusCode)) }));
          const counts = world.screen.hold(world.model.issues.counts(filter));
          const want = reference.counts(filter);
          const shown = await Promise.all(
            held.map(({ status, column }) => {
              const rows = Math.min(COLUMN_WINDOW, reference.board(filter, status).length);
              return shows(column, (v) => v.rows.length === rows && reference.column(filter, status, 0, 1, v.rows.slice(0, 1)) === undefined, () => reference.column(filter, status, 0, COLUMN_WINDOW, column.get().rows) ?? `${column.get().rows.length} rows of ${rows}`);
            }),
          );
          await shows(counts, (c) => same(c, want), () => `counts ${counts.get()?.join()}, the server has ${want.join()}`);
          return shown;
        });
        columns.forEach((view, status) => world.later(`board column ${status} of ${JSON.stringify(filter)}`, () => reference.column(filter, status, 0, COLUMN_WINDOW, view.rows)));
        world.screen.commit();
        await yieldTask();
      }
    }),
    phase("threads", { mainThread: true }, async (ctx) => {
      const world = currentWorld();
      const { reference } = world.server;
      /** What the thread shows, in the shape the oracle compares. */
      const shown = (t: Thread) => ({ description: t.kind === "ready" ? t.body.description : undefined, comments: t.kind === "loading" ? [] : t.comments });
      // The model shows a thread's body as soon as it lands and its comments a moment later, so the view is ready once both are in.
      for (const op of ["thread-fetch", "thread-held"]) {
        for (const id of planned().threads) {
          const held = world.screen.hold(world.model.issues.thread(id));
          const thread = await ctx.time(op, 0, () => shows(held, (t) => t.kind !== "loading" && reference.sameThread(id, shown(t)) === undefined, () => reference.sameThread(id, shown(held.get())) ?? "loading"));
          world.later(`${op} ${id}`, () => reference.sameThread(id, shown(thread)));
          world.screen.commit();
          await yieldTask();
        }
      }
    }),
    phase("check", { timed: false }, async (ctx) => {
      const world = currentWorld();
      await world.settled();
      world.verify(ctx.check);
      await world.stop();
    }),
  ],
});
