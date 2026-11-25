import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareBytes } from "../../src/bytes.js";
import type { Db } from "../../src/index.js";
import { createLocalIngestClient, EngineHost, ingest, openHarnessDb } from "../../src/testing.js";
import { compactHost } from "../compact-host.js";
import { checkDatabase, deleteWal } from "./check-database.js";
import {
  checkCrashState,
  committedLog,
  describeCut,
  destroyedThrough,
  headAt,
  mulberry32,
  powerCuts,
  processCut,
  readPrefixes,
  runSteps,
  Traced,
  type CrashModel,
  type Cut,
  type Destroyed,
  type Step,
} from "./crash.js";
import { describeOp, FaultFs, Faults, materializeFs, type DurableOp, type SiteKind } from "./fault-fs.js";
import { installFaultWal, materializeWal, traceWal } from "./fault-wal.js";
import { Oracle, type OracleEntry, type OracleOp } from "./oracle.js";

/**
 * An I/O error and a crash in one run, which io-error.test.ts (errors, no
 * crash) and crash-enum.test.ts (crashes, no error) each leave out.
 *
 * - A workload whose durable site N fails once goes on, and every crash
 *   state of its trace recovers: the whole committed log after a process
 *   crash, a log prefix after a power loss.
 * - After a failed IndexedDB commit, a power loss, new writes and a second
 *   power loss, the database still reads a log prefix.
 * - Recovery from a crash state with site N of the open, flush, compaction
 *   or sweep failing, once or from then on: every call settles, an open that
 *   resolves reads a log prefix the crash state allows, and once the error
 *   heals the same host opens a log prefix no shorter than one it already
 *   read, with clean files after a fresh host's pass.
 *
 * Each sweep samples KV_CRASH_PAIRS crash states (default 2) per faulted
 * run, per first power loss, or per workload. KV_CRASH_PAIRS=20 is a long
 * sweep, about 3 minutes.
 */

const STATES = Number(process.env.KV_CRASH_PAIRS ?? 2);
const HANG_MS = 4_000;

let restore: () => void;
beforeAll(() => {
  restore = installFaultWal();
});
afterAll(() => restore());

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const put = (key: string, value: string): Step => ({ put: key, value });
const del = (key: string): Step => ({ del: key });
const flush: Step = { ingest: true };
const reopen: Step = { reopen: true };
const many = (prefix: string, n: number, tag: string): Step => ({
  batch: Array.from({ length: n }, (_, i) => ({ put: `${prefix}/${String(i).padStart(4, "0")}`, value: `${tag}${i}` })),
});

let runs = 0;

