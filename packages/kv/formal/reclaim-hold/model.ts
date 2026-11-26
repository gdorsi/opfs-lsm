/**
 * Abstract model of loading a generation under churn (design.md, "Loading a
 * generation under churn"): one tab that syncs and opens views, against one
 * host that records generations and removes the files they replaced.
 *
 * The tab (`DbImpl` in src/db.ts):
 * - `retrying`: the first attempt takes no reclaim lock. After one finds a
 *   file missing, every later attempt holds the reclaim lock shared
 *   (`holdingFiles` in src/host/protocol.ts) from before its tail read to
 *   its install.
 * - an attempt (`catchUpToWal`, `follow`, `load`, `catchUp`): read the
 *   recorded generation from the tail, read its manifest, open each run,
 *   then install it and release the layers it replaces.
 * - `openRun` reuses a run the tab holds open, with no lock and no check.
 *   Otherwise `BrowserReadFs.open` (src/opfs/browser-fs.ts) takes the shared
 *   run lock, then checks that the file exists (`getFile`), and keeps the
 *   lock until the run closes.
 * - a `view` retains the installed layers until its callback ends. A run
 *   closes when no layers hold it (`release`, `dropRuns`).
 *
 * The host (`HostedDb` in src/host/engine-host.ts), one exclusive section at
 * a time:
 * - a flush records a generation with a new L0 run in front of the recorded
 *   runs, then removes the older manifests (`reclaimManifests`);
 * - a compaction install records one that replaces the recorded runs with
 *   its output, then sweeps (`reclaim`, `sweep`): the older manifests, then
 *   every run outside the recorded generation;
 * - a destroy records generation 0, which has no file, removes every
 *   manifest, then sweeps;
 * - a pass that installed nothing sweeps (`sweepIdle`).
 * Every removal runs under `unlessHeld`: the reclaim lock taken exclusively
 * when no tab holds it, else skipped, never waited for. A run goes only
 * through `removeUnlessOpen` (src/opfs/browser-fs.ts, src/store/generation.ts
 * `reclaimRuns`): under its run lock taken exclusively when available. Each
 * removal is a step of its own, so the tab can move between any two. The
 * files of a generation are on disk before IndexedDB records it, so a record
 * is one step. A destroy's two `unlessHeld` sections are one here.
 */

/** Product decisions a broken variant flips, to show the check catches each. */
export type Variant = {
  /** A retry takes no reclaim lock. */
  readonly retryUnlocked?: boolean;
  /** A retry takes the reclaim lock after it reads the tail. */
  readonly lockAfterTail?: boolean;
  /** `open` checks that the file exists before it takes the run lock. */
  readonly checkBeforeLock?: boolean;
  /** `unlessHeld` removes even while a tab holds the reclaim lock. */
  readonly hostIgnoresReclaimLock?: boolean;
  /** A run goes with a plain remove, whatever tab holds it open. */
  readonly hostIgnoresRunLock?: boolean;
  /** A view does not retain the layers it reads. */
  readonly viewNoRetain?: boolean;
};

export type Bounds = {
  readonly installs: number;
  readonly idleSweeps: number;
  readonly syncs: number;
  readonly views: number;
};

type Removal = { readonly manifest: number } | { readonly run: number };

type Host =
  | { at: "idle" }
  /** Recorded a generation; its `unlessHeld` has not asked for the lock yet. */
  | { at: "reclaim"; what: "manifests" | "sweep" | "destroy" }
  /** Holds the reclaim lock exclusively, with these removals left. */
  | { at: "removing"; left: Removal[] };

type Attempt = {
  /** Holds the reclaim lock shared. */
  locked: boolean;
  /** Not the first attempt of this sync: `retrying` runs it under `holdingFiles`. */
  retry: boolean;
  at: "lock" | "tail" | "manifest" | "open" | "check" | "lockAfterCheck" | "install";
  /** The generation the tail named, once read. */
  gen: number | undefined;
  /** The next run of `gen` to open. */
  next: number;
  /** The runs this load holds open so far. */
  opened: number[];
};

