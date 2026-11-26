/**
 * Abstract model of how one tab follows the log (design.md, "Memtable",
 * "Installing a generation", "Change events"): the tab under test, another
 * tab that appends, and a host that flushes, compacts and destroys.
 *
 * The tab (`DbImpl` in src/db.ts) runs several calls at once, and every
 * await is a step of its own:
 * - `sync` (`coalesced`, `retrying`, `catchUpToWal`, `follow`): read the tail,
 *   load its generation when the tab lacks it (`load`, with `has` before and
 *   after the await), then `catchUp`. A call while one runs makes it run
 *   once more. A pass that ends "behind" or "gone" runs again.
 * - `write` (`appendAfter`): one transaction reads the tail, runs `catchUp`
 *   and appends past the head, unless `catchUp` names a generation to load;
 *   then `load(missing, true)` and another transaction. The row then lands.
 * - `commit`: an append by group commit, then the row lands.
 * - `landed`: `applyRecord`, and on a gap a `sync` it waits for.
 * - a BroadcastChannel message: a row applies (a gap syncs instead), an
 *   `ingest` syncs. Messages of one sender come in order, or never.
 * `catchUp`, `has`, `old`, `advance` and `Memtable.apply` / `advanceTo` are
 * transcribed; regex guards in check.ts hold them to the source.
 *
 * The log writes two keys: seq `s` puts key `s % 2` with value `s`, and a
 * destroy is one entry at its seq that deletes both. A generation reads the
 * state after its `through`; generation 0 reads empty. One IndexedDB
 * transaction of the host is one step: a flush records `ingestedThrough`
 * and `generation` together (`advanceIngested`), a compaction a new number
 * with the same `through`, a destroy generation 0 past the head. Files are
 * never removed for good: a load of a generation that is no longer recorded
 * may find one gone on a first attempt (the host reclaimed it), never on a
 * retry, which holds the reclaim lock (ReclaimHold owns that). Omits
 * repair, `boot`, views and range deletes.
 */

export type Variant = {
  /** `advanceIngested` records `ingestedThrough` in one transaction and the generation in a later one. */
  readonly splitAdvance?: boolean;
  /** `catchUp` installs a newer generation named by a tail read before the installed one was recorded (no `old` test). */
  readonly installOld?: boolean;
  /** `has` counts a lower generation as held although the tail is ahead of the memtable. */
  readonly hasIgnoresAhead?: boolean;
  /** `catchUp` advances the memtable to the tail's `ingestedThrough` whatever generation is installed. */
  readonly advanceAlways?: boolean;
  /** The memtable jumps past seqs it never read with no `gap` event. */
  readonly jumpNoGap?: boolean;
};

export type Bounds = {
  /** Appends of the other tab. */
  readonly appends: number;
  /** Flushes, compactions and destroys of the host. */
  readonly installs: number;
  /** `sync` calls of the tab, besides the ones its messages and landings make. */
  readonly syncs: number;
  /** `put` calls of the tab (group commit). */
  readonly puts: number;
  /** `write` calls of the tab (`appendAfter`, as `update` runs it). */
  readonly writes: number;
};

/** The value of each key: the seq that last put it, 0 for none. */
type Keys = [number, number];
const keyOf = (seq: number): 0 | 1 => (seq % 2) as 0 | 1;

type Layers = { readonly gen: number; readonly through: number; readonly content: Keys };
type Tail = { readonly head: number; readonly gen: number; readonly ingested: number; readonly records: readonly number[] };
type Event = { readonly kind: "append"; readonly seq: number } | { readonly kind: "gap"; readonly through: number };
type Msg = { readonly kind: "rows"; readonly seq: number } | { readonly kind: "ingest" };

type SyncTask =
  | { at: "idle" }
  | { at: "tail"; retry: boolean; tries: number }
  | { at: "loading"; tail: Tail; ahead: boolean; retry: boolean; tries: number };

/** A `write` or a `put` of the tab. */
type WriteTask =
  | { at: "idle" }
  | { at: "commit" }
  | { at: "txn"; retry: boolean; tries: number }
  | { at: "load"; gen: number; retry: boolean; tries: number }
  | { at: "loading"; gen: number; retry: boolean; tries: number }
  | { at: "landed"; seq: number }
  | { at: "waitSync"; seq: number };

