import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareBytes } from "../../src/bytes.js";
import { type Db } from "../../src/index.js";
import { checkDatabase } from "./check-database.js";
import type { SiteKind } from "./fault-fs.js";
import { installFaultWal } from "./fault-wal.js";
import { committedLog, Traced } from "./crash.js";
import { show, type Oracle, type OracleEntry } from "./oracle.js";
import { createLocalIngestClient, ingest as ingestDb, EngineHost, openHarnessDb } from "../../src/testing.js";
import { compactHost } from "../compact-host.js";

/**
 * I/O-error sweep (docs/research/corruption-hardening-test-suite.md,
 * technique 3, "Error injection"; SQLite's I/O-error loop). A fixed
 * workload runs with fault site N failing, for N = 1, 2, … until a run
 * reaches no site N, once with a one-shot fault and once with a persistent
 * one. Sites are every OPFS call (create, write, close, remove, read, open,
 * list) and every IndexedDB readwrite transaction that writes (aborted
 * before it commits).
 *
 * Every run checks:
 * - no hang: every call settles;
 * - errors are not answers: a call that resolves is right. An acked write
 *   is in the committed log; a read is the fold of a log prefix no older
 *   than this handle's last ack, barrier or read, and no newer than what
 *   had committed;
 * - after the fault is healed, the same host flushes and compacts, the
 *   database reopens holding the whole committed log (nothing crashed, so
 *   nothing committed may be missing), `checkDatabase` passes, and a fresh
 *   host's sweep leaves no orphan.
 *
 * A write that rejects may still have committed (it failed after its
 * commit, while catching up): the log, not the caller, says.
 *
 * Besides the base workload, the sweep runs range deletes (bounded,
 * open-ended, of everything, and with `through`) on a host with small L0
 * runs and an L0 stop, so flushes span several runs and compaction takes
 * its mark step, and a second handle that writes, reads and syncs between
 * the first one's steps. Those also run with every file write refused as a
 * full origin, with a reserve. They run one-shot faults;
 * KV_IO_WIDE=1 adds persistent ones and the range deletes on a host with
 * no L0 stop.
 *
 *   KV_IO_SITES=read pnpm exec vitest run tests/sim/io-error.test.ts   (only read sites)
 */

let restore: () => void;
beforeAll(() => {
  restore = installFaultWal();
});
afterAll(() => restore());

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);

type Op =
  | { readonly key: string; readonly value?: string }
  | { readonly start: string; readonly end?: string; readonly through?: number };

type Who = "a" | "b";

type Step =
  | { readonly kind: "write"; readonly ops: readonly Op[]; readonly on?: "b" }
  | { readonly kind: "update"; readonly key: string; readonly value: string }
  | { readonly kind: "get"; readonly key: string; readonly on?: "b" }
  | { readonly kind: "range"; readonly on?: "b" }
  | { readonly kind: "view"; readonly keys: readonly string[] }
  | { readonly kind: "sync"; readonly on?: "b" }
  | { readonly kind: "ingest" | "reopen" };

const w = (...ops: Op[]): Step => ({ kind: "write", ops });
const wb = (...ops: Op[]): Step => ({ kind: "write", ops, on: "b" });
const p = (key: string, value: string): Op => ({ key, value });
const d = (key: string): Op => ({ key });
const dr = (start: string, end?: string, through?: number): Op => ({
  start,
  ...(end === undefined ? {} : { end }),
  ...(through === undefined ? {} : { through }),
});
const ingest: Step = { kind: "ingest" };
const many = (prefix: string, n: number, tag: string): Op[] =>
  Array.from({ length: n }, (_, i) => p(`${prefix}/${String(i).padStart(2, "0")}`, `${tag}${i}`));

