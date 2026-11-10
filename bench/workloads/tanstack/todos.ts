import { OWNERS, type CollectionStore, type Todo } from "../../core/families.ts";
import { defineWorkload, type Phase, type PhaseContext } from "../../core/types.ts";
import { permutation } from "../../page/model.ts";

/**
 * The todo rows of the table family written through a TanStack DB collection:
 * first insert, bulk inserts in transactions of 1,000, serial single-row
 * transactions, updates and deletes in transactions of 100, then a cold open
 * that loads every row. Untimed check phases compare the whole collection with
 * the model, so a number cannot come from work that did not persist.
 */
type Ctx = PhaseContext<"tanstack">;

const row = (i: number, version: number): Todo => ({
  id: `todo-${String(i).padStart(8, "0")}`,
  title: `todo ${i} version ${version}: buy milk, eggs and bread`,
  done: version % 2 === 0,
  owner: `owner-${i % OWNERS}`,
  createdAt: i,
});
const rowBytes = (r: Todo) => JSON.stringify(r).length;
const write = (ctx: Ctx, i: number) => row(i, ctx.model.bump(i));

function verify(ctx: Ctx, i: number, got: Todo | undefined): void {
  const v = ctx.model.version(i);
  if (v === 0) return ctx.check(got === undefined, `row ${i} should be absent`);
  const want = row(i, v);
  ctx.check(
    got !== undefined && got.title === want.title && got.done === want.done && got.owner === want.owner && got.createdAt === want.createdAt,
    `row ${i}: got ${got?.title}, want version ${v}`,
  );
}

function verifyAll(ctx: Ctx, store: CollectionStore): void {
  for (let i = 0; i < ctx.model.end; i++) verify(ctx, i, store.get(row(i, 0).id));
  ctx.check(store.size() === ctx.model.liveKeys(), `collection holds ${store.size()} rows, want ${ctx.model.liveKeys()}`);
}

function phase(name: string, run: (ctx: Ctx, store: CollectionStore) => Promise<void>, extra: Partial<Phase<"tanstack">> = {}): Phase<"tanstack"> {
  return { name, page: "same", timed: true, ...extra, run: async (ctx) => run(ctx, await ctx.store()) };
}

/** Untimed: wait for the store to rest, then check every row, so the timed phases carry no checking. */
function check(name: string, footprint: boolean): Phase<"tanstack"> {
  return phase(
    name,
    async (ctx, store) => {
      await store.settle();
      verifyAll(ctx, store);
      let live = 0;
      for (let i = 0; i < ctx.model.end; i++) if (ctx.model.version(i) > 0) live += rowBytes(row(i, ctx.model.version(i)));
      ctx.carry.liveLogicalBytes = live;
    },
    { timed: false, footprint },
  );
}

const TX_INSERT = 1_000;
const TX_CHANGE = 100;

export default defineWorkload({
  family: "tanstack",
  title: "TanStack DB todo collection: first insert, bulk and serial inserts, updates, deletes, cold open",
  params: (size) => {
    const entries = { tiny: 1_000, small: 100_000, large: 1_000_000 }[size];
    return { entries, keyBytes: 13, valueBytes: 100, compressibility: 0.5, batch: TX_INSERT, ops: entries / 10, seed: 1 };
  },
  phases: [
    phase("first-insert", async (ctx, store) => {
      const r = write(ctx, 0);
      await ctx.time("insert", rowBytes(r), () => store.insert(r));
      verify(ctx, 0, store.get(r.id));
      ctx.check(store.size() === 1, `collection holds ${store.size()} rows after the first insert`);
    }),
    phase("bulk-insert", async (ctx, store) => {
      const { entries, batch } = ctx.params;
      for (let i = 1; i < entries; i += batch) {
        const rows: Todo[] = [];
        for (let j = i; j < Math.min(entries, i + batch); j++) rows.push(write(ctx, j));
        await ctx.time("insertMany", rows.reduce((t, r) => t + rowBytes(r), 0), () => store.insertMany(rows), rows.length);
      }
    }),
    phase("serial-insert", async (ctx, store) => {
      const { entries } = ctx.params;
      for (let i = entries; i < entries + entries / 100; i++) {
        const r = write(ctx, i);
        await ctx.time("insert", rowBytes(r), () => store.insert(r));
      }
    }),
    check("check-inserts", true),
    phase("update", async (ctx, store) => {
      const ids = permutation(ctx.model.end, ctx.rng).subarray(0, ctx.params.ops);
      for (let k = 0; k < ids.length; k += TX_CHANGE) {
        const next = new Map<string, Todo>();
        for (const i of ids.subarray(k, k + TX_CHANGE)) next.set(row(i, 0).id, write(ctx, i));
        const bytes = [...next.values()].reduce((t, r) => t + rowBytes(r), 0);
        await ctx.time("updateMany", bytes, () => store.updateMany([...next.keys()], (r) => next.get(r.id)!), next.size);
      }
    }),
    phase("delete", async (ctx, store) => {
      const ids = permutation(ctx.model.end, ctx.rng).subarray(0, ctx.params.ops);
      for (let k = 0; k < ids.length; k += TX_CHANGE) {
        const slice = [...ids.subarray(k, k + TX_CHANGE)];
        for (const i of slice) ctx.model.remove(i);
        await ctx.time("deleteMany", slice.length * 13, () => store.deleteMany(slice.map((i) => row(i, 0).id)), slice.length);
      }
    }),
    check("check-after", true),
    phase("coldopen", async (ctx) => {
      await ctx.store();
    }, { page: "fresh" }),
    check("check-cold", false),
  ],
});
