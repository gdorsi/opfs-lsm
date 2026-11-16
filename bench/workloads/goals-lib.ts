/**
 * One dataset -> one workload. The phases come from the dataset's goal list,
 * so adding a goal adds its phase:
 *
 *   replay   same   timed     the history's aging part through `apply`: ops per batch kind ("import", "sync"),
 *                             and every few batches the dataset's `duringLoad` read ("read")
 *   settle   same   untimed   kv: flush and compact until stable; footprint
 *   recent   same   timed     writes on top of the settled store ("bulk", "edit"), as a user makes them
 *   prepare  same   untimed   curate bindings, compute every expected answer, carry them; footprint
 *   <goal>   fresh  timed     open; "cold" = binding 0; "first" = the other bindings once; "warm" = every binding WARM_ROUNDS times
 *   reread   same   timed     one write, then the reads that must show it ("edit", "reread")
 *
 * The oracle folds the same history in the page that replays it and never
 * leaves that page: goal phases get the expected answers through `carry`.
 */
import type { Dataset, GoalSpecMap, GoalStore, History, Json, JsonRow, Oracle, Picker } from "../core/goals.ts";
import { defineWorkload, type Family, type Phase, type PhaseContext, type Workload } from "../core/types.ts";
import { yieldTask } from "../page/main-thread.ts";
import { rng, seedOf } from "../page/model.ts";

/** Repeat calls per binding after its first. */
const WARM_ROUNDS = 3;

type Store = GoalStore<GoalSpecMap, unknown> & { settle(): Promise<void> };
type Read = { readonly goal: string; readonly params: JsonRow; readonly expected: Json };
type Script = {
  readonly goals: Readonly<Record<string, { readonly bindings: readonly JsonRow[]; readonly expected: readonly Json[] }>>;
  readonly reread: { readonly tx: unknown; readonly reads: readonly Read[] };
};

/** The history and oracle of the run on this page. Only `same` phases after `replay` see it. */
let live: { readonly history: History<unknown>; readonly oracle: Oracle<GoalSpecMap, unknown> } | undefined;