function guard<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hang: ${what} did not settle in ${HANG_MS} ms`)), HANG_MS);
  });
  return Promise.race([promise, hang]).finally(() => clearTimeout(timer));
}

/** An error of the check, not of the database: a hang, or a read that is no log prefix (`readPrefixes`). */
const checkFailed = (err: unknown) => err instanceof Error && /^(hang:|range\(\) =|get\()/.test(err.message);

/** Runs `body` with the host's logs of failed background work silenced. */
async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const error = console.error;
  console.error = () => undefined;
  try {
    return await body();
  } finally {
    console.error = error;
  }
}

/** Flushes, idle passes, range deletes and a reopen, so faults reach every durable op the host makes. */
const FAULTED: (Step | { readonly idle: true })[] = [
  put("a", "a1"), put("b", "b1"), flush, { idle: true },
  del("a"), put("c", "c1"), flush, { idle: true },
  { deleteRange: "b", end: "d" }, put("d", "d1"), flush, { idle: true },
  put("e", "e1"), flush, { idle: true },
  reopen,
  put("c", "c2"), { deleteRange: "" }, put("f", "f1"), flush, { idle: true },
  put("g", "g1"), flush, { idle: true },
  put("h", "h1"),
];

/** The trace of `FAULTED` with site `failAt` of `kinds` failing once. Calls that fail are let go. */
async function faultedRun(failAt: number, kinds: ReadonlySet<SiteKind>): Promise<{ ops: DurableOp[]; injected: number; site: string | undefined }> {
  const t = new Traced(`fault-crash-${++runs}`, 64);
  t.faults.kinds = kinds;
  t.faults.failAt = failAt;
  let db: Db | undefined;
  const attempt = (fn: () => Promise<unknown>) => fn().catch(() => undefined);
  try {
    await quietly(async () => {
      for (const step of FAULTED) {
        if (!db) await attempt(async () => (db = await t.open()));
        const h = db;
        if (!h) continue;
        if ("put" in step) await attempt(() => h.put(utf(step.put), utf(step.value)));
        else if ("del" in step) await attempt(() => h.delete(utf(step.del)));
        else if ("deleteRange" in step) {
          await attempt(() => h.batch((tx) => tx.deleteRange(step.end === undefined ? { start: utf(step.deleteRange) } : { start: utf(step.deleteRange), endExclusive: utf(step.end) })));
        } else if ("ingest" in step) await attempt(() => ingest(h));
        // The host's idle pass, which sweeps when it installs nothing.
        else if ("idle" in step) await attempt(() => t.host["db"](t.name).compact());
        else if ("reopen" in step) {
          await attempt(() => h.close());
          db = undefined;
        }
      }
      if (db) await attempt(() => db!.close());
    });
    return { ops: [...t.faults.ops], injected: t.faults.injected, site: t.faults.sites[failAt - 1] };
  } finally {
    await t.dispose();
  }
}

/** Every faulted run of `FAULTED`, one per site of `kinds`, until a run reaches no such site. */
async function* faultedRuns(kinds: ReadonlySet<SiteKind>) {
  for (let n = 1; ; n++) {
    const out = await faultedRun(n, kinds);
    if (out.injected === 0) return;
    yield { n, ...out };
  }
}

/** Two single-op writes and a flush, twice, so a chunk can reuse the path of an earlier one. */
const AFTER_RECOVERY: OracleOp[][] = [
  [{ type: "put", key: utf("c"), value: utf("c9") }],
  [{ type: "put", key: utf("x"), value: utf("x1") }],
  [{ type: "put", key: utf("y"), value: utf("y1") }],
  [],
  [{ type: "put", key: utf("z"), value: utf("z1") }],
  [{ type: "del", key: utf("x") }],
  [],
];

/** From crash state `first` of `before`: recover, write `AFTER_RECOVERY`, and check power-loss pairs of that second run. */
async function secondLoss(before: readonly DurableOp[], first: Cut, random: () => number): Promise<{ states: number; failures: string[] }> {
  const b = new Traced(`fault-crash-${++runs}`, 64);
  let log: Oracle;
  let after: DurableOp[];
  try {
    await b.load(before, first);
    const db = await b.open().catch(() => undefined);
    // A crash state that does not open is the one-loss sweep's to report.
    if (!db) return { states: 0, failures: [] };
    const all: OracleEntry[] = [];
    for await (const e of db.range()) all.push({ key: new Uint8Array(e.key), value: new Uint8Array(e.value) });
    const logA = committedLog(before);
    const read = logA.rangeCandidates({}, all, 0);
    if (read.length === 0) {
      await db.close();
      return { states: 0, failures: [] };
    }
    log = logA.prefix(read.at(-1)!);
    for (const ops of AFTER_RECOVERY) {
      if (ops.length === 0) await ingest(db);
      else {
        await db.batch((tx) => ops.forEach((op) => (op.type === "put" ? tx.put(op.key, op.value) : op.type === "del" && tx.delete(op.key))));
        log.append(ops);
      }
    }
    await db.close();
    after = [...b.faults.ops];
  } finally {
    await b.dispose();
  }
  const idbA = before.filter((op) => op.store === "idb").slice(0, first.idb);
  const opfsA = before.filter((op) => op.store === "opfs").slice(0, first.opfs);
  const ops = [...idbA, ...opfsA, ...after];
  const failures: string[] = [];
  const cuts = powerCuts(after, STATES, random);
  for (const cut of cuts) {
    const second: Cut = { idb: idbA.length + cut.idb, opfs: opfsA.length + cut.opfs };
    await checkCrashState(ops, log, second, "power").catch((err: Error) =>
      failures.push(`first loss keeps idb ${first.idb} opfs ${first.opfs}: ${err.message.split("\n")[0]}\n${describeCut(ops, second)}`),
    );
  }
  return { states: cuts.length, failures };
}

function report(failures: readonly string[]): void {
  if (failures.length > 0) throw new Error(`${failures.length} failures. First:\n${failures.slice(0, 2).join("\n\n")}`);
}

describe("a failed durable op, then a crash", () => {
  it("every crash state of a run that hit one I/O error recovers to the committed log or a prefix", async () => {
    const failures: string[] = [];
    let states = 0;
    for await (const { n, ops, site } of faultedRuns(new Set<SiteKind>(["fs-write", "idb-write"]))) {
      const log = committedLog(ops);
      const random = mulberry32(n);
      const cuts: [Cut, CrashModel][] = [
        [processCut(ops, ops.length), "process"],
        ...Array.from({ length: STATES - 1 }, (): [Cut, CrashModel] => [processCut(ops, Math.floor(random() * ops.length)), "process"]),
        ...powerCuts(ops, STATES, random).map((cut): [Cut, CrashModel] => [cut, "power"]),
      ];
      for (const [cut, model] of cuts) {
        states++;
        await checkCrashState(ops, log, cut, model).catch((err: Error) => failures.push(`site ${n} (${site}): ${err.message}`));
      }
    }
    report(failures);
    expect(states).toBeGreaterThan(100);
  }, 600_000);

  it("a failed IndexedDB commit, a power loss, new writes, and a second power loss leave a log prefix", async () => {
    const failures: string[] = [];
    let states = 0;
    for await (const { n, ops, site } of faultedRuns(new Set<SiteKind>(["idb-write"]))) {
      const random = mulberry32(1000 + n);
      for (let i = 0; i < STATES; i++) {
        // The power goes at a point of the run: OPFS keeps every op up to it, and IndexedDB loses its last one to three commits.
        const at = processCut(ops, 1 + Math.floor(random() * ops.length));
        const lost = Math.min(at.idb, 1 + Math.floor(random() * 3));
        const out = await secondLoss(ops, { idb: at.idb - lost, opfs: at.opfs }, random);
        states += out.states;
        failures.push(...out.failures.map((f) => `commit site ${n} (${site}), ${f}`));
      }
    }
    report(failures);
    expect(states).toBeGreaterThan(50);
  }, 600_000);

  it("a manifest a failed commit left, whose run a sweep removed, is never read after two power losses", async () => {
    const index = (list: readonly DurableOp[], text: string): number => {
      const i = list.map(describeOp).findIndex((d) => d.includes(text));
      if (i < 0) throw new Error(`no op ${text} in\n${list.map(describeOp).join("\n")}`);
      return i;
    };
    const a = new Traced(`fault-crash-${++runs}`);
    a.host = new EngineHost(() => a.fs, { idleFlushMs: 10, idleFlushDueMs: 20 });
    a.faults.kinds = new Set<SiteKind>(["idb-write"]);
    let before: DurableOp[];
    try {
      await quietly(async () => {
        const db = await a.open();
        await db.put(utf("a"), utf("a1"));
        await db.put(utf("b"), utf("b1"));
        await ingest(db);
        await db.put(utf("c"), utf("c-old"));
        await db.batch((tx) => {
          tx.deleteRange({});
          tx.put(utf("m"), utf("m-old"));
        });
        // The flush publishes its run and manifest 2, then its commit fails, and the host goes on.
        a.faults.failAt = a.faults.sites.length + 1;
        await expect(ingest(db)).rejects.toBeInstanceOf(Error);
        a.faults.heal();
        // A second tab opens, and the host's idle pass sweeps against generation 1.
        const other = await a.open();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await other.close();
        await db.close();
      });
      before = [...a.faults.ops];
    } finally {
      await a.dispose();
    }

    // The first power loss takes the appends of seqs 3 and 4 from IndexedDB. OPFS keeps every op.
    const idbA = before.filter((op) => op.store === "idb");
    const opfsA = before.filter((op) => op.store === "opfs");
    const keptIdb = index(idbA, "advanceIngested through 2") + 1;
    const log = new Oracle();
    log.append([{ type: "put", key: utf("a"), value: utf("a1") }]);
    log.append([{ type: "put", key: utf("b"), value: utf("b1") }]);

    const b = new Traced(`fault-crash-${++runs}`);
    let after: DurableOp[];
    try {
      await b.load(before, { idb: keptIdb, opfs: opfsA.length });
      const db = await b.open();
      const m = await db.get(utf("m"));
      if (m && dec.decode(m) === "m-old") {
        log.append([{ type: "put", key: utf("c"), value: utf("c-old") }]);
        log.append([{ type: "deleteRange", start: new Uint8Array(0) }, { type: "put", key: utf("m"), value: utf("m-old") }]);
      }
      expect((await checkDatabase(b.mem, b.name)).problems, "checkDatabase after the first recovery").toEqual([]);
      for (const [k, v] of [["c", "c-new"], ["d", "d-new"]] as const) {
        await db.put(utf(k), utf(v));
        log.append([{ type: "put", key: utf(k), value: utf(v) }]);
      }
      await ingest(db);
      await db.close();
      after = [...b.faults.ops];
    } finally {
      await b.dispose();
    }

    // The second power loss: OPFS keeps the new L0 run and not its manifest, and IndexedDB loses the two new appends.
    const ops = [...idbA.slice(0, keptIdb), ...opfsA, ...after];
    const second: Cut = {
      idb: keptIdb + index(after.filter((op) => op.store === "idb"), "append seq"),
      opfs: opfsA.length + index(after.filter((op) => op.store === "opfs"), "publish l0/") + 1,
    };
    await checkCrashState(ops, log, second, "power");
  });
});

const COMPACTION: Step[] = [
  put("a", "a1"), put("b", "b1"), flush,
  del("a"), put("c", "c1"), flush,
  put("a", "a2"), { batch: [{ put: "d", value: "d1" }, { del: "b" }] }, flush,
  put("e", "e1"), flush,
  put("c", "c2"), del("e"), flush,
  put("f", "f1"),
];

const RANGE_DELETE: Step[] = [
  many("n", 20, "x"), put("a", "a1"), flush,
  { deleteRange: "n/0005", end: "n/0015" }, put("n/0010", "y1"), flush,
  put("m", "m1"), { deleteRange: "m", end: "n" }, put("b", "b1"), flush,
  { deleteRange: "n/" }, put("n/0001", "y2"), flush,
  reopen, put("c", "c1"), flush,
  { deleteRange: "a", end: "c" }, put("g", "g1"),
];

const DESTROY: Step[] = [
  put("a", "a1"), put("b", "b1"), flush,
  put("c", "c1"), flush,
  put("f", "f1"),
  { destroy: true },
  put("a", "a9"), flush,
  put("g", "g1"),
];

/** With 64 bytes per L0 run, a flush writes several runs. */
const CHUNKED: Step[] = [
  put("a", "a1"), put("b", "b1"), put("c", "c1"), put("a", "a2"), del("b"), flush,
  put("d", "d1"), flush,
  reopen, put("e", "e1"), flush,
  put("h", "h1"),
];

const RECOVERED: [string, Step[], number | undefined][] = [
  ["compaction", COMPACTION, undefined],
  ["range delete", RANGE_DELETE, undefined],
  ["destroy", DESTROY, undefined],
  ["chunked flush", CHUNKED, 64],
];

async function trace(steps: readonly Step[], flushRunBytes?: number) {
  const t = new Traced(`fault-crash-${++runs}`, flushRunBytes);
  const log = new Oracle();
  try {
    await runSteps(t, steps, log);
    return { ops: [...t.faults.ops], log, destroys: [...t.destroys] };
  } finally {
    await t.dispose();
  }
}

/** Recover crash state `cut` with site `failAt` failing, then heal and recover again. Returns how many faults it injected. */
async function recoverWithFault(
  ops: readonly DurableOp[],
  oracle: Oracle,
  cut: Cut,
  model: CrashModel,
  destroys: readonly Destroyed[],
  failAt: number,
  persistent: boolean,
): Promise<number> {
  const name = `fault-crash-${++runs}`;
  const faults = new Faults();
  await materializeWal(name, ops, cut.idb);
  const mem = await materializeFs(ops, cut.opfs);
  const fs = new FaultFs(mem, faults);
  const unregister = traceWal(name, faults);
  const head = headAt(ops, cut.idb);
  const hi = model === "process" ? head : oracle.head;
  const host = new EngineHost(() => fs);
  const open = () => openHarnessDb({ name, fs, ingest: createLocalIngestClient(host), maxWalBytes: 1 << 30 });
  const log: string[] = [];
  const fail = (err: unknown): never => {
    throw new Error(`${(err as Error).message}\n${log.join("\n")}`);
  };
  try {
    faults.failAt = failAt;
    faults.persistent = persistent;
    let floor = model === "process" ? head : destroyedThrough(ops, destroys, cut);
    await quietly(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const db = await guard(open(), "faulted open").catch((err: unknown) => {
          if (checkFailed(err)) throw err;
          log.push(`open ${attempt}: ${(err as Error).name}: ${(err as Error).message}`);
        });
        if (db) {
          try {
            const set = await guard(readPrefixes(db, oracle, floor, hi), "faulted read");
            floor = Math.max(floor, set[0]!);
            log.push(`open ${attempt}: read prefixes ${set.join(",")}`);
          } catch (err) {
            if (checkFailed(err)) fail(err);
            log.push(`read ${attempt}: ${(err as Error).name}: ${(err as Error).message}`);
          } finally {
            await guard(db.close(), "faulted close").catch(() => undefined);
          }
        }
        await guard(host.ingest(name, true), "faulted host ingest").then(
          () => log.push(`host ingest ${attempt}: ok`),
          (err: unknown) => {
            if (checkFailed(err)) throw err;
            log.push(`host ingest ${attempt}: ${(err as Error).name}: ${(err as Error).message}`);
          },
        );
      }
    });
    const injected = faults.injected;
    faults.heal();

    const db = await guard(open(), "open after heal").catch((err: unknown) => fail(new Error(`does not open after heal: ${(err as Error).name}: ${(err as Error).message}`)));
    const prefixes = await readPrefixes(db, oracle, floor, hi).catch(fail).finally(() => db.close());
    await guard(host.ingest(name, true), "host ingest after heal");
    await compactHost(new EngineHost(() => mem), name);
    const files = await checkDatabase(mem, name);
    const problems = [...files.problems, ...files.orphans.map((p) => `orphan run ${p}`), ...files.staleManifests.map((p) => `stale manifest ${p}`)];
    if (problems.length > 0) fail(new Error(`checkDatabase after a fresh host's pass: ${problems.join("; ")}`));
    if (!prefixes.some((p) => sameEntries(oracle.stateAt(p), files.state))) {
      fail(new Error(`files after a fresh host's pass are not fold(log[1..p]) for p in ${prefixes.join(",")}`));
    }
    return injected;
  } catch (err) {
    throw new Error(
      `${model} crash state, fault at recovery site ${failAt} (${persistent ? "persistent" : "one-shot"}, ${faults.sites[failAt - 1]}): ${(err as Error).message}\n${describeCut(ops, cut)}`,
    );
  } finally {
    unregister();
    await deleteWal(name);
  }
}

