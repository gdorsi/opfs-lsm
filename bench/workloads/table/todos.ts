import type { TableStore, Todo } from "../../core/families.ts";
import { OWNERS } from "../../core/families.ts";
import { defineWorkload, type Phase, type PhaseContext } from "../../core/types.ts";
import { permutation } from "../../page/model.ts";

/**
 * RxDB's storage-comparison operations on a todo table with an owner index
 * and a createdAt index: first insert, bulk and serial inserts, gets by id
 * (bulk and one by one), index queries, updates, deletes, cold open.
 */
type Ctx = PhaseContext<"table">;

const row = (i: number, version: number): Todo => ({
  id: `todo-${String(i).padStart(8, "0")}`,
  title: `todo ${i} version ${version}: buy milk, eggs and bread`,
  done: version % 2 === 0,
  owner: `owner-${i % OWNERS}`,
  createdAt: i,
});
const idOf = (id: string) => Number(id.slice(5));

function verify(ctx: Ctx, i: number, got: Todo | undefined): void {
  const v = ctx.model.version(i);
  if (v === 0) return ctx.check(got === undefined, `row ${i} should be absent`);
  ctx.check(got !== undefined && got.title === row(i, v).title, `row ${i}: got ${got?.title}, want version ${v}`);
}

const write = (ctx: Ctx, i: number) => row(i, ctx.model.bump(i));
const rowBytes = (r: Todo) => JSON.stringify(r).length;

function phase(name: string, run: (ctx: Ctx, store: TableStore) => Promise<void>, extra: Partial<Phase<"table">> = {}): Phase<"table"> {
  return { name, page: "same", timed: true, ...extra, run: async (ctx) => run(ctx, await ctx.store()) };
}

function settle(name: string): Phase<"table"> {
  return phase(
    name,
    async (ctx, store) => {
      await store.settle();
      let live = 0;
      for (let i = 0; i < ctx.model.end; i++) if (ctx.model.version(i) > 0) live += rowBytes(row(i, ctx.model.version(i)));
      ctx.carry.liveLogicalBytes = live;
    },
    { timed: false, footprint: true },
  );
}

const SERIAL = 50;

export default defineWorkload({
  family: "table",
  title: "todo table: inserts, gets by id, index queries, updates, deletes, cold open",
  params: (size) => {
    const entries = { tiny: 1_000, small: 100_000, large: 1_000_000 }[size];
    return { entries, keyBytes: 13, valueBytes: 100, compressibility: 0.5, batch: 1_000, ops: Math.min(entries, 3_000), seed: 1 };
  },
  phases: [
    phase("first-insert", async (ctx, store) => {
      const r = write(ctx, 0);
      await ctx.time("put", rowBytes(r), () => store.put(r));
    }),
    phase("bulk-insert", async (ctx, store) => {
      const { entries, batch } = ctx.params;
      for (let i = 1; i < entries; i += batch) {
        const rows: Todo[] = [];
        for (let j = i; j < Math.min(entries, i + batch); j++) rows.push(write(ctx, j));
        await ctx.time("putMany", rows.reduce((t, r) => t + rowBytes(r), 0), () => store.putMany(rows), rows.length);
      }
    }),
    phase("serial-insert", async (ctx, store) => {
      for (let i = ctx.params.entries; i < ctx.params.entries + SERIAL; i++) {
        const r = write(ctx, i);
        await ctx.time("put", rowBytes(r), () => store.put(r));
      }
    }),
    settle("settle"),
    phase("get-bulk", async (ctx, store) => {
      const ids = permutation(ctx.params.entries, ctx.rng).subarray(0, ctx.params.ops);
      const rows = await ctx.time("getMany", 0, () => store.getMany([...ids].map((i) => row(i, 0).id)), ids.length);
      ids.forEach((i, k) => verify(ctx, i, rows[k]));
    }),
    phase("get-serial", async (ctx, store) => {
      for (let k = 0; k < ctx.params.ops; k++) {
        const i = Math.floor(ctx.rng() * ctx.params.entries);
        verify(ctx, i, await ctx.time("get", 0, () => store.get(row(i, 0).id)));
      }
    }),
    phase("where-owner", async (ctx, store) => {
      for (let o = 0; o < OWNERS; o++) {
        const rows = await ctx.time("where", 0, () => store.whereOwner(`owner-${o}`));
        let want = 0;
        for (let i = o; i < ctx.model.end; i += OWNERS) if (ctx.model.version(i) > 0) want++;
        ctx.check(rows.length === want, `owner-${o}: ${rows.length} rows, want ${want}`);
        for (const r of rows.slice(0, 50)) verify(ctx, idOf(r.id), r);
      }
    }),
    phase("page-created", async (ctx, store) => {
      for (let k = 0; k < 100; k++) {
        const from = Math.floor(ctx.rng() * ctx.params.entries);
        const rows = await ctx.time("page", 0, () => store.pageByCreated(from, 100));
        let prev = from - 1;
        for (const r of rows) {
          ctx.check(r.createdAt > prev, `page out of order at ${r.createdAt}`);
          prev = r.createdAt;
          verify(ctx, idOf(r.id), r);
        }
        ctx.check(rows.length === Math.min(100, ctx.model.end - from), `page from ${from}: ${rows.length} rows`);
      }
    }),
    phase("update", async (ctx, store) => {
      for (let k = 0; k < Math.min(1_000, ctx.params.entries); k++) {
        const i = Math.floor(ctx.rng() * ctx.params.entries);
        const next = write(ctx, i);
        await ctx.time("update", rowBytes(next), () => store.update(next.id, () => next));
      }
    }),
    phase("delete", async (ctx, store) => {
      const ids = permutation(ctx.params.entries, ctx.rng).subarray(0, Math.min(1_000, ctx.params.entries / 10));
      for (let k = 0; k < ids.length; k += 100) {
        const slice = [...ids.subarray(k, k + 100)];
        for (const i of slice) ctx.model.remove(i);
        await ctx.time("deleteMany", slice.length * 13, () => store.deleteMany(slice.map((i) => row(i, 0).id)), slice.length);
      }
    }),
    settle("settle-after"),
    phase(
      "coldopen",
      async (ctx, store) => {
        const i = Math.floor(ctx.rng() * ctx.params.entries);
        verify(ctx, i, await ctx.time("first get", 0, () => store.get(row(i, 0).id)));
      },
      { page: "fresh" },
    ),
  ],
});