export function goalWorkload<F extends Family, S extends GoalSpecMap, Tx, O extends Oracle<S, Tx>>(family: F, dataset: Dataset<S, Tx, O>): Workload<F> {
  const d = dataset as unknown as Dataset<GoalSpecMap, unknown, Oracle<GoalSpecMap, unknown>>;
  const storeOf = async (ctx: PhaseContext<F>) => (await ctx.store()) as unknown as Store;
  const running = () => {
    if (!live) throw new Error("no history on this page: replay did not run");
    return live;
  };
  const scriptOf = (ctx: PhaseContext<F>) => {
    const script = ctx.carry.script as Script | undefined;
    if (!script) throw new Error("no script: prepare did not run");
    return script;
  };
  const check = (ctx: PhaseContext<F>, what: string, got: Json, want: Json) => {
    const diff = differ(got, want);
    ctx.check(diff === undefined, `${what}: ${diff}`);
  };

  const replay: Phase<F> = {
    name: "replay",
    page: "same",
    timed: true,
    async run(ctx) {
      const store = await storeOf(ctx);
      live = { history: d.history(ctx.size, d.seed), oracle: d.oracle() };
      const { every, read } = d.duringLoad;
      let n = 0;
      for (const tx of live.history.load) {
        live.oracle.apply(tx);
        await ctx.time(d.txOp(tx), d.txBytes(tx), () => store.apply(tx), d.txCount(tx));
        if (++n % every === 0) {
          const got = await ctx.time("read", 0, () => store.goals[read.goal]!(read.params));
          check(ctx, `${read.goal} after batch ${n}`, got, live.oracle.goals[read.goal]!(read.params));
        }
        if (n % 500 === 0) ctx.progress(`replay: ${n} batches`);
      }
      ctx.carry.liveLogicalBytes = live.oracle.liveBytes();
    },
  };

  const settle: Phase<F> = {
    name: "settle",
    page: "same",
    timed: false,
    footprint: true,
    run: async (ctx) => (await storeOf(ctx)).settle(),
  };

  const recent: Phase<F> = {
    name: "recent",
    page: "same",
    timed: true,
    mainThread: true,
    async run(ctx) {
      const store = await storeOf(ctx);
      const { history, oracle } = running();
      for (const tx of history.recent()) {
        oracle.apply(tx);
        await ctx.time(d.txOp(tx), d.txBytes(tx), () => store.apply(tx), d.txCount(tx));
        await yieldTask();
      }
    },
  };

  const prepare: Phase<F> = {
    name: "prepare",
    page: "same",
    timed: false,
    footprint: true,
    async run(ctx) {
      const { oracle } = running();
      ctx.carry.liveLogicalBytes = oracle.liveBytes();
      const goals: Record<string, { bindings: readonly JsonRow[]; expected: Json[] }> = {};
      for (const [goal, meta] of Object.entries(d.goals)) {
        const bindings = meta.curate(oracle, picker(seedOf(d.seed, goal)));
        ctx.check(bindings.length >= 1 && bindings.length <= 5, `${goal}: ${bindings.length} bindings`);
        goals[goal] = { bindings, expected: bindings.map((b) => oracle.goals[goal]!(b)) };
      }
      const { tx, reads } = d.reread(oracle);
      oracle.apply(tx);
      ctx.carry.script = {
        goals,
        reread: { tx, reads: reads.map((r) => ({ ...r, expected: oracle.goals[r.goal]!(r.params) })) },
      } satisfies Script;
    },
  };

  const goal = (name: string): Phase<F> => ({
    name,
    page: "fresh",
    timed: true,
    mainThread: true,
    async run(ctx) {
      const { bindings, expected } = scriptOf(ctx).goals[name]!;
      const store = await storeOf(ctx);
      const call = async (op: string, b: number) => {
        const got = await ctx.time(op, 0, () => store.goals[name]!(bindings[b]!));
        check(ctx, `${name} ${JSON.stringify(bindings[b])}`, got, expected[b]!);
        await yieldTask();
      };
      await yieldTask();
      await call("cold", 0);
      for (let b = 1; b < bindings.length; b++) await call("first", b);
      for (let round = 0; round < WARM_ROUNDS; round++) for (let b = 0; b < bindings.length; b++) await call("warm", b);
    },
  });

  const reread: Phase<F> = {
    name: "reread",
    page: "same",
    timed: true,
    mainThread: true,
    async run(ctx) {
      const { tx, reads } = scriptOf(ctx).reread;
      const store = await storeOf(ctx);
      // Every read once before the write, so each is as warm as the others whichever goal ran last on this page.
      for (const r of reads) await store.goals[r.goal]!(r.params);
      await ctx.time(d.txOp(tx), d.txBytes(tx), () => store.apply(tx), d.txCount(tx));
      for (const r of reads) {
        const got = await ctx.time("reread", 0, () => store.goals[r.goal]!(r.params));
        check(ctx, `${r.goal} ${JSON.stringify(r.params)} after the edit`, got, r.expected);
        await yieldTask();
      }
    },
  };

  return defineWorkload({
    family,
    title: d.title,
    params: (size) => ({ entries: d.entries[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 0, ops: 0, seed: d.seed }),
    phases: [replay, settle, recent, prepare, ...Object.keys(d.goals).map(goal), reread],
  });
}

export function picker(seed: number): Picker {
  const next = rng(seed);
  return {
    rng: next,
    near(items, { cost, key, n, q }) {
      const all = [...items].map((t) => ({ t, c: cost(t), k: key(t) }));
      if (all.length === 0) return [];
      const costs = all.map((x) => x.c).sort((a, b) => a - b);
      const target = costs[Math.min(costs.length - 1, Math.floor(q * costs.length))]!;
      all.sort((a, b) => Math.abs(a.c - target) - Math.abs(b.c - target) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
      return all.slice(0, n).map((x) => x.t);
    },
  };
}

/** JSON with object keys sorted, so two answers compare whatever order their fields were built in. */
function canonical(v: Json | undefined): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as { readonly [k: string]: Json };
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/** Undefined when equal; otherwise both sides around the first difference. */
export function differ(got: Json, want: Json): string | undefined {
  const a = canonical(got);
  const b = canonical(want);
  if (a === b) return undefined;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const at = Math.max(0, i - 80);
  return `got …${a.slice(at, i + 120)}… want …${b.slice(at, i + 120)}…`;
}
