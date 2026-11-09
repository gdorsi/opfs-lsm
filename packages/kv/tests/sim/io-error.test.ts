import { describe, expect, it } from "vitest";
import { compareBytes } from "../../src/bytes.js";
import { EngineHost, type Db } from "../../src/index.js";
import { checkDatabase } from "./check-database.js";
import type { SiteKind } from "./fault-fs.js";
import { committedLog, Traced } from "./crash.js";
import { show, type Oracle, type OracleEntry } from "./oracle.js";

/**
 * I/O-error sweep (docs/research/corruption-hardening-test-suite.md,
 * technique 3, "Error injection"; SQLite's I/O-error loop). A fixed
 * workload runs with fault site N failing, for N = 1, 2, … until a run
 * reaches no site N, once with a one-shot fault and once with a persistent
 * one. Sites are every OPFS call (create, write, close, remove, read, open,
 * list) and every call on a tab's log segment (create, write, flush).
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
 * A write that rejects may still have committed (its frame is in the log,
 * and a later step failed): the log, not the caller, says.
 *
 *   KV_IO_SITES=read pnpm exec vitest run tests/sim/io-error.test.ts   (only read sites)
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);

type Step =
  | { readonly kind: "write"; readonly ops: readonly { readonly key: string; readonly value?: string }[] }
  | { readonly kind: "update"; readonly key: string; readonly value: string }
  | { readonly kind: "get"; readonly key: string }
  | { readonly kind: "range" }
  | { readonly kind: "view"; readonly keys: readonly string[] }
  | { readonly kind: "sync" | "ingest" | "reopen" };

const w = (...ops: { key: string; value?: string }[]): Step => ({ kind: "write", ops });
const p = (key: string, value: string) => ({ key, value });
const d = (key: string) => ({ key });
const ingest: Step = { kind: "ingest" };

/** Writes, reads, a view, an update, five flushes (one compaction with reclaim), a reopen. */
const WORKLOAD: Step[] = [
  w(p("a", "a1")), w(p("b", "b1"), p("c", "c1")), ingest,
  { kind: "get", key: "a" }, w(d("a"), p("d", "d1")), ingest,
  { kind: "update", key: "b", value: "b2" }, { kind: "range" }, ingest,
  w(p("a", "a2")), { kind: "view", keys: ["a", "b", "d"] }, ingest,
  { kind: "reopen" }, w(d("c"), p("e", "e1")), { kind: "sync" }, ingest,
  { kind: "get", key: "c" }, { kind: "range" },
];

const HANG_MS = 3_000;


