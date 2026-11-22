import { Repo, splice, type AutomergeUrl } from "@automerge/react";
import { defineWorkload } from "../../core/types.ts";
import { EDITS, noteBody, noteLine, noteTitle } from "../notes.ts";
import { countingAdapter } from "./trace.ts";

type Note = { title: string; body: string };

/** The repo `persist` writes through, kept on the page for the untimed `export` that measures and closes it. */
let session: { readonly repo: Repo; readonly urls: readonly string[] } | undefined;

/** Many small notes (a title and a body typed in 20 changes), then a cold load of every note. */
export default defineWorkload({
  family: "automerge",
  title: "many small notes: create and flush, then cold load every note",
  owns: ["automerge-many-docs"],
  params: (size) => ({ entries: { tiny: 20, small: 500, large: 5_000 }[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 1, ops: 0 }),
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
            const h = repo.create<Note>({ title: noteTitle(i), body: "" });
            for (let e = 0; e < EDITS; e++) h.change((d) => splice(d, ["body"], d.body.length, 0, noteLine(i, e)));
            urls.push(h.url);
          });
        }
        await ctx.time("flush", 0, () => repo.flush(), 0);
        session = { repo, urls };
        ctx.carry.urls = urls;
      },
    },
    {
      name: "export",
      page: "same",
      timed: false,
      async run(ctx) {
        if (!session) throw new Error("no repo: persist did not run on this page");
        const { repo, urls } = session;
        let bytes = 0;
        for (const url of urls) bytes += (await repo.export((await repo.find(url as AutomergeUrl)).documentId))?.byteLength ?? 0;
        ctx.carry.liveLogicalBytes = bytes;
        await repo.shutdown();
        session = undefined;
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
        const docs: (Note | undefined)[] = [];
        for (const url of urls) docs.push(await ctx.time("load", 0, async () => (await repo.find<Note>(url as AutomergeUrl)).doc()));
        for (const [i, doc] of docs.entries()) {
          ctx.check(doc?.title === noteTitle(i), `note ${i}: title is ${doc?.title}`);
          ctx.check(doc?.body === noteBody(i), `note ${i}: body differs from what was written`);
        }
      },
    },
  ],
});
