/**
 * Update exactness: concurrent `update`s lose nothing, whichever way their
 * awaits interleave.
 *
 * Run: pnpm --filter @opfs-lsm/kv formal:update-exact
 *
 * Two tabs share one WAL and one key. Each calls `update` and `put`, and
 * hears the other's rows one seq at a time. Every await of the product is a
 * step of its own: an update loads its keys, a row joins a group commit,
 * the commit gives it a seq, and the row lands in its tab's memtable. A
 * recovery that drops the WAL records may run once, between any two steps.
 *
 * An update first loads its keys (`warm`), an await, and its body reads
 * that load only when nothing landed since, else the memtable. It appends a
 * row valid only at `appliedThrough + 1` (`rowValid`). At any other seq the
 * row has no ops, and the update runs again inside a transaction that loads
 * its keys again and reads the tail first. An update may also take that
 * transaction from the start, at any time: the product does when an append
 * of its handle is in flight, after a row of the handle lost, or after the
 * body threw, and no property may depend on that rule.
 *
 * A run of the body may end at a `tx.read` whose value has to load, once in
 * all (`FORMAL_UPDATE_MISSES`), before the row or inside the transaction.
 * That run appends nothing and keeps nothing it read: after the load, an
 * await, the update loads its keys again and the body runs again.
 * Properties, in every state:
 * - UpdateExact: the body of each update row that has its ops read the
 *   state just before that row's seq;
 * - PrefixExact: a tab's memtable is the state after its `appliedThrough`;
 * - AckedInLog: an update that resolved wrote a row that has its ops;
 * - ReadYourWrites: a put or an update resolves with its tab's memtable at
 *   or past its seq;
 * - a body runs to its end at most twice, and every update resolves.
 * The state of the key is named by the seq that last wrote it, so two
 * states never look alike.
 *
 * Broken variants (the writer lands its row whatever its seq, a reader
 * applies a row whatever its header, the header takes `appliedThrough` after
 * an await, a recovery drops the records and keeps the head, the body reads
 * the load whatever landed since, a row that lands past a gap waits for no
 * catch-up, a body that waited for a load goes on with what it had read)
 * must each fail.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPDATES = Number(process.env.FORMAL_UPDATE_UPDATES ?? 2);
const PUTS = Number(process.env.FORMAL_UPDATE_PUTS ?? 1);
const MISSES = Number(process.env.FORMAL_UPDATE_MISSES ?? 1);
const TABS = ["A", "B"] as const;

type Variant = {
  readonly writerIgnoresVerdict?: boolean;
  readonly readerIgnoresHeader?: boolean;
  readonly stampAfterAwait?: boolean;
  readonly dropKeepsHead?: boolean;
  readonly warmIgnoresLanded?: boolean;
  readonly landNoCatchUp?: boolean;
  readonly resumeAfterLoad?: boolean;
};

/** `validAt` 0: no header. `basedOn`: the state the body read, `BLIND` for a put, which reads nothing. */
type Row = { readonly validAt: number; readonly basedOn: number };
const BLIND = -1;

/** What a `warm` loaded: the state at `appliedThrough` `at`. */
type Warm = { readonly at: number; readonly state: number };

type Update =
  | { at: "idle" }
  /** The warm read is in flight: the body has not run. */
  | { at: "warm"; warm: Warm }
  /** A run of the body ended at a read that has to load, and the load is in flight. `basedOn` only with `resumeAfterLoad`. */
  | { at: "loading"; basedOn?: number }
  /** Only with `stampAfterAwait`: the body ran, the header is not written yet. */
  | { at: "read"; basedOn: number }
  | { at: "queued"; row: Row }
  | { at: "committed"; seq: number; validAt: number }
  /** `warm` is undefined until the transaction's own load. */
  | { at: "transaction"; warm?: Warm }
  | { at: "written"; seq: number };

type Tab = {
  applied: number;
  /** What the memtable reads: the seq that last wrote the key, 0 when none did. */
  state: number;
  /** A put in flight: queued in a group, or committed at this seq and not landed. */
  put: "idle" | "queued" | number;
  update: Update;
  runs: number;
  updatesLeft: number;
  putsLeft: number;
};