function sameEntries(a: readonly OracleEntry[], b: readonly OracleEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => compareBytes(e.key, b[i]!.key) === 0 && compareBytes(e.value, b[i]!.value) === 0);
}

describe("an I/O error while a crash state recovers", () => {
  for (const [label, steps, flushRunBytes] of RECOVERED) {
    for (const model of ["process", "power"] as const) {
      it(`${label}: ${model} crash states, a fault at every recovery site`, async () => {
        const { ops, log, destroys } = await trace(steps, flushRunBytes);
        const random = mulberry32(model === "process" ? 7 : 11);
        const cuts =
          model === "process"
            ? Array.from({ length: STATES }, () => processCut(ops, Math.floor(random() * (ops.length + 1))))
            : powerCuts(ops, STATES, random);
        const failures: string[] = [];
        let states = 0;
        for (const cut of cuts) {
          for (const persistent of [false, true]) {
            for (let n = 1; ; n++) {
              states++;
              const injected = await recoverWithFault(ops, log, cut, model, destroys, n, persistent).catch((err: Error) => {
                failures.push(err.message);
                return 0;
              });
              if (injected === 0) break;
            }
          }
        }
        report(failures);
        expect(states).toBeGreaterThan(cuts.length * 4);
      }, 600_000);
    }
  }
});
