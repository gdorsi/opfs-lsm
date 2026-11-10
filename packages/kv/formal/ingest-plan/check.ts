/**
 * Exhaustive check of the per-tab ingest queues: the real planIngest,
 * planReclaim and checkCover, driven by every interleaving of two tabs
 * writing, rotations in their two steps, one failed write, a tab dying at
 * any step, the SharedWorker's stale scans and listings, and a browser
 * crash (cut tails, a damaged frame or a dropped segment file, the newest
 * one or two manifests dropped), up to the bounds below.
 *
 * Run: pnpm --filter @opfs-lsm/kv formal:ingest-plan
 *
 * In every state, of the manifest recovery would pick: no write and no
 * (log, n) ingested twice; each log in n order and after its pred; no acked
 * record skipped below a cursor or in a final log, except at or past the
 * first record a fault or the crash took from that log; a healthy database
 * opens; a crash with at most one dropped manifest and no fault recovers.
 * Every plan numbers its seqs on from its base's through. Once every writer
 * is gone (and after every crash), a drain from fresh scans leaves every log
 * final or damaged and every acked, unlost record ingested, so recovery
 * never opens with a silent hole, and keeps every write a tab saw ingested
 * (except design L6). Broken rules must each fail.
 *
 * The decided one-generation reclaim lag must survive one dropped manifest
 * and is shown to open with a silent hole after two, which is why
 * RECLAIM_LAG is 2. A tab's write ingested before a write it had seen
 * ingested, after a dropped manifest, is printed as a finding, not gated.
 *
 * The real rules take about 27 s at the defaults, and the whole check about
 * 55 s. FORMAL_IQ_APPENDS=3 explores about 10.7M states in about 12 minutes.
 */
import { RECLAIM_LAG } from "../../src/host/queues.js";
import { actions, allDead, causalReorder, crashes, diskKey, drain, drainProblem, initial, PlanError, problem, type Bounds, type State, type Variant } from "./model.js";

const BOUNDS: Bounds = {
  appends: Number(process.env.FORMAL_IQ_APPENDS ?? 2),
  commits: Number(process.env.FORMAL_IQ_COMMITS ?? 3),
  segCap: Number(process.env.FORMAL_IQ_SEGCAP ?? 1),
  drops: 2,
};

/** 64-bit fingerprints of visited states, open addressing; equal fingerprints are taken as equal states. */
class Visited {
  private hi = new Uint32Array(1 << 16);
  private lo = new Uint32Array(1 << 16);
  private full = new Uint8Array(1 << 16);
  size = 0;

  add(key: string): boolean {
    let a = 0x811c9dc5;
    let b = 5381;
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = (Math.imul(b, 33) ^ c) | 0;
    }
    if (!this.put(a >>> 0, b >>> 0)) return false;
    if (++this.size * 2 > this.full.length) this.grow();
    return true;
  }

  private put(a: number, b: number): boolean {
    const mask = this.full.length - 1;
    for (let i = a & mask; ; i = (i + 1) & mask) {
      if (!this.full[i]) {
        this.full[i] = 1;
        this.hi[i] = a;
        this.lo[i] = b;
        return true;
      }
      if (this.hi[i] === a && this.lo[i] === b) return false;
    }
  }

  private grow(): void {
    const { hi, lo, full } = this;
    this.hi = new Uint32Array(full.length * 2);
    this.lo = new Uint32Array(full.length * 2);
    this.full = new Uint8Array(full.length * 2);
    for (let i = 0; i < full.length; i++) if (full[i]) this.put(hi[i]!, lo[i]!);
  }
}

type Found = { readonly path: readonly string[]; readonly message: string };
type Result = {
  readonly states: number;
  readonly crashStates: number;
  readonly transitions: number;
  readonly depth: number;
  readonly ms: number;
  readonly violation?: Found;
  readonly reorder?: Found;
  /** Crash states by manifests dropped (0, 1, 2) that opened or refused. */
  readonly opened: number[];
  readonly refused: number[];
};

