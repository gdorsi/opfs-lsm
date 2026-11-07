import { Repo, splice, type AutomergeUrl } from "@automerge/react";
import { defineWorkload } from "../../core/types.ts";
import { countingAdapter } from "./trace.ts";

type Note = { title: string; body: string };
const EDITS = 20;

/** Many small notes (a title and a body typed in 20 changes), then a cold load of every note. */
export default defineWorkload({
  family: "automerge",
  title: "many small notes: create and flush, then cold load every note",
  params: (size) => ({ entries: { tiny: 20, small: 500, large: 5_000 }[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 1, ops: 0, seed: 1 }),
  phases: [
    {
      name: "persist",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const repo = new Repo({ storage: countingAdapter(store.adapter, (n) => ctx.bytes(n)), network: [] });
        const urls: string[] = [];
        for (let i = 0; i < ctx.params.entries; i++) {
          await ctx.time("create", 0, async () => {
            const h = repo.create<Note>({ title: `note ${i}`, body: "" });
            for (let e = 0; e < EDITS; e++) h.change((d) => splice(d, ["body"], d.body.length, 0, `line ${e} of note ${i}\n`));
            urls.push(h.url);
          });
        }
        await ctx.time("flush", 0, () => repo.flush());
        let bytes = 0;
        for (const url of urls) bytes += (await repo.export((await repo.find(url as AutomergeUrl)).documentId))?.byteLength ?? 0;
        ctx.carry.urls = urls;
        ctx.carry.liveLogicalBytes = bytes;
        await repo.shutdown();
      },
    },
    { name: "settle", page: "same", timed: false, footprint: true, run: async (ctx) => (await ctx.store()).settle() },
    {
      name: "load",
      page: "fresh",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const repo = new Repo({ storage: store.adapter, network: [] });
        const urls = ctx.carry.urls as string[];
        for (const [i, url] of urls.entries()) {
          const doc = await ctx.time("load", 0, async () => (await repo.find<Note>(url as AutomergeUrl)).doc());
          ctx.check(doc?.title === `note ${i}` && doc.body.split("\n").length === EDITS + 1, `note ${i} did not load intact`);
        }
      },
    },
  ],
});
