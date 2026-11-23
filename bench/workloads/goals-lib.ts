/**
 * One dataset -> one workload. The phases come from the dataset's goal list,
 * so adding a goal adds its phase:
 *
 *   replay   same   timed     the history's aging part through `apply`: ops per batch kind ("import", "sync"),
 *                             and after every few sync batches the dataset's `duringLoad` read ("read", not counted in ops)
 *   settle   same   untimed   kv: flush and compact until stable; footprint
 *   recent   same   timed     writes on top of the settled store ("bulk", "edit"), as a user makes them
 *   prepare  same   untimed   curate bindings, compute every expected answer, carry them; footprint
 *   <goal>   fresh  timed     COLD_ROUNDS rounds, each on its own fresh page. Round r: open, "cold" = binding r. Round 0 goes on:
 *                             "first" = the other bindings once; "warm" = every binding WARM_ROUNDS times
 *   <burst>  fresh  timed     the dataset's bursts on a goal's rounds: the calls of one burst fired in one task, timed to the last answer
 *   <burst>-serial            the same, each call awaited before the next starts
 *   reread   fresh  timed     one write, then the reads that must show it ("edit", "reread")
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
/** The dataset picks up to this many bindings. Each gets one cold call in a fresh tab of its own. */
const COLD_ROUNDS = 5;

type Store = GoalStore<GoalSpecMap, unknown> & { settle(): Promise<void> };
type Read = { readonly goal: string; readonly params: JsonRow; readonly expected: Json };
type Script = {
  readonly goals: Readonly<Record<string, { readonly bindings: readonly JsonRow[]; readonly expected: readonly Json[] }>>;
  /** Per burst, its calls and their expected answers, in call order. */
  readonly bursts: readonly (readonly Read[])[];
  readonly reread: { readonly tx: unknown; readonly reads: readonly Read[] };
};

/**
 * The history and oracle of the run on this page. Only `same` phases after `replay` see it. `recent` leaves its batches
 * in `unfolded` for `prepare` to fold, so the oracle stays out of that phase's main-thread measurement.
 */
let live: { readonly history: History<unknown>; readonly oracle: Oracle<GoalSpecMap, unknown>; unfolded: readonly unknown[] } | undefined;