function explore(v: Variant, b: Bounds): Result {
  const started = performance.now();
  const visited = new Visited();
  const prev: number[] = [-1];
  const step: number[] = [-1];
  const labels: string[] = [];
  const labelId = new Map<string, number>();
  const opened = [0, 0, 0];
  const refused = [0, 0, 0];
  let crashStates = 0;
  let transitions = 0;
  let depth = 0;
  let reorder: Found | undefined;

  const path = (i: number, last?: string): string[] => {
    const out: string[] = last ? [last] : [];
    for (let j = i; j > 0; j = prev[j]!) out.push(labels[step[j]!]!);
    return out.reverse();
  };
  const done = (violation?: Found): Result => ({
    states: prev.length + crashStates,
    crashStates,
    transitions,
    depth,
    ms: Math.round(performance.now() - started),
    ...(violation ? { violation } : {}),
    ...(reorder ? { reorder } : {}),
    opened,
    refused,
  });
  /** Checks a state; with every writer gone, also drains it. Undefined when it holds. */
  const check = (s: State, at: () => string[]): string | undefined => {
    const p = problem(s);
    if (p || !allDead(s)) return p;
    const m = drain(s, v);
    if (!reorder) {
      const r = causalReorder(s, m);
      if (r) reorder = { path: at(), message: r };
    }
    return drainProblem(s, m);
  };

  // States with equal disks check, crash and drain alike, so each disk is
  // checked and crashed once, from the first (shortest) history reaching it.
  const disks = new Visited();
  const start = JSON.stringify(initial());
  visited.add(start);
  let frontier: [string, number][] = [[start, 0]];
  while (frontier.length > 0) {
    const next: [string, number][] = [];
    for (const [key, i] of frontier) {
      const s = JSON.parse(key) as State;
      try {
        if (disks.add(diskKey(s))) {
          const p = check(s, () => path(i));
          if (p) return done({ path: path(i), message: p });
          for (const a of crashes(s, b)) {
            const c = JSON.parse(key) as State;
            a.apply(c);
            transitions++;
            if (!visited.add(JSON.stringify(c))) continue;
            crashStates++;
            (c.crash!.refused ? refused : opened)[c.crash!.drops]!++;
            const cp = check(c, () => path(i, a.label));
            if (cp) return done({ path: path(i, a.label), message: cp });
          }
        }
        for (const a of actions(s, v, b)) {
          const c = JSON.parse(key) as State;
          a.apply(c);
          transitions++;
          const k = JSON.stringify(c);
          if (!visited.add(k)) continue;
          let id = labelId.get(a.label);
          if (id === undefined) {
            id = labels.push(a.label) - 1;
            labelId.set(a.label, id);
          }
          prev.push(i);
          step.push(id);
          next.push([k, prev.length - 1]);
        }
      } catch (err) {
        if (err instanceof PlanError) return done({ path: path(i), message: `plan: ${err.message}` });
        throw err;
      }
    }
    frontier = next;
    depth++;
  }
  return done();
}

function print(f: Found, to: (s: string) => void): void {
  f.path.forEach((s, i) => to(`    ${String(i + 1).padStart(2)}. ${s}`));
  to(`    => ${f.message}`);
}

function main(): void {
  console.log(`bound: tab 0 writes log p (then a, after its one failed write), tab 1 writes log q; ${BOUNDS.appends} acked appends,`);
  console.log(`       ${BOUNDS.commits} commits, ${BOUNDS.segCap} record(s) a segment; one browser crash ends each history, dropping up to ${BOUNDS.drops} manifests`);
  console.log(`rules: planIngest, planReclaim (lag ${RECLAIM_LAG}), checkCover from src/host/queues.ts`);

  const real = explore({}, BOUNDS);
  if (real.violation) {
    console.error(`\nFAIL after ${real.states} states:`);
    print(real.violation, console.error);
    process.exit(1);
  }
  console.log(`\nPASS ${real.states} states (${real.crashStates} after a crash), ${real.transitions} transitions, depth ${real.depth}, ${real.ms} ms`);
  console.log(`     crash states that opened / refused, by manifests dropped 0/1/2: ${real.opened.join("/")} / ${real.refused.join("/")}`);

  const mutants: [string, Variant][] = [
    ["(a) a failed write reopens the same log at segment lastAcked+1", { sameLogRecovery: true }],
    ["(b) the planner ignores pred edges", { ignorePred: true }],
    ["(c) a live log's durable hint is ignored", { ignoreHints: true }],
    ["(d) reclaim without lag", { lag: 0 }],
    ["(e) seal before the successor exists", { sealFirst: true }],
  ];
  let weak = false;
  for (const [name, v] of mutants) {
    const r = explore(v, BOUNDS);
    if (!r.violation) {
      console.error(`\nFAIL model too weak: ${name} passes (${r.states} states)`);
      weak = true;
      continue;
    }
    console.log(`\ncaught ${name} (${r.states} states, ${r.ms} ms):`);
    print(r.violation, console.log);
  }
  if (weak) process.exit(1);

  const oneDrop = explore({ lag: 1 }, { ...BOUNDS, drops: 1 });
  const twoDrops = explore({ lag: 1 }, BOUNDS);
  if (oneDrop.violation || !twoDrops.violation) {
    console.error("\nFAIL the one-generation lag no longer behaves as recorded (survives one dropped manifest, not two):");
    if (oneDrop.violation) print(oneDrop.violation, console.error);
    else console.error("    it now survives two: reconsider RECLAIM_LAG = 2");
    process.exit(1);
  }
  console.log(`\nfinding: reclaim lagging one generation survives one dropped manifest (${oneDrop.states} states), but after two:`);
  print(twoDrops.violation, console.log);

  if (real.reorder) {
    console.log("\nfinding, not gated: after a dropped manifest, ingest order can put a write before one its tab had seen ingested:");
    print(real.reorder, console.log);
  } else {
    console.log("\nthe causal-order finding no longer reproduces: gate causalReorder as a property");
  }
}

main();
