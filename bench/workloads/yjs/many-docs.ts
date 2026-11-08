import * as Y from "yjs";
import { defineWorkload } from "../../core/types.ts";

const EDITS = 20;

/** Many small notes (a Y.Map title and a Y.Text body typed in 20 transactions), then a cold load of every note. */
export default defineWorkload({
  family: "yjs",
  title: "many small notes: write each through persistence, then cold load every note",
  params: (size) => ({ entries: { tiny: 20, small: 500, large: 5_000 }[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 1, ops: 0, seed: 1 }),
  phases: [
    {
      name: "persist",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        let live = 0;
        for (let i = 0; i < ctx.params.entries; i++) {
          await ctx.time("note", 0, async () => {
            const doc = new Y.Doc();
            const binding = await store.attach(`note-${i}`, doc);
            doc.on("update", (u: Uint8Array) => ctx.bytes(u.byteLength));
            doc.getMap("meta").set("title", `note ${i}`);
            const body = doc.getText("body");
            for (let e = 0; e < EDITS; e++) body.insert(body.length, `line ${e} of note ${i}\n`);
            await binding.flush();
            live += Y.encodeStateAsUpdate(doc).byteLength;
            await binding.detach();
          });
        }
        ctx.carry.liveLogicalBytes = live;
      },
    },
    { name: "settle", page: "same", timed: false, footprint: true, run: async (ctx) => (await ctx.store()).settle() },
    {
      name: "load",
      page: "fresh",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        for (let i = 0; i < ctx.params.entries; i++) {
          const doc = new Y.Doc();
          const binding = await ctx.time("load", 0, () => store.attach(`note-${i}`, doc));
          ctx.check(doc.getMap("meta").get("title") === `note ${i}` && doc.getText("body").toString().split("\n").length === EDITS + 1, `note ${i} did not load intact`);
          await binding.detach();
        }
      },
    },
  ],
});