type State = {
  /** `truth[s]`: the state of the database after seq `s`. Its last index is the head. */
  truth: number[];
  /** `rows[s]`: the record at seq `s`, null once recovery dropped it or took the seq. */
  rows: (Row | null)[];
  /** Tabs at or past this seq read the records. One below it loads the manifest recovery recorded. */
  droppedAt: number;
  dropsLeft: number;
  /** Runs of a body that may still end at a read that has to load. */
  missesLeft: number;
  /** A property a step broke: UpdateExact at a commit, AckedInLog and ReadYourWrites when a write resolves. */
  fault?: string;
  tabs: Tab[];
};

/** A state no write names: the database after a recovery that kept the head. */
const DROPPED = -2;

/** Mirrors `rowValid` in idb/wal.ts: the one verdict on a row, from its bytes and its key. */
function rowValid(validAt: number, seq: number): boolean {
  return validAt === 0 || validAt === seq;
}

function initial(recoveries: number): State {
  const tab = (): Tab => ({ applied: 0, state: 0, put: "idle", update: { at: "idle" }, runs: 0, updatesLeft: UPDATES, putsLeft: PUTS });
  return { truth: [0], rows: [null], droppedAt: 0, dropsLeft: recoveries, missesLeft: MISSES, tabs: [tab(), tab()] };
}

/** How a message names a state. */
const named = (state: number | undefined): string => (state === DROPPED ? "the state recovery left" : `state ${state}`);

const head = (s: State): number => s.truth.length - 1;

/** A commit of one record: the key generator gives it the seq past the head. */
function commit(s: State, row: Row): number {
  const seq = head(s) + 1;
  const before = s.truth[seq - 1]!;
  const live = rowValid(row.validAt, seq);
  if (live && row.basedOn !== BLIND && row.basedOn !== before) {
    s.fault ??= `UpdateExact: the update row at seq ${seq} has its ops, and its body read ${named(row.basedOn)} where the database was at ${named(before)}`;
  }
  s.rows.push(row);
  s.truth.push(live ? seq : before);
  return seq;
}

/** An update resolves with the row it wrote at `seq`. */
function ack(s: State, seq: number): void {
  const row = s.rows[seq];
  // A row recovery dropped is a lost write, which the design allows. A row that has no ops is not.
  if (row && !rowValid(row.validAt, seq)) s.fault ??= `AckedInLog: an update resolved at seq ${seq}, and its row has no ops`;
}

/** A reader applies the next seq: a BroadcastChannel row, or one record of a tail read. */
function follow(s: State, tab: Tab, v: Variant): void {
  if (tab.applied < s.droppedAt) {
    tab.applied = s.droppedAt;
    tab.state = s.truth[s.droppedAt]!;
    return;
  }
  const seq = tab.applied + 1;
  if (v.readerIgnoresHeader || rowValid(s.rows[seq]!.validAt, seq)) tab.state = seq;
  tab.applied = seq;
}

/** What the body reads: the load when nothing landed since it, as `plan` checks `warmed`. */
function values(tab: Tab, warm: Warm, v: Variant): number {
  return v.warmIgnoresLanded || warm.at === tab.applied ? warm.state : tab.state;
}

function catchUp(s: State, tab: Tab, v: Variant): void {
  while (tab.applied < head(s)) follow(s, tab, v);
}

/** `landed`: the writer's own row joins its memtable, with its ops or with none. */
function land(s: State, tab: Tab, seq: number, live: boolean, v: Variant): void {
  if (tab.applied + 1 === seq) {
    if (live) tab.state = seq;
    tab.applied = seq;
  } else if (tab.applied < seq && live && !v.landNoCatchUp) {
    catchUp(s, tab, v);
  }
}

/** A write resolves: its tab reads it from then on. */
function resolved(s: State, who: string, tab: Tab, seq: number): void {
  if (tab.applied < seq) s.fault ??= `ReadYourWrites: ${who}'s write resolved at seq ${seq} with its memtable at seq ${tab.applied}`;
}