/** Writes, reads, a view, an update, five flushes (one compaction with reclaim), a reopen. */
const WORKLOAD: Step[] = [
  w(p("a", "a1")), w(p("b", "b1"), p("c", "c1")), ingest,
  { kind: "get", key: "a" }, w(d("a"), p("d", "d1")), ingest,
  { kind: "update", key: "b", value: "b2" }, { kind: "range" }, ingest,
  w(p("a", "a2")), { kind: "view", keys: ["a", "b", "d"] }, ingest,
  { kind: "reopen" }, w(d("c"), p("e", "e1")), { kind: "sync" }, ingest,
  { kind: "get", key: "c" }, { kind: "range" },
];

/** Range deletes over flushed and unflushed rows. Every write holds one put of a value no other write uses, so an ack maps to its seq. */
const RANGE: Step[] = [
  w(...many("n", 12, "x")), w(p("a", "a1")), ingest,
  w(dr("n/03", "n/08"), p("r", "r1")), w(p("n/05", "y1")), ingest,
  { kind: "get", key: "n/04" }, { kind: "get", key: "n/05" }, { kind: "range" },
  w(p("m", "m1")), w(dr("m", "n"), p("r", "r2")), w(p("b", "b1")), ingest,
  { kind: "update", key: "a", value: "a2" },
  w(dr("n/"), p("r", "r3")), ingest,
  { kind: "view", keys: ["n/05", "a", "m", "b"] },
  { kind: "reopen" },
  w(p("n/01", "y2"), d("b")), { kind: "sync" }, ingest,
  w(dr("", undefined, 3), p("r", "r4")), { kind: "range" }, ingest,
  w(dr(""), p("r", "r5")), w(p("z", "z1")), ingest,
  { kind: "range" }, { kind: "get", key: "a" }, ingest,
];

/** The same shapes with a second handle that writes, reads and syncs between the first one's steps. */
const TWO: Step[] = [
  w(...many("n", 8, "x")), wb(p("a", "a1")), ingest,
  wb(dr("n/02", "n/06"), p("r", "r1")), w(p("n/03", "y1")), { kind: "get", key: "n/03", on: "b" }, ingest,
  { kind: "sync", on: "b" }, { kind: "range", on: "b" },
  w(p("m", "m1")), wb(dr("m", "n"), p("r", "r2")), ingest,
  { kind: "update", key: "a", value: "a2" }, { kind: "get", key: "a", on: "b" },
  wb(dr(""), p("r", "r3")), w(p("q", "q1")), ingest,
  { kind: "range" }, { kind: "sync", on: "b" }, { kind: "range", on: "b" }, ingest,
];

const HANG_MS = 4_000;