function guard<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hang: ${what} did not settle in ${HANG_MS} ms`)), HANG_MS);
  });
  return Promise.race([p, hang]).finally(() => clearTimeout(timer));
}

const durableOnly = new Set<SiteKind>(["fs-write", "log-write"]);
const readOnly = new Set<SiteKind>(["fs-read"]);

type Read =
  | { readonly kind: "get"; readonly key: Uint8Array; readonly value: Uint8Array | undefined }
  | { readonly kind: "range"; readonly entries: readonly OracleEntry[] };

/** What one call did, for the checks after the run. */
type Event = {
  readonly step: string;
  /** The value that marks a write, unique, so it maps to its seq. */
  readonly marker?: string;
  readonly reads?: readonly Read[];
  readonly acked: boolean;
  readonly error?: unknown;
  /** How many records the logs held at the call and at its return. */
  readonly headBefore: number;
  readonly headAfter: number;
  /** Floor before the call: sync and open are barriers. */
  readonly barrier?: boolean;
};

let runs = 0;

async function run(kinds: ReadonlySet<SiteKind>, failAt: number | undefined, persistent: boolean) {
  const t = new Traced(`io-${++runs}`);
  t.faults.kinds = kinds;
  t.faults.failAt = failAt;
  t.faults.persistent = persistent;
  const events: Event[] = [];
  const head = () => committedHead(t);
  let db: Db | undefined;
  const call = async (step: string, body: () => Promise<Omit<Event, "step" | "acked" | "headBefore" | "headAfter">>, marker?: string) => {
    const headBefore = head();
    try {
      const out = await guard(body(), step);
      events.push({ step, acked: true, ...out, headBefore, headAfter: head(), ...(marker ? { marker } : {}) });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("hang:")) throw err;
      events.push({ step, acked: false, error: err, headBefore, headAfter: head(), ...(marker ? { marker } : {}) });
    }
  };
  const open = () =>
    call("open", async () => {
      db = await t.open();
      return { barrier: true };
    });
  const consoleError = console.error;
  console.error = () => undefined; // the host logs failed background work
  try {
    await open();
    for (const step of WORKLOAD) {
      if (!db) {
        await open();
        if (!db) continue;
      }
      const h = db;
      switch (step.kind) {
        case "write": {
          const marker = step.ops.find((o) => o.value)?.value;
          await call(`write ${step.ops.map((o) => (o.value ? `${o.key}=${o.value}` : `del ${o.key}`)).join(" ")}`, async () => {
            await h.batch((tx) => {
              for (const o of step.ops) {
                if (o.value) tx.put(utf(o.key), utf(o.value));
                else tx.delete(utf(o.key));
              }
            });
            return {};
          }, marker);
          break;
        }
        case "update":
          await call(`update ${step.key}=${step.value}`, async () => {
            let seen: Uint8Array | undefined;
            await h.update([utf(step.key)], ([v], tx) => {
              seen = v && new Uint8Array(v);
              tx.put(utf(step.key), utf(step.value));
            });
            return { reads: [{ kind: "get", key: utf(step.key), value: seen }] };
          }, step.value);
          break;
        case "get":
          await call(`get ${step.key}`, async () => {
            const v = await h.get(utf(step.key));
            return { reads: [{ kind: "get", key: utf(step.key), value: v && new Uint8Array(v) }] };
          });
          break;
        case "range":
          await call("range", async () => {
            const entries: OracleEntry[] = [];
            for await (const e of h.range()) entries.push({ key: new Uint8Array(e.key), value: new Uint8Array(e.value) });
            return { reads: [{ kind: "range", entries }] };
          });
          break;
        case "view":
          await call(`view ${step.keys.join(",")}`, () =>
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
          await call("sync", async () => {
            await h.sync();
            return { barrier: true };
          });
          break;
        case "ingest":
          await call("ingest", async () => {
            await h.ingest();
            return {};
          });
          break;
        case "reopen":
          await call("close", async () => {
            await h.close();
            return {};
          });
          db = undefined;
          await open();
          break;
      }
    }
    const reached = t.faults.sites.length;
    const injected = t.faults.injected;

    // Heal, then the same host recovers, and the database reopens whole.
    t.faults.heal();
    if (db) await guard(db.close(), "close after heal").catch(() => undefined);
    await guard(t.host.ingest(t.name, Number.POSITIVE_INFINITY, true), "host flush after heal");
    const log = committedLog(t.faults.ops);
    checkEvents(events, log);
    const again = await guard(t.open(), "open after heal");
    const all: OracleEntry[] = [];
    for await (const e of again.range()) all.push({ key: new Uint8Array(e.key), value: new Uint8Array(e.value) });
    await again.close();
    expectState(all, log.stateAt(), "range after heal (the whole committed log)");
    const report = await checkDatabase(t.fs, t.name);
    expect(report.problems, "checkDatabase after heal").toEqual([]);
    expectState(report.state, log.stateAt(), "files after heal");
    await new EngineHost(() => t.fs).ingest(t.name, 0, true);
    const swept = await checkDatabase(t.fs, t.name);
    expect(swept.orphans, "orphans after a fresh host's sweep").toEqual([]);
    expect(swept.staleManifests, "stale manifests after a fresh host's sweep").toEqual([]);
    return { reached, injected, events };
  } finally {
    console.error = consoleError;
    await t.dispose();
  }
}

/** How many records the logs hold so far. One tab writes at a time, so they are the first ones of the order. */
function committedHead(t: Traced): number {
  return committedLog(t.faults.ops).head;
}

/** Acked writes are committed; resolved reads are log prefixes in their window. */
function checkEvents(events: readonly Event[], log: Oracle): void {
  const seqOf = (marker: string) => {
    for (let s = 1; s <= log.head; s++) {
      const state = log.stateAt(s);
      const before = log.stateAt(s - 1);
      if (state.some((e) => dec.decode(e.value) === marker) && !before.some((e) => dec.decode(e.value) === marker)) return s;
    }
    return undefined;
  };
  let floor = 0;
  for (const e of events) {
    const where = () => `${e.step}${e.error ? ` (${(e.error as Error).name})` : ""}\n${events.map(fmtEvent).join("\n")}`;
    if (e.barrier && e.acked) floor = Math.max(floor, e.headBefore);
    if (e.acked && e.marker !== undefined) {
      const seq = seqOf(e.marker);
      if (seq === undefined) throw new Error(`acked write is not in the committed log: ${where()}`);
      floor = Math.max(floor, seq);
    }
    if (!e.acked || !e.reads) continue;
    // An update reads the state before its own seq.
    const hi = e.marker !== undefined ? Math.max(0, (seqOf(e.marker) ?? 1) - 1) : e.headAfter;
    const lo = e.marker !== undefined ? hi : floor;
    let set: number[] | undefined;
    for (const r of e.reads) {
      const next = r.kind === "get" ? log.getCandidates(r.key, r.value, lo) : log.rangeCandidates({}, r.entries, lo);
      set = (set ? set.filter((x) => next.includes(x)) : next).filter((x) => x <= hi);
      if (set.length === 0) {
        throw new Error(`read is not a log prefix in [${lo}, ${hi}]: ${fmtRead(r)}: ${where()}`);
      }
    }
    if (e.marker === undefined) floor = Math.max(floor, set![0]!);
  }
}

function fmtRead(r: Read): string {
  return r.kind === "get" ? `get ${show(r.key)} = ${r.value ? show(r.value) : "undefined"}` : `range = ${fmt(r.entries)}`;
}

function fmtEvent(e: Event): string {
  return `  ${e.acked ? "ok " : "ERR"} ${e.step}${e.error ? ` ${(e.error as Error).name}: ${(e.error as Error).message}` : ""} [head ${e.headBefore}->${e.headAfter}]`;
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
async function sweep(kinds: ReadonlySet<SiteKind>, persistent: boolean) {
  const names = new Map<string, number>();
  let n = 1;
  for (; ; n++) {
    let out: Awaited<ReturnType<typeof run>>;
    try {
      out = await run(kinds, n, persistent);
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
      await db.ingest().catch(() => undefined);
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

describe("I/O errors at every fault site", () => {
  it("the workload passes with no fault", async () => {
    const out = await run(new Set<SiteKind>(["fs-read", "fs-write", "log-write"]), undefined, false);
    expect(out.events.filter((e) => !e.acked).map(fmtEvent)).toEqual([]);
    expect(out.reached).toBeGreaterThan(20);
  });

  for (const [label, kinds] of [
    ["durable", durableOnly],
    ["read", readOnly],
  ] as const) {
    for (const persistent of [false, true]) {
      it.skipIf(ONLY !== undefined && ONLY !== label)(
        `${label} sites, ${persistent ? "persistent" : "one-shot"}: errors reject, and the database reopens whole`,
        async () => {
          const { runs, names } = await sweep(kinds, persistent);
          if (process.env.KV_IO_REPORT) console.log(label, persistent, runs, [...names]);
          expect(runs).toBeGreaterThan(5);
          // Injected faults surface as the injected error or a commit error, never as corruption.
          expect([...names].filter(([n]) => n === "CorruptDatabaseError")).toEqual([]);
        },
        120_000,
      );
    }
  }
});