type Action =
  | {
      readonly tab: number;
      readonly type: "hear" | "put" | "putCommits" | "putLands" | "update" | "updateAlone" | "plan" | "miss" | "loaded" | "loadedAlone" | "resume" | "stamp" | "rowCommits" | "rowLands" | "warmTx" | "transaction" | "missTx" | "written";
    }
  | { readonly tab: -1; readonly type: "drop" };

function enabled(s: State): Action[] {
  const out: Action[] = [];
  s.tabs.forEach((tab, i) => {
    if (tab.applied < head(s)) out.push({ tab: i, type: "hear" });
    if (tab.put === "idle" && tab.putsLeft > 0) out.push({ tab: i, type: "put" });
    if (tab.put === "queued") out.push({ tab: i, type: "putCommits" });
    if (typeof tab.put === "number") out.push({ tab: i, type: "putLands" });
    const u = tab.update;
    const at = u.at;
    if (at === "idle" && tab.updatesLeft > 0) {
      // With an append of its own in flight, a tab's memtable lacks that row: only the transaction.
      if (tab.put === "idle") out.push({ tab: i, type: "update" });
      out.push({ tab: i, type: "updateAlone" });
    }
    if (at === "warm") out.push({ tab: i, type: "plan" });
    if (at === "warm" && s.missesLeft > 0) out.push({ tab: i, type: "miss" });
    if (u.at === "loading") {
      if (u.basedOn !== undefined) out.push({ tab: i, type: "resume" });
      else {
        // As at the call: with an append of its own in flight, only the transaction.
        if (tab.put === "idle") out.push({ tab: i, type: "loaded" });
        out.push({ tab: i, type: "loadedAlone" });
      }
    }
    if (at === "read") out.push({ tab: i, type: "stamp" });
    if (at === "queued") out.push({ tab: i, type: "rowCommits" });
    if (at === "committed") out.push({ tab: i, type: "rowLands" });
    if (u.at === "transaction") out.push({ tab: i, type: u.warm ? "transaction" : "warmTx" });
    if (u.at === "transaction" && u.warm && s.missesLeft > 0) out.push({ tab: i, type: "missTx" });
    if (at === "written") out.push({ tab: i, type: "written" });
  });
  if (s.dropsLeft > 0 && head(s) > 0) out.push({ tab: -1, type: "drop" });
  return out;
}

