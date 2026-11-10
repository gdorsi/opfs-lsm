/**
 * One page, one key, the SharedWorker's ingest round and the page's install
 * of the manifest it publishes, in the step order the source uses
 * (`parse.ts`). A page reads its own acked records the installed cursor
 * does not cover, on top of the installed runs.
 */

/** The durable steps of an ingest round with records (`ingestQueues`). */
export type RoundStep = "publishL0" | "publishGeneration";
/** What the page's `install` does: swap in the manifest's runs, and drop its own records the cursor covers. */
export type InstallStep = "swapRuns" | "dropOwn";

export type Order = {
  readonly round: readonly RoundStep[];
  readonly install: readonly InstallStep[];
  /** Both install steps in one task, with no await between: no read sees one without the other. */
  readonly installAtomic: boolean;
};

/** A run a manifest names that was never written. */
const MISSING = "missing";
type Runs = number | undefined | typeof MISSING;

type State = {
  /** Values the page appended, in order: record n holds `log[n - 1]`, acked at once. */
  readonly log: readonly number[];
  /** The newest manifest: its cursor over the page's log, and what its runs read for the key. */
  readonly published: { readonly cursor: number; readonly runs: Runs };
  /** An ingest round in flight: the records it folds, and what it did so far. */
  readonly round: null | { readonly upTo: number; readonly l0: boolean; readonly step: number };
  /** The page's installed runs, and the cursor up to which it dropped its own records. */
  readonly page: { readonly runs: Runs; readonly dropped: number };
  /** An install in flight: the manifest it installs, and how many of its steps ran. */
  readonly install: null | { readonly cursor: number; readonly runs: Runs; readonly step: number };
};

type Action =
  | { readonly t: "append" }
  | { readonly t: "beginRound" }
  | { readonly t: "roundStep"; readonly step: RoundStep }
  | { readonly t: "install" }
  | { readonly t: "installStep"; readonly step: InstallStep };

const initial: State = {
  log: [],
  published: { cursor: 0, runs: undefined },
  round: null,
  page: { runs: undefined, dropped: 0 },
  install: null,
};

/** What `db.get` returns: the newest own record past the dropped cursor, else the installed runs. */
function read(s: State): number | undefined {
  if (s.log.length > s.page.dropped) return s.log[s.log.length - 1];
  return s.page.runs === MISSING ? undefined : s.page.runs;
}

/** NoLostAcks: the page reads its newest acked write. */
function noLostAcks(s: State): boolean {
  return s.log.length === 0 || read(s) === s.log[s.log.length - 1];
}

function enabled(s: State, order: Order, maxAppends: number): Action[] {
  const out: Action[] = [];
  if (s.log.length < maxAppends) out.push({ t: "append" });
  if (!s.round && s.log.length > s.published.cursor) out.push({ t: "beginRound" });
  if (s.round) out.push({ t: "roundStep", step: order.round[s.round.step]! });
  if (!s.install && s.published.cursor > s.page.dropped) out.push({ t: "install" });
  if (s.install) out.push({ t: "installStep", step: order.install[s.install.step]! });
  return out;
}

function applyInstall(s: State, step: InstallStep, cursor: number, runs: Runs): State {
  return step === "swapRuns" ? { ...s, page: { ...s.page, runs } } : { ...s, page: { ...s.page, dropped: Math.max(s.page.dropped, cursor) } };
}

function step(s: State, a: Action, order: Order): State {
  switch (a.t) {
    case "append":
      return { ...s, log: [...s.log, s.log.length + 1] };
    case "beginRound":
      return { ...s, round: { upTo: s.log.length, l0: false, step: 0 } };
    case "roundStep": {
      const r = s.round!;
      let next: State = s;
      if (a.step === "publishL0") next = { ...s, round: { ...r, l0: true } };
      else next = { ...s, published: { cursor: r.upTo, runs: r.l0 ? s.log[r.upTo - 1] : MISSING } };
      const n = r.step + 1;
      return { ...next, round: n >= order.round.length ? null : { ...(next.round ?? r), step: n } };
    }
    case "install": {
      const { cursor, runs } = s.published;
      if (order.installAtomic) return order.install.reduce((acc, st) => applyInstall(acc, st, cursor, runs), s);
      return { ...s, install: { cursor, runs, step: 0 } };
    }
    case "installStep": {
      const i = s.install!;
      const next = applyInstall(s, a.step, i.cursor, i.runs);
      const n = i.step + 1;
      return { ...next, install: n >= order.install.length ? null : { ...i, step: n } };
    }
  }
}

function label(a: Action): string {
  return a.t === "roundStep" || a.t === "installStep" ? a.step : a.t;
}

/** Breadth-first over every interleaving; the shortest path to the first state that loses an ack. */
export function explore(order: Order, maxAppends: number): { states: number; violation: string[] | null } {
  const nodes: { s: State; prev: number; a: Action | null }[] = [{ s: initial, prev: -1, a: null }];
  const seen = new Set([JSON.stringify(initial)]);
  for (let i = 0; i < nodes.length; i++) {
    const cur = nodes[i]!;
    if (!noLostAcks(cur.s)) {
      const path: string[] = [];
      for (let j = i; j > 0; j = nodes[j]!.prev) path.push(label(nodes[j]!.a!));
      return { states: seen.size, violation: path.reverse() };
    }
    for (const a of enabled(cur.s, order, maxAppends)) {
      const next = step(cur.s, a, order);
      const key = JSON.stringify(next);
      if (seen.has(key)) continue;
      seen.add(key);
      nodes.push({ s: next, prev: i, a });
    }
  }
  return { states: seen.size, violation: null };
}