export type Tab = {
  applied: number;
  /** `Memtable.ingestedThrough`. */
  ingested: number;
  /** The memtable row of each key: the seq that put it, 0 for none. */
  rows: Keys;
  installed: Layers;
  loaded: Layers | null;
  /** Applied and not yet announced. */
  unannounced: Event[];
  /** What a listener rebuilt from the events, and the seq they reach. */
  mirror: Keys;
  announced: number;
  sync: SyncTask;
  again: boolean;
  write: WriteTask;
  put: WriteTask;
  syncsLeft: number;
  putsLeft: number;
  writesLeft: number;
};

export type State = {
  /** `log[s]` for s >= 1: "p" a put, "d" a destroy. Its last index is the head. */
  log: ("p" | "d")[];
  ingested: number;
  gen: number;
  top: number;
  /** `through` of each manifest number. */
  manifests: Record<number, number>;
  /** Only with `splitAdvance`: the generation a flush records in its second transaction. */
  pendingGen: number | null;
  bus: Msg[];
  appendsLeft: number;
  installsLeft: number;
  tab: Tab;
  fault?: string;
};

export type Action =
  | { readonly who: "other"; readonly type: "append" }
  | { readonly who: "host"; readonly type: "flushAll" | "flushOldest" | "recordGen" | "compact" | "destroy" }
  | { readonly who: "bus"; readonly type: "deliver" | "drop" }
  | { readonly who: "tab"; readonly type: "callSync" | "callPut" | "callWrite" | "syncStep" | "writeStep" | "putStep" | "syncLoadGone" | "writeLoadGone" };

/** Branches of the product the exploration took, so a pass shows it reached them. */
export const reached = new Set<string>();

/** Retries of one call past this many are a livelock: the host stopped, so a pass must end. */
function tryLimit(b: Bounds): number {
  return b.installs + 3;
}

export function initial(b: Bounds): State {
  const empty: Layers = { gen: 0, through: 0, content: [0, 0] };
  return {
    log: ["p"],
    ingested: 0,
    gen: 0,
    top: 0,
    manifests: {},
    pendingGen: null,
    bus: [],
    appendsLeft: b.appends,
    installsLeft: b.installs,
    tab: {
      applied: 0,
      ingested: 0,
      rows: [0, 0],
      installed: empty,
      loaded: null,
      unannounced: [],
      mirror: [0, 0],
      announced: 0,
      sync: { at: "idle" },
      again: false,
      write: { at: "idle" },
      put: { at: "idle" },
      syncsLeft: b.syncs,
      putsLeft: b.puts,
      writesLeft: b.writes,
    },
  };
}

/** Tasks, layers and tails are replaced, never changed, so they are shared. */
export function copy(s: State): State {
  const t = s.tab;
  return {
    ...s,
    log: s.log.slice(),
    manifests: { ...s.manifests },
    bus: s.bus.slice(),
    tab: { ...t, rows: [t.rows[0], t.rows[1]], mirror: [t.mirror[0], t.mirror[1]], unannounced: t.unannounced.slice() },
  };
}

export function encode(s: State): string {
  return JSON.stringify(s);
}

const head = (s: State): number => s.log.length - 1;

/** The state after seq `at`. */
function stateAt(s: State, at: number): Keys {
  const v: Keys = [0, 0];
  for (let i = 1; i <= at; i++) {
    if (s.log[i] === "d") v[0] = v[1] = 0;
    else v[keyOf(i)] = i;
  }
  return v;
}

function layersOf(s: State, gen: number): Layers {
  if (gen === 0) return { gen: 0, through: 0, content: [0, 0] };
  const through = s.manifests[gen]!;
  return { gen, through, content: stateAt(s, through) };
}

/** What a `get` of each key returns: the memtable row over the installed generation. */
function read(t: Tab): Keys {
  return [t.rows[0] || t.installed.content[0], t.rows[1] || t.installed.content[1]];
}