/** Applies `a` to `s` in place and says what happened, in product words. */
function step(s: State, a: Action, v: Variant): string {
  if (a.type === "drop") {
    s.dropsLeft--;
    for (let seq = 1; seq <= head(s); seq++) s.rows[seq] = null;
    if (v.dropKeepsHead) {
      s.truth[head(s)] = DROPPED;
      s.droppedAt = head(s);
      return `recovery drops the WAL records and keeps the head at ${head(s)}`;
    }
    s.rows.push(null);
    s.truth.push(head(s) + 1);
    s.droppedAt = head(s);
    return `recovery drops the WAL records and moves the head to ${head(s)}`;
  }
  const tab = s.tabs[a.tab]!;
  const who = `tab ${TABS[a.tab]}`;
  const u = tab.update;
  switch (a.type) {
    case "hear":
      follow(s, tab, v);
      return `${who} applies through seq ${tab.applied}`;
    case "put":
      tab.put = "queued";
      tab.putsLeft--;
      return `${who} calls put`;
    case "putCommits":
      tab.put = commit(s, { validAt: 0, basedOn: BLIND });
      return `${who}: the put commits at seq ${tab.put}`;
    case "putLands":
      land(s, tab, tab.put as number, true, v);
      resolved(s, who, tab, tab.put as number);
      tab.put = "idle";
      return `${who}: the put lands`;
    case "updateAlone":
      tab.updatesLeft--;
      tab.runs = 0;
      tab.update = { at: "transaction" };
      return `${who} calls update, which appends no row first: it waits for a transaction`;
    case "update":
      tab.updatesLeft--;
      tab.runs = 1;
      tab.update = { at: "warm", warm: { at: tab.applied, state: tab.state } };
      return `${who} calls update: warm loads ${named(tab.state)} at seq ${tab.applied}`;
    case "plan": {
      if (u.at !== "warm") throw new Error("model: plan");
      const basedOn = values(tab, u.warm, v);
      if (v.stampAfterAwait) {
        tab.update = { at: "read", basedOn };
        return `${who}: body reads ${named(basedOn)}`;
      }
      tab.update = { at: "queued", row: { validAt: tab.applied + 1, basedOn } };
      return `${who}: body reads ${named(basedOn)}, the row is valid at seq ${tab.applied + 1}`;
    }
    case "miss": {
      if (u.at !== "warm") throw new Error("model: miss");
      s.missesLeft--;
      tab.runs = 0;
      const basedOn = values(tab, u.warm, v);
      tab.update = v.resumeAfterLoad ? { at: "loading", basedOn } : { at: "loading" };
      return `${who}: body reads ${named(basedOn)} and ends at a read that has to load: no row`;
    }
    case "loaded":
      tab.runs = 1;
      tab.update = { at: "warm", warm: { at: tab.applied, state: tab.state } };
      return `${who}: the load is done, warm loads ${named(tab.state)} at seq ${tab.applied}`;
    case "loadedAlone":
      tab.update = { at: "transaction" };
      return `${who}: the load is done, the update waits for a transaction`;
    case "resume":
      if (u.at !== "loading" || u.basedOn === undefined) throw new Error("model: resume");
      tab.runs = 1;
      tab.update = { at: "queued", row: { validAt: tab.applied + 1, basedOn: u.basedOn } };
      return `${who}: the load is done, body goes on with ${named(u.basedOn)}, the row is valid at seq ${tab.applied + 1}`;
    case "stamp":
      if (u.at !== "read") throw new Error("model: stamp");
      tab.update = { at: "queued", row: { validAt: tab.applied + 1, basedOn: u.basedOn } };
      return `${who}: after an await, the row is valid at seq ${tab.applied + 1}`;
    case "rowCommits": {
      if (u.at !== "queued") throw new Error("model: rowCommits");
      const seq = commit(s, u.row);
      tab.update = { at: "committed", seq, validAt: u.row.validAt };
      return `${who}: the update row commits at seq ${seq}`;
    }
    case "rowLands": {
      if (u.at !== "committed") throw new Error("model: rowLands");
      const live = v.writerIgnoresVerdict || rowValid(u.validAt, u.seq);
      land(s, tab, u.seq, live, v);
      if (!live) {
        tab.update = { at: "transaction" };
        return `${who}: the row lands with no ops, the update waits for a transaction`;
      }
      ack(s, u.seq);
      resolved(s, who, tab, u.seq);
      tab.update = { at: "idle" };
      return `${who}: the row lands with its ops, the update resolves`;
    }
    case "warmTx":
      tab.update = { at: "transaction", warm: { at: tab.applied, state: tab.state } };
      return `${who}: warm loads ${named(tab.state)} at seq ${tab.applied} for the transaction`;
    case "transaction": {
      if (u.at !== "transaction" || !u.warm) throw new Error("model: transaction");
      catchUp(s, tab, v);
      tab.runs++;
      const basedOn = values(tab, u.warm, v);
      const seq = commit(s, { validAt: 0, basedOn });
      tab.update = { at: "written", seq };
      return `${who}: a transaction reads the tail, body reads ${named(basedOn)}, the row commits at seq ${seq}`;
    }
    case "missTx":
      if (u.at !== "transaction" || !u.warm) throw new Error("model: missTx");
      s.missesLeft--;
      catchUp(s, tab, v);
      tab.update = { at: "transaction" };
      return `${who}: a transaction reads the tail, body ends at a read that has to load: no row`;
    case "written":
      if (u.at !== "written") throw new Error("model: written");
      land(s, tab, u.seq, true, v);
      ack(s, u.seq);
      resolved(s, who, tab, u.seq);
      tab.update = { at: "idle" };
      return `${who}: the row lands, the update resolves`;
  }
}

