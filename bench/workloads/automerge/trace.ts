import { Repo, splice, type AutomergeUrl, type DocHandle, type StorageAdapterInterface } from "@automerge/react";
import { defineWorkload, type PhaseContext } from "../../core/types.ts";
import { yieldTask } from "../../page/main-thread.ts";
import { KEY_MS, fetchTracePhase, hashText, paceTo, trace, typedKeys, type Edit } from "../trace.ts";

type TextDoc = { text: string };
const PER_CHANGE = 100;

/** The repo `persist` opens and `type` keeps changing, on the same page. `count` takes the saved bytes of the running phase. */
let session: { readonly repo: Repo; readonly handle: DocHandle<TextDoc>; count: (bytes: number) => void } | undefined;

function change(handle: DocHandle<TextDoc>, edits: readonly Edit[]): void {
  handle.change((doc) => {
    for (const [pos, del, ...ins] of edits) splice(doc, ["text"], pos, del, ins.join(""));
  });
}

/** The cold open of the stored document, checked against the text `type` left. */
async function load(ctx: PhaseContext<"automerge">): Promise<void> {
  const store = await ctx.store();
  const text = await ctx.time("load", 0, async () => {
    const repo = new Repo({ storage: store.adapter, network: [] });
    const handle = await repo.find<TextDoc>(ctx.carry.url as AutomergeUrl);
    return handle.doc()?.text ?? "";
  });
  ctx.check(hashText(text) === ctx.carry.text, `loaded text ${hashText(text)}, want ${String(ctx.carry.text)}`);
}

/**
 * The LaTeX editing trace through automerge-repo. The head goes in 100
 * keystrokes per change, yielding a task between changes so the repo's save
 * debounce runs as it would while someone types. The last keystrokes are
 * typed one change each, at one per frame, with the main thread recorded.
 * Then two cold opens in a fresh tab: `reopen` before kv settles, with the
 * typed saves still in the log or the newest runs, and `load` after.
 */
export default defineWorkload({
  family: "automerge",
  title: "editing trace through automerge-repo, 100 keystrokes per change, the last keys typed at one per frame, then cold opens before and after settle",
  params: () => ({ entries: 1, keyBytes: 0, valueBytes: 0, compressibility: 0, batch: PER_CHANGE, ops: 0, seed: 1 }),
  phases: [
    fetchTracePhase<"automerge">(),
    {
      name: "persist",
      page: "same",
      timed: true,
      async run(ctx) {
        const store = await ctx.store();
        const sink = { count: (n: number) => ctx.bytes(n) };
        const repo = new Repo({ storage: countingAdapter(store.adapter, (n) => sink.count(n)), network: [] });
        const handle = repo.create<TextDoc>({ text: "" });
        session = Object.assign(sink, { repo, handle });
        const edits = ctx.carry.edits as number;
        const head = trace().slice(0, edits - typedKeys(ctx.size, edits));
        for (let i = 0; i < head.length; i += PER_CHANGE) {
          const group = head.slice(i, i + PER_CHANGE);
          await ctx.time(
            "change",
            0,
            async () => {
              change(handle, group);
              await yieldTask();
            },
            group.length,
          );
        }
        await ctx.time("flush", 0, () => repo.flush());
      },
    },
    {
      name: "type",
      page: "same",
      timed: true,
      mainThread: true,
      async run(ctx) {
        if (!session) throw new Error("no document: persist did not run on this page");
        const { repo, handle } = session;
        session.count = (n) => ctx.bytes(n);
        const edits = ctx.carry.edits as number;
        const keys = trace().slice(edits - typedKeys(ctx.size, edits), edits);
        const start = performance.now();
        for (const [i, edit] of keys.entries()) {
          await ctx.time("key", 0, async () => {
            change(handle, [edit]);
            await yieldTask();
          });
          await paceTo(start + (i + 1) * KEY_MS);
        }
        await ctx.time("flush", 0, () => repo.flush());
        ctx.carry.url = handle.url;
        ctx.carry.text = hashText(handle.doc()?.text ?? "");
        ctx.carry.liveLogicalBytes = (await repo.export(handle.documentId))?.byteLength ?? 0;
        await repo.shutdown();
        session = undefined;
      },
    },
    { name: "reopen", page: "fresh", timed: true, run: load },
    { name: "settle", page: "same", timed: false, footprint: true, run: async (ctx) => (await ctx.store()).settle() },
    { name: "load", page: "fresh", timed: true, run: load },
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
