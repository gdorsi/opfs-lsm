/**
 * What an app pays for TanStack DB live queries on top of a store, on the
 * tracker dataset. The import is written through the collections. In a fresh
 * tab each screen's live query is timed to its first answer. Then the sync
 * batches land: the first half with no screen open, the second half with every
 * screen open, each batch timed until every open screen shows it. The
 * difference per batch is the live queries' upkeep.
 *
 *   import     same   timed     the history's import, comments left out ("import")
 *   settle     same   untimed   kv: flush and compact until stable; footprint
 *   prepare    fresh  untimed   the history and the oracle: bindings and every expected answer
 *   open       same   timed     the collections ("open"), then each screen to its first answer (op = screen)
 *   sync       same   timed     the first half of the sync batches, no screen open ("sync")
 *   screens    same   untimed   every screen opened again
 *   sync-live  same   timed     the second half with every screen open ("sync"), answers checked every 10 batches
 */
import { SCREENS, type LiveScreen, type LiveStore, type Screen } from "../../core/families.ts";
import type { Json, JsonRow } from "../../core/goals.ts";
import { defineWorkload, type Phase, type PhaseContext } from "../../core/types.ts";
import { trackerHistory } from "../../datasets/tracker/history.ts";
import { TRACKER } from "../../datasets/tracker/index.ts";
import { TrackerOracle } from "../../datasets/tracker/oracle.ts";
import type { Tx } from "../../datasets/tracker/types.ts";
import { yieldTask } from "../../page/main-thread.ts";
import { seedOf } from "../../page/model.ts";
import { differ, picker } from "../goals-lib.ts";

type Ctx = PhaseContext<"tanstack-live">;

const CHECK_EVERY = 10;

/** A batch as the screens' collections take it: no screen reads comments, so their events are left out. */
function screenTx(tx: Tx): Tx | undefined {
  const events = tx.events.filter((e) => e.entity !== "comments");
  return events.length === 0 ? undefined : { kind: tx.kind, events };
}

/** JSON bytes of every row the collections hold: the Space-Amp denominator. */
function liveBytes(o: TrackerOracle): number {
  let n = 0;
  for (const rows of [o.users, o.projects, o.labels, o.issues] as Map<string, object>[]) for (const row of rows.values()) n += JSON.stringify(row).length;
  return n;
}

type Expected = Readonly<Record<Screen, Json>>;

/** What `prepare` hands the later phases of its page: each screen's binding, the batches to write, and the answers to check. */
let run:
  | {
      readonly bindings: Readonly<Record<Screen, JsonRow>>;
      readonly first: Expected;
      readonly syncs: readonly Tx[];
      /** Expected answers after sync batch k (1-based), at every k the live half checks. */
      readonly after: ReadonlyMap<number, Expected>;
      screens: LiveScreen[];
    }
  | undefined;

function running() {
  if (!run) throw new Error("no history on this page: prepare did not run");
  return run;
}

function check(ctx: Ctx, what: string, got: Json, want: Json): void {
  const diff = differ(got, want);
  ctx.check(diff === undefined, `${what}: ${diff}`);
}

async function openAll(store: LiveStore, bindings: Readonly<Record<Screen, JsonRow>>, time?: Ctx["time"]): Promise<LiveScreen[]> {
  const screens: LiveScreen[] = [];
  for (const s of SCREENS) {
    const opening = () => store.open(s, bindings[s] as never);
    screens.push(time ? await time(s, 0, opening) : await opening());
    await yieldTask();
  }
  return screens;
}

function checkAll(ctx: Ctx, screens: readonly LiveScreen[], expected: Expected, when: string): void {
  SCREENS.forEach((s, k) => check(ctx, `${s} ${when}`, screens[k]!.answer() as Json, expected[s]));
}

/** Writes sync batches [from, to), each timed until every open screen shows it. */
async function replay(ctx: Ctx, from: number, to: number, checks: boolean): Promise<void> {
  const r = running();
  const store = await ctx.store();
  for (let k = from; k < to; k++) {
    const tx = screenTx(r.syncs[k]!);
    if (tx) await ctx.time("sync", JSON.stringify(tx.events).length, () => store.apply(tx), tx.events.length);
    const expected = checks ? r.after.get(k + 1) : undefined;
    if (expected) checkAll(ctx, r.screens, expected, `after sync batch ${k + 1}`);
    await yieldTask();
    if ((k + 1) % 200 === 0) ctx.progress(`sync: ${k + 1} of ${r.syncs.length} batches`);
  }
}

const half = () => Math.floor(running().syncs.length / 2);

const phases: Phase<"tanstack-live">[] = [
  {
    name: "import",
    page: "same",
    timed: true,
    async run(ctx) {
      const store = await ctx.store();
      const oracle = new TrackerOracle();
      for (const tx of trackerHistory(ctx.size, TRACKER.seed).load) {
        if (tx.kind !== "import") break;
        oracle.apply(tx);
        const t = screenTx(tx);
        if (t) await ctx.time("import", JSON.stringify(t.events).length, () => store.apply(t), t.events.length);
      }
      ctx.carry.liveLogicalBytes = liveBytes(oracle);
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
    name: "prepare",
    page: "fresh",
    timed: false,
    async run(ctx) {
      const oracle = new TrackerOracle();
      const syncs: Tx[] = [];
      for (const tx of trackerHistory(ctx.size, TRACKER.seed).load) {
        if (tx.kind === "import") oracle.apply(tx);
        else syncs.push(tx);
      }
      const bindings = Object.fromEntries(SCREENS.map((s) => [s, TRACKER.goals[s].curate(oracle, picker(seedOf(TRACKER.seed, s)))[0]!])) as unknown as Record<Screen, JsonRow>;
      const answers = (): Expected => Object.fromEntries(SCREENS.map((s) => [s, oracle.goals[s](bindings[s] as never) as Json])) as Expected;
      const first = answers();
      const after = new Map<number, Expected>();
      const mid = Math.floor(syncs.length / 2);
      syncs.forEach((tx, k) => {
        oracle.apply(tx);
        if (k + 1 > mid && ((k + 1 - mid) % CHECK_EVERY === 0 || k + 1 === syncs.length)) after.set(k + 1, answers());
      });
      run = { bindings, first, syncs, after, screens: [] };
    },
  },
  {
    name: "open",
    page: "same",
    timed: true,
    mainThread: true,
    async run(ctx) {
      const r = running();
      const store = await ctx.store();
      await yieldTask();
      const screens = await openAll(store, r.bindings, ctx.time);
      checkAll(ctx, screens, r.first, "first answer");
      for (const s of screens) await s.close();
    },
  },
  {
    name: "sync",
    page: "same",
    timed: true,
    mainThread: true,
    run: (ctx) => replay(ctx, 0, half(), false),
  },
  {
    name: "screens",
    page: "same",
    timed: false,
    async run(ctx) {
      const r = running();
      r.screens = await openAll(await ctx.store(), r.bindings);
    },
  },
  {
    name: "sync-live",
    page: "same",
    timed: true,
    mainThread: true,
    async run(ctx) {
      const r = running();
      await replay(ctx, half(), r.syncs.length, true);
      for (const s of r.screens) await s.close();
      r.screens = [];
    },
  },
];

export default defineWorkload({
  family: "tanstack-live",
  title: `TanStack DB live queries on the tracker: ${SCREENS.length} screens to their first answer in a fresh tab, then sync batches without and with the screens open`,
  owns: ["tanstack-live-open", "tanstack-live-upkeep"],
  params: (size) => ({ entries: TRACKER.entries[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 0, ops: 0, seed: TRACKER.seed }),
  phases,
});