function violation(s: State, enabledCount: number): string | undefined {
  if (s.fault) return s.fault;
  for (const [i, tab] of s.tabs.entries()) {
    if (tab.state !== s.truth[tab.applied]) {
      return `PrefixExact: tab ${TABS[i]} reads ${named(tab.state)} at seq ${tab.applied}, where the database was at ${named(s.truth[tab.applied])}`;
    }
    if (tab.runs > 2) return `tab ${TABS[i]} ran the body of one update ${tab.runs} times`;
    if (enabledCount === 0 && tab.update.at !== "idle") return `tab ${TABS[i]}: an update never resolves`;
  }
  return undefined;
}

/**
 * What the future of `s` depends on, so two histories that differ only in
 * what every tab has applied are one state. Seqs count from the lowest
 * `appliedThrough`. A state at or below it is named by the order it is met
 * in: only whether two states are equal matters. A row above it is a bit:
 * did it change the state. The tabs run the same code, so the two orders of
 * a pair are one state too.
 */
function shape(s: State): string {
  const [a, b] = [shapeOf(s, s.tabs), shapeOf(s, s.tabs.toReversed())];
  return a < b ? a : b;
}

function shapeOf(s: State, order: readonly Tab[]): string {
  const base = Math.min(...order.map((tab) => tab.applied));
  const old = new Map<number, number>();
  const id = (state: number) => {
    if (state > base) return state - base;
    if (!old.has(state)) old.set(state, -old.size);
    return old.get(state)!;
  };
  const seq = (n: number) => Math.max(n - base, 0);
  /** A header that names a seq at or below the head never holds: the row takes a later one. */
  const validAt = (n: number) => (n === 0 ? 0 : n > head(s) ? n - base : -1);
  const from = id(s.truth[base]!);
  const window: number[] = [];
  for (let at = base + 1; at <= head(s); at++) window.push(s.truth[at] === s.truth[at - 1] ? 0 : 1);
  const tabs = order.map((tab) => {
    const u = tab.update;
    // `appliedThrough` only grows, so a load that something landed after stays stale.
    const warm = (w: Warm | undefined) => (w ? [w.at === tab.applied, id(w.state)] : []);
    const update =
      u.at === "warm" || u.at === "transaction"
        ? [u.at, ...warm(u.warm)]
        : u.at === "read" || (u.at === "loading" && u.basedOn !== undefined)
          ? [u.at, id(u.basedOn)]
          : u.at === "queued"
            ? [u.at, validAt(u.row.validAt), id(u.row.basedOn)]
            : u.at === "committed"
              ? [u.at, seq(u.seq), rowValid(u.validAt, u.seq)]
              : u.at === "written"
                ? [u.at, seq(u.seq)]
                : [u.at];
    return [seq(tab.applied), id(tab.state), typeof tab.put === "number" ? seq(tab.put) : tab.put, update, tab.runs, tab.updatesLeft, tab.putsLeft];
  });
  return JSON.stringify([from, window, seq(s.droppedAt), s.dropsLeft, s.missesLeft, s.fault ? 1 : 0, tabs]);
}

function copy(s: State): State {
  return { ...s, truth: s.truth.slice(), rows: s.rows.slice(), tabs: s.tabs.map((tab) => ({ ...tab })) };
}

let states = 0;