function readTail(s: State, since: number): Tail {
  const after = Math.max(since, s.ingested);
  const records: number[] = [];
  for (let seq = after + 1; seq <= head(s); seq++) records.push(seq);
  return { head: head(s), gen: s.gen, ingested: s.ingested, records };
}

// --- The tab, transcribed from src/db.ts and src/store/memtable.ts.

function applyRecord(t: Tab, seq: number): "applied" | "already" | "gap" {
  if (seq <= t.applied) return "already";
  if (seq !== t.applied + 1) return "gap";
  t.rows[keyOf(seq)] = seq;
  t.applied = seq;
  t.unannounced.push({ kind: "append", seq });
  return "applied";
}

function advance(t: Tab, through: number, v: Variant): void {
  if (through <= t.ingested) return;
  t.ingested = through;
  const jumped = through > t.applied;
  t.applied = Math.max(t.applied, through);
  for (const k of [0, 1] as const) if (jumped || t.rows[k] <= through) t.rows[k] = 0;
  if (jumped) reached.add("the memtable jumps past seqs it never read");
  if (jumped && !v.jumpNoGap) t.unannounced.push({ kind: "gap", through: t.applied });
}

function has(t: Tab, gen: number, ahead: boolean, v: Variant): boolean {
  return [t.installed, t.loaded].some((l) => l !== null && (l.gen === gen || (l.gen > gen && (v.hasIgnoresAhead || !ahead))));
}

function old(t: Tab, tail: Tail): boolean {
  return tail.ingested < t.ingested;
}

/** `catchUp`: the generation to load, or undefined. A wal gap is a fault. */
function catchUp(s: State, tail: Tail, v: Variant): number | undefined {
  const t = s.tab;
  const behind = tail.ingested > t.applied;
  const layers = t.loaded?.gen === tail.gen ? t.loaded : null;
  if (tail.gen > t.installed.gen && old(t, tail)) reached.add("a stale tail names a higher generation than the installed one");
  if ((tail.gen > t.installed.gen && (v.installOld || !old(t, tail))) || (behind && tail.gen < t.installed.gen)) {
    if (layers) {
      reached.add(tail.gen < t.installed.gen ? "a lower generation ahead of the memtable is installed" : "a higher generation is installed");
      t.installed = layers;
      t.loaded = null;
    } else if (behind) {
      reached.add("a catch-up names a generation to load");
      return tail.gen;
    }
  }
  if (t.loaded && (t.loaded.gen <= t.installed.gen || t.loaded === layers)) t.loaded = null;
  if (v.advanceAlways || t.installed.gen === tail.gen) advance(t, tail.ingested, v);
  for (const seq of tail.records) {
    if (applyRecord(t, seq) === "gap") {
      s.fault ??= `WalGap: a catch-up read a tail whose seq ${seq} does not follow the memtable at ${t.applied}: CommitError on a healthy database`;
      return undefined;
    }
  }
  return undefined;
}

/** The listener hears what waits, and rebuilds its copy: an append's put, a fresh read at a gap. */
function announce(s: State): void {
  const t = s.tab;
  for (const e of t.unannounced) {
    if (e.kind === "append") {
      if (e.seq <= t.announced) s.fault ??= `FeedOnce: seq ${e.seq} announced again, after the events reached seq ${t.announced}`;
      else if (e.seq > t.announced + 1) s.fault ??= `FeedNoLoss: an append of seq ${e.seq} follows events that reach seq ${t.announced}, with no gap for the seqs between`;
      t.mirror[keyOf(e.seq)] = e.seq;
      t.announced = Math.max(t.announced, e.seq);
    } else {
      reached.add("a gap is announced");
      if (e.through <= t.announced) s.fault ??= `FeedOnce: a gap through ${e.through} covers seqs already announced through ${t.announced}`;
      t.mirror = read(t);
      t.announced = Math.max(t.announced, e.through);
    }
  }
  t.unannounced = [];
  if (t.announced !== t.applied) s.fault ??= `FeedComplete: the memtable is at seq ${t.applied} and the events reach seq ${t.announced}`;
  const now = read(t);
  if (now[0] !== t.mirror[0] || now[1] !== t.mirror[1]) {
    s.fault ??= `FeedRebuild: the copy rebuilt from the events reads [${t.mirror.join(",")}], the tab reads [${now.join(",")}]`;
  }
}