export function goalWorkload<F extends Family, S extends GoalSpecMap, Tx, O extends Oracle<S, Tx>>(family: F, dataset: Dataset<S, Tx, O>): Workload<F> {
  const d = dataset as unknown as Dataset<GoalSpecMap, unknown, Oracle<GoalSpecMap, unknown>>;
  if (d.burst.name in d.goals) throw new Error(`burst ${d.burst.name} shares a goal's phase name`);
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
      live = { history: d.history(ctx.size, ctx.params.seed), oracle: d.oracle(), unfolded: [] };
      const { oracle } = live;
      const { during, every, read } = d.duringLoad;
      // Answers are compared after the last timed call, against a second copy of the seeded history: oracle work between
      // calls would give stores that work in the background idle time a store committing in the call does not get, and
      // holding the batches instead would keep the whole history in the page's heap. An answer is kept as canonical JSON,
      // so a store that hands out objects it later changes is checked on what it returned at that batch.
      const answers = new Map<number, string>();
      let n = 0;
      let matched = 0;
      for (const tx of live.history.load) {
        const op = d.txOp(tx);
        await ctx.time(op, d.txBytes(tx), () => store.apply(tx), d.txCount(tx));
        n++;
        if (op === during && ++matched % every === 0) answers.set(n, canonical(await ctx.time("read", 0, () => store.goals[read.goal]!(read.params), 0), `${read.goal} after batch ${n}`));
        if (n % 500 === 0) ctx.progress(`replay: ${n} batches`);
      }
      n = 0;
      for (const tx of d.history(ctx.size, ctx.params.seed).load) {
        oracle.apply(tx);
        const got = answers.get(++n);
        if (got !== undefined) check(ctx, `${read.goal} after batch ${n}`, JSON.parse(got) as Json, oracle.goals[read.goal]!(read.params));
      }
      ctx.carry.liveLogicalBytes = oracle.liveBytes();
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
      const run = running();
      const batches = [...run.history.recent()];
      for (const tx of batches) {
        await ctx.time(d.txOp(tx), d.txBytes(tx), () => store.apply(tx), d.txCount(tx));
        await yieldTask();
      }
      run.unfolded = batches;
    },
  };

  const prepare: Phase<F> = {
    name: "prepare",
    page: "same",
    timed: false,
    footprint: true,
    async run(ctx) {
      const run = running();
      const { oracle } = run;
      for (const tx of run.unfolded) oracle.apply(tx);
      run.unfolded = [];
      ctx.carry.liveLogicalBytes = oracle.liveBytes();
      const goals: Record<string, { bindings: readonly JsonRow[]; expected: Json[] }> = {};
      for (const [goal, meta] of Object.entries(d.goals)) {
        const bindings = meta.curate(oracle, picker(seedOf(ctx.params.seed, goal)));
        ctx.check(bindings.length >= 1 && bindings.length <= COLD_ROUNDS, `${goal}: ${bindings.length} bindings`);
        goals[goal] = { bindings, expected: bindings.map((b) => oracle.goals[goal]!(b)) };
      }
      const curated = d.burst.curate(oracle, picker(seedOf(ctx.params.seed, d.burst.name)));
      ctx.check(curated.length >= 1 && curated.length <= COLD_ROUNDS, `${d.burst.name}: ${curated.length} bursts`);
      const bursts = curated.map((calls) => calls.map((c) => ({ ...c, expected: oracle.goals[c.goal]!(c.params) })));
      const { tx, reads } = d.reread(oracle);
      oracle.apply(tx);
      ctx.carry.script = {
        goals,
        bursts,
        reread: { tx, reads: reads.map((r) => ({ ...r, expected: oracle.goals[r.goal]!(r.params) })) },
      } satisfies Script;
    },
  };

  /** Rounds of a phase: `units` is how many bindings (or bursts) there are, `fire` times and checks unit `b` under op `op`. */
  const roundsPhase = (name: string, units: (script: Script) => number, fire: (ctx: PhaseContext<F>, store: Store, op: string, b: number) => Promise<void>): Phase<F> => ({
    name,
    page: "fresh",
    rounds: COLD_ROUNDS,
    timed: true,
    mainThread: true,
    async run(ctx) {
      const n = units(scriptOf(ctx));
      if (ctx.round >= n) return;
      const store = await storeOf(ctx);
      const call = async (op: string, b: number) => {
        await fire(ctx, store, op, b);
        await yieldTask();
      };
      await yieldTask();
      await call("cold", ctx.round);
      if (ctx.round > 0) return;
      for (let b = 1; b < n; b++) await call("first", b);
      for (let round = 0; round < WARM_ROUNDS; round++) for (let b = 0; b < n; b++) await call("warm", b);
    },
  });

  const goal = (name: string) =>
    roundsPhase(
      name,
      (script) => script.goals[name]!.bindings.length,
      async (ctx, store, op, b) => {
        const { bindings, expected } = scriptOf(ctx).goals[name]!;
        const got = await ctx.time(op, 0, () => store.goals[name]!(bindings[b]!));
        check(ctx, `${name} ${JSON.stringify(bindings[b])}`, got, expected[b]!);
      },
    );

  const burst = (mode: "together" | "serial") =>
    roundsPhase(
      mode === "together" ? d.burst.name : `${d.burst.name}-serial`,
      (script) => script.bursts.length,
      async (ctx, store, op, b) => {
        const calls = scriptOf(ctx).bursts[b]!;
        const ask = (c: Read) => store.goals[c.goal]!(c.params);
        // One sample per burst: a screen waits for its last answer. Each call counts as an op.
        const got = await ctx.time(
          op,
          0,
          mode === "together"
            ? () => Promise.all(calls.map(ask))
            : async () => {
                const answers: Json[] = [];
                for (const c of calls) answers.push(await ask(c));
                return answers;
              },
          calls.length,
        );
        calls.forEach((c, k) => check(ctx, `${d.burst.name} ${c.goal} ${JSON.stringify(c.params)}`, got[k]!, c.expected));
      },
    );

  const reread: Phase<F> = {
    name: "reread",
    page: "fresh",
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
    owns: [...d.owns, ...Object.values(d.goals).map((g) => g.owns), d.burst.owns],
    params: (size) => ({ entries: d.entries[size], keyBytes: 0, valueBytes: 0, compressibility: 0, batch: 0, ops: 0 }),
    phases: [replay, settle, recent, prepare, ...Object.keys(d.goals).map(goal), burst("together"), burst("serial"), reread],
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
function canonical(v: Json | undefined, at = "answer"): string {
  if (v === undefined) throw new Error(`${at} is undefined, which JSON would turn into null`);
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`${at} is ${v}, which JSON would turn into null`);
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x, i) => canonical(x, `${at}[${i}]`)).join(",")}]`;
  const o = v as { readonly [k: string]: Json };
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k], `${at}.${k}`)}`)
    .join(",")}}`;
}

/** Undefined when equal; otherwise both sides around the first difference. */
export function differ(got: Json, want: Json): string | undefined {
  const a = canonical(got, "got");
  const b = canonical(want, "want");
  if (a === b) return undefined;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const at = Math.max(0, i - 80);
  return `got …${a.slice(at, i + 120)}… want …${b.slice(at, i + 120)}…`;
}