/** Breadth first over every interleaving. The shortest path to a violation, or undefined. */
function explore(v: Variant, recoveries: number): string | undefined {
  type Node = { state: State | undefined; readonly prev: number; readonly action: Action | undefined };
  const nodes: Node[] = [{ state: initial(recoveries), prev: -1, action: undefined }];
  const seen = new Set<string>([shape(nodes[0]!.state!)]);
  for (let i = 0; i < nodes.length; i++) {
    const state = nodes[i]!.state!;
    nodes[i]!.state = undefined;
    const actions = enabled(state);
    const found = violation(state, actions.length);
    if (found) {
      const path: Action[] = [];
      for (let j = i; j > 0; j = nodes[j]!.prev) path.push(nodes[j]!.action!);
      const replayed = initial(recoveries);
      const steps = path.reverse().map((a, n) => `  ${n + 1}. ${step(replayed, a, v)}`);
      return [found, "shortest path:", ...steps].join("\n");
    }
    for (const action of actions) {
      const next = copy(state);
      step(next, action, v);
      const key = shape(next);
      if (seen.has(key)) continue;
      seen.add(key);
      nodes.push({ state: next, prev: i, action });
    }
  }
  states = seen.size;
  return undefined;
}

/** The product still makes the decisions the model encodes. */
function sourceSync(): string[] {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  const read = (f: string) => fs.readFileSync(path.join(src, f), "utf8");
  const out: string[] = [];
  const need = (file: string, re: RegExp, what: string) => {
    if (!re.test(read(file))) out.push(`${file}: ${what}`);
  };
  const count = (file: string, re: RegExp, n: number, what: string) => {
    const found = read(file).match(re)?.length ?? 0;
    if (found !== n) out.push(`${file}: ${what} (found ${found}, the model knows ${n})`);
  };
  need("idb/wal.ts", /export function rowValid\(validAt: Seq \| undefined, seq: Seq\): boolean \{\s*return validAt === undefined \|\| validAt === seq;\s*\}/, "a row with a header has its ops at the seq the header names, and at no other");
  need("idb/wal.ts", /if \(bytes\[0\] === ROW_VALID_AT\) \{\s*at = 1;\s*validAt = seqOf\("valid at"\);\s*\}/, "decodeOps reads the header from the first byte of the row only");
  need("idb/wal.ts", /throw new CommitError\(`corrupt wal op \$\{type\}`\);\s*\}\s*\}\s*return rowValid\(validAt, seq\) \? ops : \[\];/, "decodeOps parses the whole row, then gives its ops by rowValid");
  count("idb/wal.ts", /decodeOps\(/g, 3, "the tail read and the flush read decode a row with decodeOps");
  count("db.ts", /decodeOps\(/g, 1, "a BroadcastChannel row is decoded with decodeOps");
  need("db.ts", /const seq = await this\.wal\.append\(record\);\s*await this\.landed\(seq, rowValid\(validAt, seq\) \? ops : \[\], record\);/, "the writer lands its row with the ops rowValid gives it");
  need(
    "db.ts",
    /for \(;;\) \{\s*await warm\(\);\s*this\.ensureOpen\(\);\s*(?:\/\/[^\n]*\n\s*)*next = nextSeq\(this\.mem\.appliedThrough\);\s*if \(this\.appending \|\| this\.beaten\) break;\s*let planned: ReturnType<typeof plan> \| undefined;\s*try \{\s*planned = plan\(\);\s*\} catch \{\s*(?:\/\/[^\n]*\n\s*)*\}\s*if \(planned instanceof Miss\) \{\s*(?:\/\/[^\n]*\n\s*)*await planned\.ready\.catch\(\(\) => undefined\);\s*continue;\s*\}\s*if \(planned\?\.ops\.length\) \{\s*if \(rowValid\(next, await this\.commit\(planned\.ops, next\)\)\) return planned\.result;\s*this\.beaten = true;\s*\}\s*break;\s*\}\s*const out = await this\.write\(plan, warm\);/,
    "update takes appliedThrough + 1, reads and runs body with no await in between, appends no row with an append of its handle in flight, loads again and plans again after a plan that waits for a load, resolves only when rowValid holds, and runs the transaction otherwise, a body that threw included",
  );
  need(
    "db.ts",
    /const at = this\.mem\.appliedThrough;\s*const values = await this\.settleInstalled\(read\(wanted\), held\);\s*(?:\/\/[^\n]*\n\s*)*values\.length = ks\.length;\s*warmed = \[at, values\];/,
    "warm names its load by the appliedThrough of the turn it starts reading in, and keeps no value of a key tx.read asked for",
  );
  need("db.ts", /const now = \(keys: readonly CheckedKey\[\]\) => held\.attempt\(\(\) => read\(keys\)\(this\.installed\.levels\)\);/, "a read that cannot wait reads the memtable of the turn it is called in");
  need("db.ts", /const values = warmed\?\.\[0\] === this\.mem\.appliedThrough \? warmed\[1\] : now\(ks\);/, "the body reads the warm load only when nothing landed since it, else the memtable now");
  need(
    "db.ts",
    /\(keys\) => \{\s*if \(!miss\) \{\s*const more = keys\.map\(checkKey\);\s*wanted = wanted\.concat\(more\);\s*const got = now\(more\);\s*if \(!\(got instanceof Miss\)\) return got;\s*miss = got;\s*\}\s*throw miss;\s*\}/,
    "tx.read reads the memtable in the turn body runs in, and ends the run when a value has to load",
  );
  need("db.ts", /\} catch \(err\) \{\s*if \(!miss\) throw err;\s*\}\s*return miss \? held\.keep\(miss\) : \{ ops: ops!, result \};/, "a run of body that ended at tx.read gives no ops, whatever body did after");
  need(
    "db.ts",
    /\.appendAfter\(this\.mem\.appliedThrough, \(tail\) => \{\s*missing = this\.catchUp\(tail\);\s*if \(missing !== undefined\) return undefined;\s*const planned = plan\(\);\s*if \(!\(planned instanceof Miss\)\) return planned;\s*miss = planned;\s*return undefined;\s*\}\)/,
    "the transaction catches the memtable up to the tail before the body reads, and appends nothing for a plan that waits for a load",
  );
  need("db.ts", /const turn = this\.updating\.then\(\(\) => this\.updateOnce\(ks, body\)\);\s*this\.updating = turn\.catch\(\(\) => undefined\);/, "the updates of one handle run one at a time");
  need("db.ts", /=== "gap" && ops\.length && !this\.closed\) await this\.sync\(\);/, "a row that lands with no ops waits for no catch-up");
  need("idb/wal.ts", /const nextHead = follows \? head : asSeq\(Math\.max\(past, nextSeq\(head\)\)\);/, "an adopt that drops the records moves the head by at least one");
  return out;
}