export type Tab = {
  installed: number;
  /** Layers held per generation: the installed one, and each view's. */
  refs: Record<number, number>;
  /** Per run, how many layers hold it open. */
  holds: Record<number, number>;
  /** The run locks the tab holds. */
  locks: number[];
  attempt: Attempt | undefined;
  /** The generation each open view reads. */
  views: number[];
  syncsLeft: number;
  viewsLeft: number;
};

export type State = {
  /** `meta.generation`. */
  recorded: number;
  /** The highest manifest number in use. */
  top: number;
  nextRun: number;
  /** The runs each generation lists. Generation 0 lists none and has no file. */
  gens: Record<number, number[]>;
  manifests: number[];
  files: number[];
  host: Host;
  installsLeft: number;
  idleSweepsLeft: number;
  tab: Tab;
  fault?: string;
};

export type Action =
  | { readonly who: "host"; readonly type: "flush" | "compact" | "destroy" | "sweepIdle" | "unlessHeld" | "remove" }
  | { readonly who: "tab"; readonly type: "sync" | "step" | "openView" | "closeView" };

export function initial(b: Bounds): State {
  return {
    recorded: 1,
    top: 1,
    nextRun: 2,
    gens: { 0: [], 1: [1] },
    manifests: [1],
    files: [1],
    host: { at: "idle" },
    installsLeft: b.installs,
    idleSweepsLeft: b.idleSweeps,
    tab: { installed: 1, refs: { 1: 1 }, holds: { 1: 1 }, locks: [1], attempt: undefined, views: [], syncsLeft: b.syncs, viewsLeft: b.views },
  };
}

export function copy(s: State): State {
  const t = s.tab;
  return {
    ...s,
    gens: { ...s.gens },
    manifests: [...s.manifests],
    files: [...s.files],
    host: s.host.at === "removing" ? { at: "removing", left: [...s.host.left] } : s.host,
    tab: {
      ...t,
      refs: { ...t.refs },
      holds: { ...t.holds },
      locks: [...t.locks],
      attempt: t.attempt && { ...t.attempt, opened: [...t.attempt.opened] },
      views: [...t.views],
    },
  };
}

export function encode(s: State): string {
  return JSON.stringify(s);
}

const without = (xs: number[], x: number): number[] => xs.filter((y) => y !== x);
const add = (xs: number[], x: number): number[] => (xs.includes(x) ? xs : [...xs, x].sort((a, b) => a - b));

export function enabled(s: State): Action[] {
  const out: Action[] = [];
  const h = s.host;
  if (h.at === "idle") {
    if (s.installsLeft > 0) {
      out.push({ who: "host", type: "flush" });
      if (s.gens[s.recorded]!.length > 0) out.push({ who: "host", type: "compact" });
      if (s.recorded !== 0) out.push({ who: "host", type: "destroy" });
    }
    if (s.idleSweepsLeft > 0) out.push({ who: "host", type: "sweepIdle" });
  } else if (h.at === "reclaim") out.push({ who: "host", type: "unlessHeld" });
  else out.push({ who: "host", type: "remove" });

  const t = s.tab;
  const a = t.attempt;
  if (!a && t.syncsLeft > 0) out.push({ who: "tab", type: "sync" });
  // `holdingFiles` waits only while the host holds the lock exclusively.
  if (a && !(a.at === "lock" && h.at === "removing")) out.push({ who: "tab", type: "step" });
  if (t.views.length === 0 && t.viewsLeft > 0) out.push({ who: "tab", type: "openView" });
  if (t.views.length > 0) out.push({ who: "tab", type: "closeView" });
  return out;
}

/** The host records `gen` with `runs`, whose new files are already on disk. */
function record(s: State, runs: number[], what: "manifests" | "sweep"): void {
  s.installsLeft--;
  const gen = ++s.top;
  const run = s.nextRun++;
  s.gens[gen] = [run, ...runs];
  s.files = add(s.files, run);
  s.manifests = add(s.manifests, gen);
  s.recorded = gen;
  s.host = { at: "reclaim", what };
}

