import * as Y from "yjs";
import { defineWorkload } from "../../core/types.ts";
import { fetchTracePhase, hashText, trace } from "../trace.ts";

/**
 * crdt-benchmarks B4: the LaTeX editing trace, one Yjs transaction (and so
 * one stored update) per keystroke, through the persistence layer. Then a
 * cold load in a fresh tab.
 */
export default defineWorkload({
  family: "yjs",
  title: "editing trace, one update per keystroke through persistence, then cold load",
  params: () => ({ entries: 1, keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 1, ops: 0, seed: 1 }),
  phases: [
    fetchTracePhase<"yjs">(),
    {
      name: "persist",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const doc = new Y.Doc();
        const binding = await store.attach("trace", doc);
        doc.on("update", (u: Uint8Array) => ctx.bytes(u.byteLength));
        const text = doc.getText("text");
        const edits = trace().slice(0, ctx.carry.edits as number);
        for (const [pos, del, ...ins] of edits) {
          await ctx.time("edit", 0, async () => {
            doc.transact(() => {
              if (del > 0) text.delete(pos, del);
              if (ins.length > 0) text.insert(pos, ins.join(""));
            });
          });
        }
        await ctx.time("flush", 0, () => binding.flush());
        ctx.carry.text = hashText(text.toString());
        ctx.carry.liveLogicalBytes = Y.encodeStateAsUpdate(doc).byteLength;
        await binding.detach();
      },
    },
    { name: "settle", page: "same", timed: false, footprint: true, run: async (ctx) => (await ctx.store()).settle() },
    {
      name: "load",
      page: "fresh",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const doc = new Y.Doc();
        const binding = await ctx.time("load", 0, () => store.attach("trace", doc));
        ctx.check(hashText(doc.getText("text").toString()) === ctx.carry.text, "loaded text differs");
        await binding.detach();
      },
    },
  ],
});