const drift = sourceSync();
if (drift.length > 0) {
  console.error("FAIL source sync: the model no longer matches the product");
  for (const d of drift) console.error(`  ${d}`);
  process.exit(1);
}

/** Each with the recoveries it needs: all but the recovery one must fail on two tabs alone. */
const broken: [string, Variant, number][] = [
  ["the writer lands its row with its ops whatever seq it took", { writerIgnoresVerdict: true }, 0],
  ["a reader applies a row with a header whatever its seq", { readerIgnoresHeader: true }, 0],
  ["the header takes appliedThrough after an await", { stampAfterAwait: true }, 0],
  ["a recovery that drops the WAL records keeps the head", { dropKeepsHead: true }, 1],
  ["the body reads the warm load whatever landed since", { warmIgnoresLanded: true }, 0],
  ["a row that lands past a gap waits for no catch-up", { landNoCatchUp: true }, 0],
  ["a body that waited for a load goes on with what it had read", { resumeAfterLoad: true }, 0],
];
for (const [name, v, recoveries] of broken) {
  if (!explore(v, recoveries)) {
    console.error(`FAIL model too weak: the broken variant "${name}" passes`);
    process.exit(1);
  }
  console.log(`  broken variant caught: ${name}`);
}

const found = explore({}, 1);
if (found) {
  console.error("FAIL UpdateExact");
  console.error(found);
  console.error("\nHarm: an update wrote from a state another write had replaced, a tab reads a state no log prefix gives, or a tab does not read a write of its own that resolved.");
  process.exit(1);
}
console.log(`PASS UpdateExact — ${states} states: two tabs, up to ${UPDATES} updates and ${PUTS} puts each, ${MISSES} read that has to load, one recovery`);
