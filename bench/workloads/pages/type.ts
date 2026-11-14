import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import type { PagesStore } from "../../core/families.ts";
import { defineWorkload, type Phase } from "../../core/types.ts";
import { yieldTask } from "../../page/main-thread.ts";
import { KEY_MS, PEER_WAIT_MS, SAVE_THROTTLE_MS, recorder, typingScript, type Recorder } from "../../page/pages.ts";
import { fetchTracePhase, hashText, trace } from "../trace.ts";
import { newPageId, openBodies, type Bodies } from "../../../examples/pages-fate-automerge/src/model/bodies.ts";
import type { PageBody, PageId, Span } from "../../../examples/pages-fate-automerge/src/model/types.ts";
import { builtBody } from "../../../examples/pages-fate-automerge/src/testing/built-body.ts";
import { referenceBody } from "../../../examples/pages-fate-automerge/src/testing/reference.ts";

/** The page, its Repo and what counts its storage calls: alive across the "same" phases of one tab. */
type Session = { readonly bodies: Bodies; readonly body: PageBody; readonly rec: Recorder };
let session: Session | undefined;
let reopened: readonly Span[] = [];

const BODY_BYTES = { tiny: 1_000, small: 50_000, large: 1_000_000 } as const;
const KEYS = { tiny: 200, small: 1_000, large: 1_000 } as const;

const live = (): Session => {
  if (!session) throw new Error("no open page: the earlier phase did not run in this tab");
  return session;
};

/** The model over the contender's storage, built the way the app builds it. Opening a page is the caller's to time. */
function model(store: PagesStore): { bodies: Bodies; rec: Recorder } {
  const rec = recorder(store.storage);
  const bodies = openBodies({
    storage: rec.storage.bodies,
    network: [new BroadcastChannelNetworkAdapter({ channelName: "pages:bench", peerWaitMs: PEER_WAIT_MS })],
    saveDebounceMs: SAVE_THROTTLE_MS,
    onDocMetrics: rec.onDocMetrics,
  });
  return { bodies, rec };
}

/** Key order and equal marks must not matter, so compare a canonical text. */
function canonical(spans: readonly Span[]): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)]))
        : v;
  return JSON.stringify(sorted(spans));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function phase(name: string, extra: Partial<Phase<"pages">>, run: Phase<"pages">["run"]): Phase<"pages"> {
  return { name, page: "same", timed: true, ...extra, run };
}

/**
 * A page of a Notion-style app: paste a document into an empty page, type into
 * it, reload and come back. The headless model is the same for every contender;
 * only the storage under it differs. Typing runs 20 times faster than a person
 * (6 ms keys against a 5 ms save throttle), which keeps the storage calls per
 * key what a real session makes. Checks run outside the timed calls: the body
 * is compared with a plain-data oracle live, and again after the reload.
 */
export default defineWorkload({
  family: "pages",
  title: "paste a document into a page, type into it, reload and reopen it",
  params: (size) => ({ entries: KEYS[size], keyBytes: 0, valueBytes: BODY_BYTES[size], compressibility: 0, batch: 1, ops: KEYS[size], seed: 1 }),
  phases: [
    fetchTracePhase<"pages">(),
    phase("paste", { mainThread: true }, async (ctx) => {
      const id = newPageId();
      const { bodies, rec } = model(await ctx.store());
      const body = await ctx.time("open-page", 0, () => bodies.open(id));
      session = { bodies, body, rec };
      const doc = builtBody(BODY_BYTES[ctx.size]);
      await ctx.time("paste", 0, async () => body.edit(doc.edits));
      await ctx.time("flush", 0, () => body.flush());
      rec.report(ctx);
      ctx.carry.id = id;
      ctx.carry.end = doc.end;
    }),
    phase("check-paste", { timed: false }, async (ctx) => {
      const want = canonical(builtBody(BODY_BYTES[ctx.size]).spans);
      ctx.check(canonical(live().body.spans()) === want, "the pasted body differs from the document that was pasted");
    }),
    phase("type", { mainThread: true }, async (ctx) => {
      const { body, rec } = live();
      const keys = typingScript(trace(), ctx.params.entries, ctx.carry.end as number);
      const start = performance.now();
      for (const [i, edits] of keys.entries()) {
        await ctx.time(
          "key",
          0,
          async () => {
            body.edit(edits);
            await yieldTask();
          },
          0,
        );
        const wait = start + (i + 1) * KEY_MS - performance.now();
        if (wait > 0) await sleep(wait);
      }
      await ctx.time("flush", 0, () => body.flush());
      const calls = rec.report(ctx);
      ctx.count("keys", keys.length);
      ctx.count("storage ops per key", calls / keys.length);
    }),
    phase(
      "settle",
      { timed: false, footprint: true },
      async (ctx) => {
        const { bodies, body } = live();
        const doc = builtBody(BODY_BYTES[ctx.size]);
        const oracle = referenceBody(doc.spans);
        for (const edits of typingScript(trace(), ctx.params.entries, doc.end)) oracle.edit(edits);
        const got = canonical(body.spans());
        ctx.check(got === canonical(oracle.spans()), `the typed body (${hashText(got)}) differs from the oracle (${hashText(canonical(oracle.spans()))})`);
        ctx.carry.spans = hashText(got);
        ctx.carry.liveLogicalBytes = oracle.length();
        await bodies.close();
        await (await ctx.store()).settle();
        session = undefined;
      },
    ),
    {
      name: "reopen",
      page: "fresh",
      timed: true,
      mainThread: true,
      async run(ctx) {
        const store = await ctx.store();
        if (store.volatile) return;
        const { bodies, rec } = model(store);
        const body = await ctx.time("reopen", 0, async () => {
          const opened = await bodies.open(ctx.carry.id as PageId);
          reopened = opened.spans();
          return opened;
        });
        session = { bodies, body, rec };
        rec.report(ctx);
      },
    },
    phase("check", { timed: false }, async (ctx) => {
      if (!session) return;
      const { bodies } = session;
      const got = canonical(reopened);
      ctx.check(hashText(got) === ctx.carry.spans, `the reopened body is ${hashText(got)}, want ${String(ctx.carry.spans)}`);
      await bodies.close();
      session = undefined;
    }),
  ],
});