function requestSync(t: Tab): void {
  if (t.sync.at !== "idle") {
    reached.add("a sync is called while one runs");
    t.again = true;
  }
  else t.sync = { at: "tail", retry: false, tries: 0 };
}

/** A pass of `sync` that ended "behind" or "gone" runs again, holding the reclaim lock. */
function retrySync(s: State, b: Bounds, tries: number): void {
  if (tries + 1 > tryLimit(b)) s.fault ??= `Livelock: a sync ran ${tries + 1} attempts with the host stopped`;
  s.tab.sync = { at: "tail", retry: true, tries: tries + 1 };
}

/** The end of `follow`: catch up, announce, and finish the pass or retry. `whole` is what `load` returned. */
function followRest(s: State, b: Bounds, tail: Tail, whole: boolean, tries: number, v: Variant): void {
  const t = s.tab;
  const missing = catchUp(s, tail, v);
  announce(s);
  if (missing !== undefined) {
    retrySync(s, b, tries);
    return;
  }
  void whole;
  if (t.again) {
    t.again = false;
    t.sync = { at: "tail", retry: false, tries: 0 };
  } else t.sync = { at: "idle" };
}

/** A load's last step: the files read, then `has` again. False when a file was gone. */
function finishLoad(s: State, gen: number, ahead: boolean, gone: boolean, v: Variant): boolean {
  const t = s.tab;
  if (gone) {
    reached.add("a load finds a file reclaimed");
    return false;
  }
  if (has(t, gen, ahead, v)) {
    reached.add("a load ends with the generation held already");
    return true;
  }
  t.loaded = layersOf(s, gen);
  return true;
}

/** A load whose generation is no longer recorded may find a file reclaimed, on a first attempt only. */
function mayBeGone(s: State, gen: number, retry: boolean): boolean {
  return !retry && gen !== 0 && gen !== s.gen;
}

function landed(s: State, task: "write" | "put", seq: number, v: Variant): void {
  const t = s.tab;
  announce(s);
  if (applyRecord(t, seq) === "gap") {
    reached.add("a row of the tab lands past a gap");
    requestSync(t);
    t[task] = { at: "waitSync", seq };
    return;
  }
  announce(s);
  resolve(s, task, seq);
  void v;
}

function resolve(s: State, task: "write" | "put", seq: number): void {
  const t = s.tab;
  if (t.applied < seq) s.fault ??= `ReadYourWrites: a ${task} resolved at seq ${seq} with the memtable at seq ${t.applied}`;
  t[task] = { at: "idle" };
}

export function enabled(s: State): Action[] {
  const out: Action[] = [];
  const t = s.tab;
  if (s.appendsLeft > 0) out.push({ who: "other", type: "append" });
  if (s.pendingGen !== null) out.push({ who: "host", type: "recordGen" });
  else if (s.installsLeft > 0) {
    if (head(s) > s.ingested) out.push({ who: "host", type: "flushAll" });
    if (head(s) > s.ingested + 1) out.push({ who: "host", type: "flushOldest" });
    if (s.gen !== 0) out.push({ who: "host", type: "compact" });
    if (s.gen !== 0 || head(s) > s.ingested) out.push({ who: "host", type: "destroy" });
  }
  if (s.bus.length > 0) out.push({ who: "bus", type: "deliver" }, { who: "bus", type: "drop" });
  if (t.syncsLeft > 0) out.push({ who: "tab", type: "callSync" });
  if (t.putsLeft > 0 && t.put.at === "idle") out.push({ who: "tab", type: "callPut" });
  if (t.writesLeft > 0 && t.write.at === "idle") out.push({ who: "tab", type: "callWrite" });
  if (t.sync.at !== "idle") {
    out.push({ who: "tab", type: "syncStep" });
    if (t.sync.at === "loading" && mayBeGone(s, t.sync.tail.gen, t.sync.retry)) out.push({ who: "tab", type: "syncLoadGone" });
  }
  for (const task of ["write", "put"] as const) {
    const w = t[task];
    if (w.at === "idle" || (w.at === "waitSync" && t.sync.at !== "idle")) continue;
    out.push({ who: "tab", type: task === "write" ? "writeStep" : "putStep" });
  }
  if (t.write.at === "loading" && mayBeGone(s, t.write.gen, t.write.retry)) out.push({ who: "tab", type: "writeLoadGone" });
  return out;
}

