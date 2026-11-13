import type { FateStore } from "../../core/families.ts";
import { defineWorkload, type Phase, type PhaseContext } from "../../core/types.ts";
import { disposeWorld, jsonBytes, journalEntries, PAGE, pageRequest, record, renamed, verifyFromStorage, worldFor, type FateClient } from "../../page/fate.ts";

/**
 * fate's offline mutation queue. A client that is offline renames M records,
 * each saved to the journal before it is applied; a new client on a fresh page
 * restores the journal and delivers every mutation, one at a time, to an
 * in-memory server that logs what it receives. The records are loaded by an
 * untimed first request, as in an app that edits a list it already shows, so
 * each journal entry carries the record it changes.
 */
type Ctx = PhaseContext<"fate">;

const pages = (ctx: Ctx) => Math.ceil(ctx.params.entries / PAGE);

function phase(name: string, run: (ctx: Ctx, store: FateStore) => Promise<void>, extra: Partial<Phase<"fate">> = {}): Phase<"fate"> {
  return { name, page: "same", timed: true, ...extra, run: async (ctx) => run(ctx, await ctx.store()) };
}

/** Resolves once every mutation is delivered and the journal's confirmed entries are removed; rejects on a failed mutation or a persistence error. */
function drained(client: FateClient): Promise<void> {
  const session = client.persistence!;
  return new Promise<void>((resolve, reject) => {
    const look = () => {
      const snapshot = session.getSnapshot();
      const failed = snapshot.mutations.find((m) => m.status === "failed");
      const problem = snapshot.error ?? (failed ? new Error(`mutation ${failed.id} failed: ${failed.error}`) : undefined);
      if (problem || snapshot.mutations.length === 0) {
        unsubscribe();
        if (problem) reject(problem);
        else resolve();
      }
    };
    const unsubscribe = session.subscribe(look);
    look();
  }).then(() => session.flush());
}

export default defineWorkload({
  family: "fate",
  title: "fate offline mutation queue: queue renames while offline, then restore the journal and deliver (persistence budget 1 GiB, nothing evicted)",
  params: (size) => ({ entries: { tiny: 100, small: 300, large: 1_000 }[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: PAGE, ops: 0, seed: 1 }),
  phases: [
    phase(
      "seed",
      async (ctx, store) => {
        const { client } = worldFor(store.storage, ctx.model, { count: ctx.params.entries, online: false });
        for (let i = 0; i < ctx.params.entries; i++) ctx.model.bump(i);
        for (let k = 0; k < pages(ctx); k++) await client.request(pageRequest(k) as never, { mode: "network-only" });
        await client.persistence!.flush();
      },
      { timed: false },
    ),
    phase("queue-offline", async (ctx, store) => {
      const { client } = worldFor(store.storage, ctx.model, { count: ctx.params.entries, online: false });
      for (let i = 0; i < ctx.params.entries; i++) {
        const input = renamed(i);
        await ctx.time(
          "queue",
          jsonBytes(input),
          async () => {
            const pending = client.mutations.renameIssue({ input, optimistic: { title: input.title } });
            // The mutation settles only when it is delivered, or rejects if this client is disposed first.
            pending.catch(() => {});
            await pending.locallyPersisted;
          },
        );
      }
    }),
    phase(
      "check-queue",
      async (ctx, store) => {
        const { client, source } = worldFor(store.storage, ctx.model, { count: ctx.params.entries, online: false });
        const { mutations, status, error } = client.persistence!.getSnapshot();
        ctx.check(status === "ready" && error === undefined, `persistence is ${status}: ${error?.message}`);
        ctx.check(mutations.length === ctx.params.entries, `the snapshot lists ${mutations.length} mutations, want ${ctx.params.entries}`);
        mutations.forEach((m, i) => {
          const want = renamed(i);
          const input = m.input as { id?: string; title?: string };
          ctx.check(m.status === "queued" && m.name === "renameIssue" && input.id === want.id && input.title === want.title, `queued mutation ${i}: ${JSON.stringify(m)}`);
        });
        const saved = await journalEntries(store.storage);
        ctx.check(saved === ctx.params.entries, `storage holds ${saved} journal entries, want ${ctx.params.entries}`);
        ctx.check(source.delivered.length === 0, `${source.delivered.length} mutations reached the server while offline`);
        disposeWorld(store.storage);
        await store.settle();
        ctx.carry.liveLogicalBytes = ctx.params.entries * (jsonBytes(record(0, 1)) + jsonBytes(renamed(0)));
      },
      { timed: false, footprint: true },
    ),
    phase(
      "deliver",
      async (ctx, store) => {
        const { client } = worldFor(store.storage, ctx.model, { count: ctx.params.entries });
        const session = client.persistence!;
        await ctx.time("restore", 0, () => session.ready, 0);
        ctx.check(session.getSnapshot().mutations.length === ctx.params.entries, `${session.getSnapshot().mutations.length} mutations restored, want ${ctx.params.entries}`);
        let bytes = 0;
        for (let i = 0; i < ctx.params.entries; i++) bytes += jsonBytes(renamed(i));
        await ctx.time("deliver", bytes, () => drained(client), ctx.params.entries);
      },
      { page: "fresh" },
    ),
    phase(
      "check-deliver",
      async (ctx, store) => {
        const { client, source } = worldFor(store.storage, ctx.model, { count: ctx.params.entries });
        const { delivered } = source;
        ctx.check(delivered.length === ctx.params.entries, `the server received ${delivered.length} mutations, want ${ctx.params.entries}`);
        const ids = new Set(delivered.map((d) => d.id));
        ctx.check(ids.size === delivered.length, `${delivered.length - ids.size} mutations reached the server twice`);
        delivered.forEach((d, i) => {
          const want = renamed(i);
          ctx.check(d.input.id === want.id && d.input.title === want.title, `delivery ${i} was ${JSON.stringify(d.input)}, want ${JSON.stringify(want)}`);
        });
        ctx.check(client.persistence!.getSnapshot().mutations.length === 0, "the snapshot still lists mutations");
        const left = await journalEntries(store.storage);
        ctx.check(left === 0, `storage still holds ${left} journal entries`);
        await verifyFromStorage(store.storage, ctx.model, ctx.params.entries, (i) => ({ ...record(i, 1), title: renamed(i).title }), ctx.check);
      },
      { timed: false },
    ),
  ],
});