function guard<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hang: ${what} did not settle in ${HANG_MS} ms`)), HANG_MS);
  });
  return Promise.race([p, hang]).finally(() => clearTimeout(timer));
}

const ALL = new Set<SiteKind>(["fs-read", "fs-write", "idb-write"]);
const DURABLE = new Set<SiteKind>(["fs-write", "idb-write"]);
const READ = new Set<SiteKind>(["fs-read"]);
const FS_WRITE = new Set<SiteKind>(["fs-write"]);

type Read =
  | { readonly kind: "get"; readonly key: Uint8Array; readonly value: Uint8Array | undefined }
  | { readonly kind: "range"; readonly entries: readonly OracleEntry[] };

/** What one call did, for the checks after the run. */
type Event = {
  readonly step: string;
  readonly who: Who;
  /** The value that marks a write, unique, so it maps to its seq. */
  readonly marker?: string;
  readonly reads?: readonly Read[];
  readonly acked: boolean;
  readonly error?: unknown;
  /** The WAL head of the committed IndexedDB ops at the call and at its return. */
  readonly headBefore: number;
  readonly headAfter: number;
  /** Floor before the call: sync and open are barriers. */
  readonly barrier?: boolean;
};

type Config = {
  readonly workload: readonly Step[];
  readonly kinds: ReadonlySet<SiteKind>;
  readonly overrides?: ConstructorParameters<typeof EngineHost>[1];
  /** The error a failed file call throws. Default: an injected I/O error. */
  readonly error?: (label: string) => Error;
  readonly reserveBytes?: number;
};

let runs = 0;

async function run(config: Config, failAt: number | undefined, persistent: boolean) {
  const t = new Traced(`io-${++runs}`);
  t.host = new EngineHost(() => t.fs, config.overrides);
  t.faults.kinds = config.kinds;
  t.faults.failAt = failAt;
  t.faults.persistent = persistent;
  t.faults.error = config.error;
  const events: Event[] = [];
  const head = () => committedHead(t);
  const dbs: Partial<Record<Who, Db>> = {};
  const openOne = () =>
    openHarnessDb({
      name: t.name,
      fs: t.fs,
      ingest: createLocalIngestClient(t.host),
      maxWalBytes: 1 << 30,
      ...(config.reserveBytes === undefined ? {} : { reserveBytes: config.reserveBytes }),
    });
  const call = async (who: Who, step: string, body: () => Promise<Omit<Event, "step" | "who" | "acked" | "headBefore" | "headAfter">>, marker?: string) => {
    const headBefore = head();
    try {
      const out = await guard(body(), step);
      events.push({ step, who, acked: true, ...out, headBefore, headAfter: head(), ...(marker ? { marker } : {}) });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("hang:")) throw err;
      events.push({ step, who, acked: false, error: err, headBefore, headAfter: head(), ...(marker ? { marker } : {}) });
    }
  };
  const open = (who: Who) =>
    call(who, "open", async () => {
      dbs[who] = await openOne();
      return { barrier: true };
    });
  const consoleError = console.error;
  const consoleWarn = console.warn;
  console.error = () => undefined; // the host logs failed background work
  console.warn = () => undefined; // and a handle the storage-full offer finds no handler on
  try {
    await open("a");
    if (config.workload.some((s) => "on" in s)) await open("b");
    for (const step of config.workload) {
      const who: Who = "on" in step && step.on === "b" ? "b" : "a";
      if (!dbs[who]) {
        await open(who);
        if (!dbs[who]) continue;
      }
      const h = dbs[who]!;
      switch (step.kind) {
        case "write": {
          const marker = step.ops.find((o): o is { key: string; value: string } => "value" in o && o.value !== undefined)?.value;
          await call(who, `write ${step.ops.map(fmtOp).join(" ")}`, async () => {
            await h.batch((tx) => {
              for (const o of step.ops) {
                if ("start" in o) {
                  tx.deleteRange(
                    o.end === undefined ? { start: utf(o.start) } : { start: utf(o.start), endExclusive: utf(o.end) },
                    o.through === undefined ? {} : { through: o.through },
                  );
                } else if (o.value !== undefined) tx.put(utf(o.key), utf(o.value));
                else tx.delete(utf(o.key));
              }
            });
            return {};
          }, marker);
          break;
        }
        case "update":
          await call(who, `update ${step.key}=${step.value}`, async () => {
            let seen: Uint8Array | undefined;
            await h.update([utf(step.key)], ([v], tx) => {
              seen = v && new Uint8Array(v);
              tx.put(utf(step.key), utf(step.value));
            });
            return { reads: [{ kind: "get", key: utf(step.key), value: seen }] };
          }, step.value);
          break;
        case "get":
          await call(who, `get ${step.key}`, async () => {
            const v = await h.get(utf(step.key));
            return { reads: [{ kind: "get", key: utf(step.key), value: v && new Uint8Array(v) }] };
          });
          break;
        case "range":
          await call(who, "range", async () => {
            const entries: OracleEntry[] = [];
            for await (const e of h.range()) entries.push({ key: new Uint8Array(e.key), value: new Uint8Array(e.value) });
            return { reads: [{ kind: "range", entries }] };
          });
          break;
        case "view":
          await call(who, `view ${step.keys.join(",")}`, () =>
            h.view(async (snap) => {
              const reads: Read[] = [];
              for (const k of step.keys) {
                const v = await snap.get(utf(k));
                reads.push({ kind: "get", key: utf(k), value: v && new Uint8Array(v) });
              }
              return { reads };
            }),
          );
          break;
        case "sync":
          await call(who, "sync", async () => {
            await h.sync();
            return { barrier: true };
          });
          break;
        case "ingest":
          await call(who, "ingest", async () => {
            await ingestDb(h);
            return {};
          });
          break;
        case "reopen":
          await call(who, "close", async () => {
            await h.close();
            return {};
          });
          delete dbs[who];
          await open(who);
          break;
      }
    }
    const reached = t.faults.sites.length;
    const injected = t.faults.injected;

    // Heal, then the same host recovers, and the database reopens whole.
    t.faults.heal();
    for (const db of Object.values(dbs)) await guard(db.close(), "close after heal").catch(() => undefined);
    await guard(t.host.ingest(t.name, true), "host flush after heal");
    const log = committedLog(t.faults.ops);
    checkEvents(events, log);
    const again = await guard(t.open(), "open after heal");
    const all: OracleEntry[] = [];
    for await (const e of again.range()) all.push({ key: new Uint8Array(e.key), value: new Uint8Array(e.value) });
    for (const key of log.keys()) {
      const [got, want] = [await again.get(key), log.valueAt(key)];
      if ((got && show(got)) !== (want && show(want))) throw new Error(`get(${show(key)}) after heal = ${got && show(got)}, want ${want && show(want)}`);
    }
    await again.close();
    expectState(all, log.stateAt(), "range after heal (the whole committed log)");
    const report = await checkDatabase(t.fs, t.name);
    expect(report.problems, "checkDatabase after heal").toEqual([]);
    expectState(report.state, log.stateAt(), "files after heal");
    await compactHost(new EngineHost(() => t.fs, config.overrides), t.name);
    const swept = await checkDatabase(t.fs, t.name);
    expect(swept.problems, "checkDatabase after a fresh host's pass").toEqual([]);
    expectState(swept.state, log.stateAt(), "files after a fresh host's pass");
    expect(swept.orphans, "orphans after a fresh host's sweep").toEqual([]);
    expect(swept.staleManifests, "stale manifests after a fresh host's sweep").toEqual([]);
    return { reached, injected, events };
  } catch (err) {
    throw new Error(`${(err as Error).message}\n${events.map(fmtEvent).join("\n")}`);
  } finally {
    console.error = consoleError;
    console.warn = consoleWarn;
    await t.dispose();
  }
}

/** The WAL head the committed IndexedDB ops recorded so far. */
function committedHead(t: Traced): number {
  let head = 0;
  for (const op of t.faults.ops) {
    if (op.store !== "idb") continue;
    for (const m of op.muts) {
      if (m.kind !== "put") continue;
      if (m.store === "wal") head = Math.max(head, m.key as number);
      if (m.store === "meta" && m.key === "ingestedThrough") head = Math.max(head, m.value as number);
    }
  }
  return head;
}

/** Acked writes are committed; resolved reads are log prefixes in their window, each handle's own. */
function checkEvents(events: readonly Event[], log: Oracle): void {
  const seqOf = (marker: string) => {
    for (let s = 1; s <= log.head; s++) {
      const state = log.stateAt(s);
      const before = log.stateAt(s - 1);
      if (state.some((e) => dec.decode(e.value) === marker) && !before.some((e) => dec.decode(e.value) === marker)) return s;
    }
    return undefined;
  };
  const floors: Record<Who, number> = { a: 0, b: 0 };
  for (const e of events) {
    const where = () => `${e.who}: ${e.step}${e.error ? ` (${(e.error as Error).name})` : ""}`;
    if (e.barrier && e.acked) floors[e.who] = Math.max(floors[e.who], e.headBefore);
    if (e.acked && e.marker !== undefined) {
      const seq = seqOf(e.marker);
      if (seq === undefined) throw new Error(`acked write is not in the committed log: ${where()}`);
      floors[e.who] = Math.max(floors[e.who], seq);
    }
    if (!e.acked || !e.reads) continue;
    // An update reads the state before its own seq.
    const hi = e.marker !== undefined ? Math.max(0, (seqOf(e.marker) ?? 1) - 1) : e.headAfter;
    const lo = e.marker !== undefined ? hi : floors[e.who];
    let set: number[] | undefined;
    for (const r of e.reads) {
      const next = r.kind === "get" ? log.getCandidates(r.key, r.value, lo) : log.rangeCandidates({}, r.entries, lo);
      set = (set ? set.filter((x) => next.includes(x)) : next).filter((x) => x <= hi);
      if (set.length === 0) {
        throw new Error(`read is not a log prefix in [${lo}, ${hi}]: ${fmtRead(r)}: ${where()}`);
      }
    }
    if (e.marker === undefined) floors[e.who] = Math.max(floors[e.who], set![0]!);
  }
}

function fmtOp(o: Op): string {
  if ("start" in o) return `delRange[${o.start},${o.end ?? ""})${o.through === undefined ? "" : `@${o.through}`}`;
  return o.value !== undefined ? `${o.key}=${o.value}` : `del ${o.key}`;
}

function fmtRead(r: Read): string {
  return r.kind === "get" ? `get ${show(r.key)} = ${r.value ? show(r.value) : "undefined"}` : `range = ${fmt(r.entries)}`;
}

function fmtEvent(e: Event): string {
  return `  ${e.acked ? "ok " : "ERR"} ${e.who} ${e.step}${e.error ? ` ${(e.error as Error).name}: ${(e.error as Error).message}` : ""} [head ${e.headBefore}->${e.headAfter}]`;
}

function fmt(entries: readonly OracleEntry[]): string {
  return `[${entries.map((e) => `${show(e.key)}=${show(e.value)}`).join(", ")}]`;
}

function expectState(got: readonly OracleEntry[], want: readonly OracleEntry[], label: string): void {
  const same =
    got.length === want.length &&
    got.every((e, i) => compareBytes(e.key, want[i]!.key) === 0 && compareBytes(e.value, want[i]!.value) === 0);
  if (!same) throw new Error(`${label}: got ${fmt(got)}, want ${fmt(want)}`);
}

/** Sweep N = 1.. until a run reaches no site N. Returns how many runs and the error names seen. */
async function sweep(config: Config, persistent: boolean) {
  const names = new Map<string, number>();
  let n = 1;
  for (; ; n++) {
    let out: Awaited<ReturnType<typeof run>>;
    try {
      out = await run(config, n, persistent);
    } catch (err) {
      throw new Error(`fault at site ${n} (${persistent ? "persistent" : "one-shot"}): ${(err as Error).message}`);
    }
    for (const e of out.events) {
      if (e.error) {
        const name = (e.error as Error).name;
        names.set(name, (names.get(name) ?? 0) + 1);
      }
    }
    if (out.injected === 0) break;
  }
  return { runs: n, names };
}

const ONLY = process.env.KV_IO_SITES;
const WIDE = !!process.env.KV_IO_WIDE;

describe("I/O errors: found by this suite", () => {
  // Found by the read sweep with manifest reads included, one-shot, site 7. After
  // the first flush, the host's first compaction pass sweeps: it keeps the
  // runs of every manifest from the recorded generation on (`liveRuns`), and
  // removes every other run file. `liveRuns` read each manifest with
  // `loadGeneration(…).catch(() => undefined)`, so a failed read of manifest
  // 1 counted as a manifest with no runs, and the sweep deleted l0/1-2.sst,
  // the only copy of seqs 1..2 (the WAL records are already truncated). The
  // database no longer opened: GENERATION_GONE. `liveRuns` now rethrows,
  // so the sweep is skipped until the read succeeds.
  it("a failed manifest read during reclaim never deletes a live run", async () => {
    const t = new Traced(`io-${++runs}`);
    t.faults.spare = (label) => !label.startsWith("read m/");
    t.faults.failAt = 1;
    try {
      const db = await t.open();
      await db.put(utf("a"), utf("a1"));
      await ingestDb(db).catch(() => undefined);
      await db.close();
      expect(t.faults.injected, "the fault fired").toBe(1);
      t.faults.heal();
      const again = await t.open();
      expect(dec.decode((await again.get(utf("a")))!)).toBe("a1");
      await again.close();
    } finally {
      await t.dispose();
    }
  });
});

/** Several L0 runs per flush, so four flushes compact and a range delete over L1 needs a mark step. */
const SMALL_RUNS = { flushRunBytes: 96 };
/** The L0 stop at two runs, with a merge of at most three sources. */
const L0_STOP = { flushRunBytes: 96, l0StopRuns: 2, maxSources: 3 };

const quota = (label: string): Error => new DOMException(`injected quota at ${label}`, "QuotaExceededError");

type Sweep = { readonly label: string; readonly config: Config; readonly persistent: boolean; readonly sites: "durable" | "read" };

const SWEEPS: Sweep[] = [];
for (const persistent of [false, true]) {
  for (const [sites, kinds] of [["durable", DURABLE], ["read", READ]] as const) {
    SWEEPS.push({ label: `${sites} sites`, config: { workload: WORKLOAD, kinds }, persistent, sites });
  }
  if (persistent && !WIDE) continue;
  for (const [label, workload, overrides] of [
    ["range deletes, L0 stop", RANGE, L0_STOP],
    ["two handles, small runs", TWO, SMALL_RUNS],
    ...(WIDE ? [["range deletes, small runs", RANGE, SMALL_RUNS] as const] : []),
  ] as const) {
    SWEEPS.push({ label: `${label}: durable sites`, config: { workload, overrides, kinds: DURABLE }, persistent, sites: "durable" });
    SWEEPS.push({ label: `${label}: read sites`, config: { workload, overrides, kinds: READ }, persistent, sites: "read" });
    SWEEPS.push({
      label: `${label}: storage full at each file write, with a reserve`,
      config: { workload, overrides, kinds: FS_WRITE, error: quota, reserveBytes: 4096 },
      persistent,
      sites: "durable",
    });
  }
}

describe("I/O errors at every fault site", () => {
  for (const [label, workload, overrides] of [
    ["the base workload", WORKLOAD, undefined],
    ["range deletes, L0 stop", RANGE, L0_STOP],
    ["two handles, small runs", TWO, SMALL_RUNS],
  ] as const) {
    it(`${label} passes with no fault`, async () => {
      const out = await run({ workload, kinds: ALL, ...(overrides ? { overrides } : {}) }, undefined, false);
      expect(out.events.filter((e) => !e.acked).map(fmtEvent)).toEqual([]);
      expect(out.reached).toBeGreaterThan(20);
    });
  }

  for (const { label, config, persistent, sites } of SWEEPS) {
    it.skipIf(ONLY !== undefined && ONLY !== sites)(
      `${label}, ${persistent ? "persistent" : "one-shot"}: errors reject, and the database reopens whole`,
      async () => {
        const { runs, names } = await sweep(config, persistent);
        if (process.env.KV_IO_REPORT) console.log(label, persistent, runs, [...names]);
        expect(runs).toBeGreaterThan(5);
        // Injected faults surface as the injected error, a commit error or a full origin, never as corruption.
        expect([...names].filter(([n]) => n === "CorruptDatabaseError")).toEqual([]);
      },
      600_000,
    );
  }
});