function flush(s: State, through: number, v: Variant): string {
  s.installsLeft--;
  const gen = ++s.top;
  s.manifests[gen] = through;
  s.ingested = through;
  if (v.splitAdvance) {
    s.pendingGen = gen;
    return `host: flush writes manifest ${gen} through ${through}, and records ingestedThrough ${through} alone`;
  }
  s.gen = gen;
  s.bus.push({ kind: "ingest" });
  return `host: flush records generation ${gen} through ${through}`;
}

/** Applies `a` to `s` in place and says what happened, in product words. */
export function step(s: State, a: Action, b: Bounds, v: Variant): string {
  const t = s.tab;
  switch (a.type) {
    case "append": {
      s.appendsLeft--;
      s.log.push("p");
      s.bus.push({ kind: "rows", seq: head(s) });
      return `other tab: appends seq ${head(s)} (key ${keyOf(head(s))}) and posts its row`;
    }
    case "flushAll":
      return flush(s, head(s), v);
    case "flushOldest":
      return flush(s, s.ingested + 1, v);
    case "recordGen":
      s.gen = s.pendingGen!;
      s.pendingGen = null;
      s.bus.push({ kind: "ingest" });
      return `host: records generation ${s.gen}`;
    case "compact": {
      s.installsLeft--;
      const gen = ++s.top;
      s.manifests[gen] = s.manifests[s.gen]!;
      s.gen = gen;
      s.bus.push({ kind: "ingest" });
      return `host: compaction records generation ${gen} through ${s.manifests[gen]}`;
    }
    case "destroy": {
      s.installsLeft--;
      s.log.push("d");
      s.ingested = head(s);
      s.gen = 0;
      s.bus.push({ kind: "ingest" });
      return `host: destroy records generation 0 with ingestedThrough ${head(s)}`;
    }
    case "deliver": {
      const m = s.bus.shift()!;
      if (m.kind === "ingest") {
        requestSync(t);
        return "tab: hears ingest, syncs";
      }
      const r = applyRecord(t, m.seq);
      if (r === "gap") requestSync(t);
      announce(s);
      return `tab: hears the row of seq ${m.seq}: ${r}${r === "gap" ? ", syncs" : ""}`;
    }
    case "drop":
      return `bus: drops ${s.bus.shift()!.kind}`;
    case "callSync":
      t.syncsLeft--;
      requestSync(t);
      return "tab: calls sync";
    case "callPut":
      t.putsLeft--;
      t.put = { at: "commit" };
      return "tab: calls put";
    case "callWrite":
      t.writesLeft--;
      t.write = { at: "txn", retry: false, tries: 0 };
      return "tab: calls write (appendAfter)";
    case "syncLoadGone": {
      if (t.sync.at !== "loading") throw new Error("model: syncLoadGone");
      const { tail, tries } = t.sync;
      finishLoad(s, tail.gen, t.sync.ahead, true, v);
      followRest(s, b, tail, false, tries, v);
      return `tab: the sync's load of generation ${tail.gen} finds a file reclaimed; it catches up to the tail it read`;
    }
    case "writeLoadGone": {
      const w = t.write;
      if (w.at !== "loading") throw new Error("model: writeLoadGone");
      if (w.tries + 1 > tryLimit(b)) s.fault ??= `Livelock: a write ran ${w.tries + 1} attempts`;
      t.write = { at: "txn", retry: true, tries: w.tries + 1 };
      return `tab: the write's load of generation ${w.gen} finds a file reclaimed, it tries again`;
    }
    case "syncStep": {
      const sy = t.sync;
      if (sy.at === "tail") {
        const tail = readTail(s, t.applied);
        const label = `tab: sync reads the tail: generation ${tail.gen}, ingestedThrough ${tail.ingested}, head ${tail.head}`;
        if (tail.gen !== t.installed.gen && !old(t, tail)) {
          const ahead = tail.ingested > t.applied;
          if (!has(t, tail.gen, ahead, v)) {
            t.sync = { at: "loading", tail, ahead, retry: sy.retry, tries: sy.tries };
            return `${label}; loads generation ${tail.gen}`;
          }
        }
        followRest(s, b, tail, true, sy.tries, v);
        return `${label}; catches up to it`;
      }
      if (sy.at !== "loading") throw new Error("model: syncStep");
      const whole = finishLoad(s, sy.tail.gen, sy.ahead, false, v);
      followRest(s, b, sy.tail, whole, sy.tries, v);
      return `tab: the sync's load of generation ${sy.tail.gen} ends; it catches up to the tail it read`;
    }
    case "writeStep":
    case "putStep": {
      const task = a.type === "writeStep" ? "write" : "put";
      const w = t[task];
      switch (w.at) {
        case "commit": {
          s.log.push("p");
          t.put = { at: "landed", seq: head(s) };
          return `tab: the put commits at seq ${head(s)}`;
        }
        case "txn": {
          const tail = readTail(s, t.applied);
          const missing = catchUp(s, tail, v);
          if (missing !== undefined) {
            t.write = { at: "load", gen: missing, retry: w.retry, tries: w.tries };
            return `tab: the write's transaction reads generation ${tail.gen}, which the tab lacks, and appends nothing`;
          }
          s.log.push("p");
          t.write = { at: "landed", seq: head(s) };
          return `tab: the write's transaction catches up to seq ${tail.head} and appends seq ${head(s)}`;
        }
        case "load": {
          announce(s);
          if (has(t, w.gen, true, v)) {
            if (w.tries + 1 > tryLimit(b)) s.fault ??= `Livelock: a write ran ${w.tries + 1} attempts with the host stopped`;
            t.write = { at: "txn", retry: true, tries: w.tries + 1 };
            return `tab: the write holds generation ${w.gen} already, it tries again`;
          }
          t.write = { at: "loading", gen: w.gen, retry: w.retry, tries: w.tries };
          return `tab: the write loads generation ${w.gen}`;
        }
        case "loading": {
          finishLoad(s, w.gen, true, false, v);
          if (w.tries + 1 > tryLimit(b)) s.fault ??= `Livelock: a write ran ${w.tries + 1} attempts with the host stopped`;
          t.write = { at: "txn", retry: true, tries: w.tries + 1 };
          return `tab: the write's load of generation ${w.gen} ends, it tries again`;
        }
        case "landed":
          landed(s, task, w.seq, v);
          return `tab: the ${task}'s row lands at seq ${w.seq}${t[task].at === "waitSync" ? " past a gap: it waits for a sync" : ", it resolves"}`;
        case "waitSync":
          announce(s);
          resolve(s, task, w.seq);
          return `tab: the sync the ${task} waited for ends, it resolves`;
        case "idle":
          throw new Error("model: idle task stepped");
      }
    }
  }
  throw new Error(`model: ${a.type}`);
}

/** The properties every state must hold, or the first that breaks. */
export function violation(s: State, actions: number): string | undefined {
  if (s.fault) return s.fault;
  const t = s.tab;
  const want = stateAt(s, t.applied);
  const got = read(t);
  if (got[0] !== want[0] || got[1] !== want[1]) {
    return `PrefixExact: at appliedThrough ${t.applied} the tab reads [${got.join(",")}] (memtable [${t.rows.join(",")}] over generation ${t.installed.gen}), where the log reads [${want.join(",")}]`;
  }
  if (actions === 0 && (t.sync.at !== "idle" || t.write.at !== "idle" || t.put.at !== "idle")) return "Stuck: nothing can run and a call of the tab never ends";
  return undefined;
}

/** What a step changes that a check must see: the tab's `appliedThrough` never goes back. */
export function monotone(before: State, after: State): string | undefined {
  if (after.tab.applied < before.tab.applied) return `Monotone: appliedThrough went back from ${before.tab.applied} to ${after.tab.applied}`;
  return undefined;
}
