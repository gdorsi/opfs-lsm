import * as Y from "yjs";
import type { YjsBinding } from "../../core/families.ts";
import { defineWorkload, type PhaseContext } from "../../core/types.ts";
import { yieldTask } from "../../page/main-thread.ts";
import { KEY_MS, fetchTracePhase, hashText, paceTo, trace, typedKeys, type Edit } from "../trace.ts";

/** The document `persist` opens and `type` keeps writing, on the same page. `count` takes the stored update bytes of the running phase. */
let session: { readonly doc: Y.Doc; readonly binding: YjsBinding; count: (bytes: number) => void } | undefined;

function apply(doc: Y.Doc, [pos, del, ...ins]: Edit): void {
  const text = doc.getText("text");
  doc.transact(() => {
    if (del > 0) text.delete(pos, del);
    if (ins.length > 0) text.insert(pos, ins.join(""));
  });
}

/** The cold open of the stored document, checked against the text `type` left. */
async function load(ctx: PhaseContext<"yjs">): Promise<void> {
  const store = await ctx.store();
  const doc = new Y.Doc();
  const binding = await ctx.time("load", 0, () => store.attach("trace", doc));
  ctx.check(hashText(doc.getText("text").toString()) === ctx.carry.text, "loaded text differs");
  await binding.detach();
}

/**
 * crdt-benchmarks B4: the LaTeX editing trace, one Yjs transaction (and so
 * one stored update) per keystroke, through the persistence layer. The head
 * is written as fast as it goes; the last keystrokes are typed at one per
 * frame with the main thread recorded. Then two cold opens in a fresh tab:
 * `reopen` before kv settles, with the typed updates still in the log or
 * the newest runs, and `load` after.
 */
export default defineWorkload({
  family: "yjs",
  title: "editing trace, one update per keystroke through persistence, the last keys typed at one per frame, then cold opens before and after settle",
  owns: ["yjs-trace"],
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
        const live = (session = { doc, binding, count: (n) => ctx.bytes(n) });
        doc.on("update", (u: Uint8Array) => live.count(u.byteLength));
        const edits = ctx.carry.edits as number;
        for (const edit of trace().slice(0, edits - typedKeys(ctx.size, edits))) await ctx.time("edit", 0, async () => apply(doc, edit));
        await ctx.time("flush", 0, () => binding.flush());
      },
    },
    // The writer stops for longer than either library's idle delay (1 s) before it merges stored updates, as a real history has.
    { name: "pause", page: "same", timed: false, run: () => new Promise<void>((resolve) => setTimeout(resolve, 2000)) },
    {
      name: "type",
      page: "same",
      timed: true,
      mainThread: true,
      async run(ctx) {
        if (!session) throw new Error("no document: persist did not run on this page");
        const { doc, binding } = session;
        session.count = (n) => ctx.bytes(n);
        const edits = ctx.carry.edits as number;
        const keys = trace().slice(edits - typedKeys(ctx.size, edits), edits);
        const start = performance.now();
        for (const [i, edit] of keys.entries()) {
          await ctx.time("key", 0, async () => {
            apply(doc, edit);
            await yieldTask();
          });
          await paceTo(start + (i + 1) * KEY_MS);
        }
        await ctx.time("flush", 0, () => binding.flush());
        ctx.carry.text = hashText(doc.getText("text").toString());
        ctx.carry.liveLogicalBytes = Y.encodeStateAsUpdate(doc).byteLength;
        await binding.detach();
        session = undefined;
      },
    },
    { name: "reopen", page: "fresh", timed: true, run: load },
    { name: "settle", page: "same", timed: false, footprint: true, run: async (ctx) => (await ctx.store()).settle() },
    { name: "load", page: "fresh", timed: true, run: load },
  ],
});
