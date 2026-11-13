import { OWNERS, type OnDemandStore, type Todo, type TodoQuery } from "../../core/families.ts";
import { defineWorkload, type Phase, type PhaseContext } from "../../core/types.ts";
import { yieldTask } from "../../page/main-thread.ts";
import { permutation } from "../../page/model.ts";
import { ownerOf, rowBytes, todoId, todoRow } from "../../page/tanstack.ts";

/**
 * The todo rows of tanstack/todos in an on-demand collection: bulk inserts,
 * then a cold open and live queries that each load their own rows. A query is
 * timed from creating the live query to its first result, plus releasing it.
 * Every result is compared with the model. The query phases report main-thread
 * blocking and yield a macrotask between queries, as an app does between clicks.
 */
type Ctx = PhaseContext<"tanstack-ondemand">;

const TX_INSERT = 1_000;
const TX_UPDATE = 100;
const PAGE = 50;
const IDS = 10;

function checkRows(ctx: Ctx, got: readonly Todo[], want: readonly number[], what: string): void {
  ctx.check(got.length === want.length, `${what}: ${got.length} rows, want ${want.length}`);
  const byId = new Map(got.map((r) => [r.id, r]));
  for (const i of want) {
    const r = byId.get(todoId(i));
    const w = todoRow(i, ctx.model.version(i));
    ctx.check(
      r !== undefined && r.title === w.title && r.done === w.done && r.owner === w.owner && r.createdAt === w.createdAt,
      `${what}: row ${i} is ${r?.title}, want version ${ctx.model.version(i)}`,
    );
  }
}

const ownerRows = (ctx: Ctx, o: number) => {
  const out: number[] = [];
  for (let i = o; i < ctx.model.end; i += OWNERS) if (ctx.model.version(i) > 0) out.push(i);
  return out;
};

/** Times one live query from creation to release and returns its rows. */
async function run(ctx: Ctx, store: OnDemandStore, op: string, q: TodoQuery, count: number): Promise<readonly Todo[]> {
  let rows: readonly Todo[] = [];
  await ctx.time(
    op,
    0,
    async () => {
      const held = await store.hold(q);
      rows = held.rows;
      await held.release();
    },
    count,
  );
  await yieldTask();
  return rows;
}

function phase(name: string, body: (ctx: Ctx, store: OnDemandStore) => Promise<void>, extra: Partial<Phase<"tanstack-ondemand">> = {}): Phase<"tanstack-ondemand"> {
  return { name, page: "same", timed: true, ...extra, run: async (ctx) => body(ctx, await ctx.store()) };
}

/** Untimed: every owner's rows through a live query, compared with the model. */
function check(name: string, footprint: boolean): Phase<"tanstack-ondemand"> {
  return phase(
    name,
    async (ctx, store) => {
      await store.settle();
      let live = 0;
      for (let o = 0; o < OWNERS; o++) {
        const want = ownerRows(ctx, o);
        const held = await store.hold({ kind: "owner", owner: ownerOf(o) });
        checkRows(ctx, held.rows, want, `owner ${o}`);
        await held.release();
        for (const i of want) live += rowBytes(todoRow(i, ctx.model.version(i)));
      }
      ctx.carry.liveLogicalBytes = live;
    },
    { timed: false, footprint },
  );
}

export default defineWorkload({
  family: "tanstack-ondemand",
  title: "TanStack DB on-demand todo collection: bulk insert, cold open, live queries by owner, by page and by id, updates",
  params: (size) => {
    const entries = { tiny: 1_000, small: 100_000, large: 1_000_000 }[size];
    return { entries, keyBytes: 13, valueBytes: 100, compressibility: 0.5, batch: TX_INSERT, ops: entries / 100, seed: 1 };
  },
  phases: [
    phase("bulk-insert", async (ctx, store) => {
      const { entries, batch } = ctx.params;
      for (let i = 0; i < entries; i += batch) {
        const rows: Todo[] = [];
        for (let j = i; j < Math.min(entries, i + batch); j++) rows.push(todoRow(j, ctx.model.bump(j)));
        await ctx.time("insertMany", rows.reduce((t, r) => t + rowBytes(r), 0), () => store.insertMany(rows), rows.length);
      }
    }),
    check("check-inserts", true),
    phase("coldopen", async (ctx) => {
      await ctx.store();
    }, { page: "fresh" }),
    phase("first-query", async (ctx, store) => {
      const want = ownerRows(ctx, 0);
      checkRows(ctx, await run(ctx, store, "owner", { kind: "owner", owner: ownerOf(0) }, want.length), want, "first query");
    }, { mainThread: true }),
    phase("query-owner", async (ctx, store) => {
      for (let o = 0; o < OWNERS; o++) {
        const want = ownerRows(ctx, o);
        checkRows(ctx, await run(ctx, store, "owner", { kind: "owner", owner: ownerOf(o) }, want.length), want, `owner ${o}`);
      }
    }, { mainThread: true }),
    phase("query-page", async (ctx, store) => {
      for (let k = 0; k < ctx.params.ops; k++) {
        const o = Math.floor(ctx.rng() * OWNERS);
        const from = Math.floor(ctx.rng() * ctx.model.end);
        const want: number[] = [];
        for (let i = from + ((o - (from % OWNERS) + OWNERS) % OWNERS); i < ctx.model.end && want.length < PAGE; i += OWNERS) want.push(i);
        const got = await run(ctx, store, "page", { kind: "page", owner: ownerOf(o), from, limit: PAGE }, 1);
        checkRows(ctx, got, want, `page of owner ${o} from ${from}`);
        ctx.check(got.every((r, j) => j === 0 || got[j - 1]!.createdAt < r.createdAt), `page of owner ${o} from ${from} is not ascending`);
      }
    }, { page: "fresh", mainThread: true }),
    phase("query-ids", async (ctx, store) => {
      for (let k = 0; k < ctx.params.ops; k++) {
        const want = Array.from({ length: IDS }, () => Math.floor(ctx.rng() * ctx.model.end));
        const unique = [...new Set(want)];
        checkRows(ctx, await run(ctx, store, "ids", { kind: "ids", ids: unique.map(todoId) }, 1), unique, `ids ${unique[0]}…`);
      }
    }, { page: "fresh", mainThread: true }),
    phase("update", async (ctx, store) => {
      const perOwner = Math.ceil(ctx.params.entries / 10 / OWNERS);
      for (let o = 0; o < OWNERS; o++) {
        const held = await store.hold({ kind: "owner", owner: ownerOf(o) });
        const rows = ownerRows(ctx, o);
        const picked = [...permutation(rows.length, ctx.rng).subarray(0, perOwner)].map((k) => rows[k]!);
        for (let k = 0; k < picked.length; k += TX_UPDATE) {
          const next = new Map<string, Todo>();
          for (const i of picked.slice(k, k + TX_UPDATE)) next.set(todoId(i), todoRow(i, ctx.model.bump(i)));
          const bytes = [...next.values()].reduce((t, r) => t + rowBytes(r), 0);
          await ctx.time("updateMany", bytes, () => store.updateMany([...next.keys()], (r) => next.get(r.id)!), next.size);
        }
        await held.release();
      }
    }),
    check("check-after", true),
  ],
});