/** The tab's layers of `gen` lose one holder; at none, each of its runs closes once. */
function release(t: Tab, gen: number): void {
  if (--t.refs[gen]! > 0) return;
  delete t.refs[gen];
}

function closeRuns(t: Tab, runs: readonly number[]): void {
  for (const r of runs) {
    if (--t.holds[r]! > 0) continue;
    delete t.holds[r];
    t.locks = without(t.locks, r);
  }
}

function dropLayers(s: State, gen: number): void {
  const t = s.tab;
  const left = (t.refs[gen] ?? 0) - 1;
  release(t, gen);
  if (left === 0) closeRuns(t, s.gens[gen]!);
}

function finish(t: Tab): void {
  t.attempt = undefined;
}

/** An attempt found a file missing: it closes what it opened, and `retrying` runs another. */
function gone(s: State, v: Variant, what: string): string {
  const t = s.tab;
  const a = t.attempt!;
  closeRuns(t, a.opened);
  if (a.retry) {
    s.fault ??= `LockedLoad: a retry${a.locked ? " under the reclaim lock" : ""} found ${what} gone, so a healthy database counts toward CorruptDatabaseError`;
  }
  t.attempt = {
    locked: false,
    retry: true,
    at: v.retryUnlocked || v.lockAfterTail ? "tail" : "lock",
    gen: undefined,
    next: 0,
    opened: [],
  };
  return `tab: ${what} is gone, the attempt closes its runs and retries`;
}

