import * as Y from "yjs";
import type { YjsBinding } from "../../core/families.ts";
import { defineWorkload } from "../../core/types.ts";
import { EDITS, noteBody, noteLine, noteTitle } from "../notes.ts";

/** Many small notes (a Y.Map title and a Y.Text body typed in 20 transactions), then a cold load of every note. */
export default defineWorkload({
  family: "yjs",
  title: "many small notes: write each through persistence, then cold load every note",
  owns: ["yjs-many-docs"],
  params: (size) => ({ entries: { tiny: 20, small: 500, large: 5_000 }[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 1, ops: 0 }),
  phases: [
    {
      name: "persist",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const docs: Y.Doc[] = [];
        for (let i = 0; i < ctx.params.entries; i++) {
          let doc!: Y.Doc;
          let binding!: YjsBinding;
          await ctx.time("note", 0, async () => {
            doc = new Y.Doc();
            binding = await store.attach(`note-${i}`, doc);
            doc.on("update", (u: Uint8Array) => ctx.bytes(u.byteLength));
            doc.getMap("meta").set("title", noteTitle(i));
            const body = doc.getText("body");
            for (let e = 0; e < EDITS; e++) body.insert(body.length, noteLine(i, e));
            await binding.flush();
          });
          await ctx.time("detach", 0, () => binding.detach(), 0);
          docs.push(doc);
        }
        ctx.carry.liveLogicalBytes = docs.reduce((live, doc) => live + Y.encodeStateAsUpdate(doc).byteLength, 0);
      },
    },
    { name: "settle", page: "same", timed: false, footprint: true, run: async (ctx) => (await ctx.store()).settle() },
    {
      name: "load",
      page: "fresh",
      timed: true,
      async run(ctx) {
        const docs = Array.from({ length: ctx.params.entries }, () => new Y.Doc());
        const store = await ctx.store();
        for (const [i, doc] of docs.entries()) {
          const binding = await ctx.time("load", 0, () => store.attach(`note-${i}`, doc));
          await ctx.time("detach", 0, () => binding.detach(), 0);
        }
        for (const [i, doc] of docs.entries()) {
          ctx.check(doc.getMap("meta").get("title") === noteTitle(i), `note ${i}: title is ${String(doc.getMap("meta").get("title"))}`);
          ctx.check(doc.getText("body").toString() === noteBody(i), `note ${i}: body differs from what was written`);
        }
      },
    },
  ],
});
