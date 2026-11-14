import { Repo, splice, type AutomergeUrl, type StorageAdapterInterface } from "@automerge/react";
import { defineWorkload } from "../../core/types.ts";
import { yieldTask } from "../../page/main-thread.ts";
import { fetchTracePhase, hashText, trace } from "../trace.ts";

type TextDoc = { text: string };
const PER_CHANGE = 100;

/**
 * The LaTeX editing trace through automerge-repo: 100 keystrokes per change,
 * yielding a task between changes so the repo's save debounce runs as it
 * would while someone types. Then a cold load in a fresh tab.
 */
export default defineWorkload({
  family: "automerge",
  title: "editing trace through automerge-repo, 100 keystrokes per change, then cold load",
  params: () => ({ entries: 1, keyBytes: 0, valueBytes: 0, compressibility: 0, batch: PER_CHANGE, ops: 0, seed: 1 }),
  phases: [
    fetchTracePhase<"automerge">(),
    {
      name: "persist",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const repo = new Repo({ storage: countingAdapter(store.adapter, (n) => ctx.bytes(n)), network: [] });
        const edits = trace().slice(0, ctx.carry.edits as number);
        const handle = repo.create<TextDoc>({ text: "" });
        for (let i = 0; i < edits.length; i += PER_CHANGE) {
          const group = edits.slice(i, i + PER_CHANGE);
          await ctx.time(
            "change",
            0,
            async () => {
              handle.change((doc) => {
                for (const [pos, del, ...ins] of group) splice(doc, ["text"], pos, del, ins.join(""));
              });
              await yieldTask();
            },
            group.length,
          );
        }
        await ctx.time("flush", 0, () => repo.flush());
        const bytes = (await repo.export(handle.documentId))?.byteLength ?? 0;
        ctx.carry.url = handle.url;
        ctx.carry.text = hashText(handle.doc()?.text ?? "");
        ctx.carry.liveLogicalBytes = bytes;
        await repo.shutdown();
      },
    },
    {
      name: "settle",
      page: "same",
      timed: false,
      footprint: true,
      run: async (ctx) => (await ctx.store()).settle(),
    },
    {
      name: "load",
      page: "fresh",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const text = await ctx.time("load", 0, async () => {
          const repo = new Repo({ storage: store.adapter, network: [] });
          const handle = await repo.find<TextDoc>(ctx.carry.url as AutomergeUrl);
          const doc = handle.doc();
          return doc?.text ?? "";
        });
        ctx.check(hashText(text) === ctx.carry.text, `loaded text ${hashText(text)}, want ${String(ctx.carry.text)}`);
      },
    },
  ],
});

/** Counts the bytes automerge-repo asks storage to save: the W-Amp denominator. */
export function countingAdapter(inner: StorageAdapterInterface, count: (bytes: number) => void): StorageAdapterInterface {
  return {
    load: (k) => inner.load(k),
    save: (k, data) => {
      count(data.byteLength);
      return inner.save(k, data);
    },
    remove: (k) => inner.remove(k),
    loadRange: (p) => inner.loadRange(p),
    removeRange: (p) => inner.removeRange(p),
  };
}