/** Applies `a` to `s` in place and says what happened, in product words. */
export function step(s: State, act: Action, v: Variant): string {
  const t = s.tab;
  if (act.who === "host") {
    switch (act.type) {
      case "flush":
        record(s, s.gens[s.recorded]!, "manifests");
        return `host: flush records ${s.recorded} = [${s.gens[s.recorded]!.join(",")}]`;
      case "compact":
        record(s, [], "sweep");
        return `host: compaction records ${s.recorded} = [${s.gens[s.recorded]!.join(",")}]`;
      case "destroy":
        s.installsLeft--;
        s.recorded = 0;
        s.host = { at: "reclaim", what: "destroy" };
        return "host: destroy records generation 0";
      case "sweepIdle":
        s.idleSweepsLeft--;
        s.host = { at: "reclaim", what: "sweep" };
        return "host: a pass that installed nothing sweeps";
      case "unlessHeld": {
        const h = s.host;
        if (h.at !== "reclaim") throw new Error("model: unlessHeld");
        if (t.attempt?.locked && !v.hostIgnoresReclaimLock) {
          s.host = { at: "idle" };
          return "host: a tab holds the reclaim lock, the removal is skipped";
        }
        const left: Removal[] = [];
        for (const n of s.manifests) if (h.what === "destroy" || n < s.recorded) left.push({ manifest: n });
        if (h.what !== "manifests") {
          const live = s.gens[s.recorded]!;
          for (const r of s.files) if (!live.includes(r)) left.push({ run: r });
        }
        s.host = left.length > 0 ? { at: "removing", left } : { at: "idle" };
        return `host: takes the reclaim lock exclusively to remove ${left.length} file(s)`;
      }
      case "remove": {
        const h = s.host;
        if (h.at !== "removing") throw new Error("model: remove");
        const r = h.left.shift()!;
        if (h.left.length === 0) s.host = { at: "idle" };
        if ("manifest" in r) {
          s.manifests = without(s.manifests, r.manifest);
          return `host: removes manifest ${r.manifest}`;
        }
        if (t.locks.includes(r.run) && !v.hostIgnoresRunLock) return `host: run ${r.run} is open in a tab, it stays`;
        s.files = without(s.files, r.run);
        return `host: removes run ${r.run}`;
      }
    }
  }
  switch (act.type) {
    case "sync":
      t.syncsLeft--;
      t.attempt = { locked: false, retry: false, at: "tail", gen: undefined, next: 0, opened: [] };
      return "tab: sync starts its first attempt, with no reclaim lock";
    case "openView": {
      t.viewsLeft--;
      t.views.push(t.installed);
      if (!v.viewNoRetain) t.refs[t.installed] = (t.refs[t.installed] ?? 0) + 1;
      return `tab: a view opens on generation ${t.installed}`;
    }
    case "closeView": {
      const gen = t.views.pop()!;
      if (!v.viewNoRetain) dropLayers(s, gen);
      return `tab: the view on generation ${gen} ends`;
    }
    case "step":
      break;
  }
  const a = t.attempt!;
  switch (a.at) {
    case "lock":
      a.locked = true;
      a.at = a.gen === undefined ? "tail" : "manifest";
      return "tab: the retry takes the reclaim lock shared";
    case "tail": {
      a.gen = s.recorded;
      if (a.gen === t.installed) {
        finish(t);
        return `tab: the tail names generation ${a.gen}, installed already: sync done`;
      }
      a.at = a.retry && v.lockAfterTail && !v.retryUnlocked && !a.locked ? "lock" : "manifest";
      return `tab: the tail names generation ${a.gen}`;
    }
    case "manifest":
      if (a.gen !== 0 && !s.manifests.includes(a.gen!)) return gone(s, v, `manifest ${a.gen}`);
      a.at = "open";
      return `tab: reads manifest ${a.gen}`;
    case "open": {
      const runs = s.gens[a.gen!]!;
      if (a.next === runs.length) {
        a.at = "install";
        return `tab: every run of generation ${a.gen} is open`;
      }
      const r = runs[a.next]!;
      if ((t.holds[r] ?? 0) > 0) {
        t.holds[r]!++;
        a.opened.push(r);
        a.next++;
        return `tab: run ${r} is open already, reused`;
      }
      if (v.checkBeforeLock) {
        if (!s.files.includes(r)) return gone(s, v, `run ${r}`);
        a.at = "lockAfterCheck";
        return `tab: run ${r} exists`;
      }
      t.locks = add(t.locks, r);
      a.at = "check";
      return `tab: takes the run lock of ${r} shared`;
    }
    case "check": {
      const r = s.gens[a.gen!]![a.next]!;
      if (!s.files.includes(r)) {
        t.locks = without(t.locks, r);
        return gone(s, v, `run ${r}`);
      }
      t.holds[r] = 1;
      a.opened.push(r);
      a.next++;
      a.at = "open";
      return `tab: run ${r} exists, it stays open`;
    }
    case "lockAfterCheck": {
      const r = s.gens[a.gen!]![a.next]!;
      t.locks = add(t.locks, r);
      t.holds[r] = 1;
      a.opened.push(r);
      a.next++;
      a.at = "open";
      return `tab: takes the run lock of ${r} shared`;
    }
    case "install": {
      const gen = a.gen!;
      t.refs[gen] = (t.refs[gen] ?? 0) + 1;
      const old = t.installed;
      t.installed = gen;
      dropLayers(s, old);
      finish(t);
      return `tab: installs generation ${gen} and releases ${old}: sync done`;
    }
  }
}

/** The properties every state must hold, or the first that breaks. */
export function violation(s: State): string | undefined {
  if (s.fault) return s.fault;
  const t = s.tab;
  for (const [run, n] of Object.entries(t.holds)) {
    if (n > 0 && !s.files.includes(Number(run))) return `HeldStays: run ${run} is open in the tab and gone from disk`;
  }
  for (const r of s.gens[t.installed]!) if (!s.files.includes(r)) return `HeldStays: run ${r} of the installed generation ${t.installed} is gone`;
  for (const gen of t.views) {
    for (const r of s.gens[gen]!) if (!s.files.includes(r)) return `ViewHolds: run ${r} of generation ${gen}, which an open view reads, is gone`;
  }
  return undefined;
}
