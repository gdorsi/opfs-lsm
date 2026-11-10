import { afterAll, describe, expect, it } from "vitest";
import { CommitError, CorruptDatabaseError } from "../../src/errors.js";
import { MemoryFs, type Db } from "../../src/index.js";
import { encodeRun, ensureEngine, mergeSsts } from "../../src/store/engine.js";
import { decodeGeneration, encodeGeneration, manifestNumbers } from "../../src/store/generation.js";
import { Host, openHarnessDb } from "../../src/testing.js";
import { checkDatabase } from "./check-database.js";

/**
 * End-to-end corruption (docs/research/corruption-hardening-test-suite.md,
 * techniques 7 and 10). One database file is corrupted: a run of L0, L1 or
 * L2 (LZ4), the newest manifest, an older one, or a closed tab's log
 * segment. Then a fresh tab and host open it and get, scan, write, ingest,
 * compact and reopen. Each step is recorded as one outcome, and the rules
 * are checked:
 *
 * - No step hangs, and none fails with anything but an `OpfsLsmError`.
 * - Where a CRC is checked (manifests everywhere, runs in the SharedWorker's
 *   compaction), the corruption never becomes a wrong answer or lost data:
 *   a step fails with `CorruptDatabaseError`, or answers right.
 * - Where none is (a tab's run reads), a wrong answer is allowed.
 * - Log records carry a CRC, and the SharedWorker stops a log at the first
 *   one that fails (its cursor becomes `damaged`). The records past it are
 *   lost, and the host logs it; the table records what the steps then read.
 *
 * `KV_CORRUPT_REPORT=1` prints the table that docs/verification.md quotes.
 */

const utf = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);
const STEP_MS = 5_000;
const STEPS = ["open", "get", "range", "contains", "write", "flush", "compact", "reopen"] as const;
const HEALTHY = Object.fromEntries(STEPS.map((s) => [s, "ok"]));
let dbs = 0;

/** "ok", "wrong" (an answer that differs from the log), "corrupt", "commit", "HANG", or "THREW <error>". */
type Outcome = string;
type Report = Record<string, Outcome>;
const table: [string, Report][] = [];

afterAll(() => {
  if (!process.env.KV_CORRUPT_REPORT) return;
  const rows = table.map(([name, r]) => `| ${name.replace(": ", " | ")} | ${STEPS.map((s) => r[s] ?? "").join(" | ")} |`);
  console.log([`| File | Corruption | ${STEPS.join(" | ")} |`, `|---|---|${STEPS.map(() => "---|").join("")}`, ...rows].join("\n"));
});

/** A host that ingests only when a page asks. */
const quietHost = (fs: MemoryFs) => new Host(() => fs, { maxLatencyMs: 1e9 });

/** The database every case starts from, and what it must read. */
type Fixture = {
  readonly name: string;
  readonly fs: MemoryFs;
  /** Live keys and their values, as the log says. */
  readonly state: Map<string, string>;
};

/**
 * Five ingests: four L0 runs compact into one L1 run, then one more L0 run,
 * and two records left in the closed tab's log. Values are unique per write.
 */
async function standard(): Promise<Fixture> {
  const name = `corrupt-${++dbs}`;
  const fs = new MemoryFs();
  const state = new Map<string, string>();
  const db = await openHarnessDb({ name, fs, host: quietHost(fs) });
  for (let round = 0; round < 6; round++) {
    await db.batch((tx) => {
      for (let i = round; i < 40; i += 2) {
        const k = `k${String(i).padStart(2, "0")}`;
        const v = `v${round}.${i} ${i % 3 === 0 ? "hot" : "cold"}`;
        tx.put(utf(k), utf(v));
        state.set(k, v);
      }
      const gone = `k${String(round * 5).padStart(2, "0")}`;
      tx.delete(utf(gone));
      state.delete(gone);
    });
    if (round < 5) await db.ingest();
  }
  await db.put(utf("tail"), utf("in the log"));
  state.set("tail", "in the log");
  await db.close();
  return { name, fs, state };
}

/** One LZ4 run in L2, as compaction writes deep runs, listed by the only manifest. */
async function deep(): Promise<Fixture> {
  await ensureEngine();
  const name = `corrupt-${++dbs}`;
  const fs = new MemoryFs();
  const state = new Map<string, string>();
  const entries = Array.from({ length: 300 }, (_, i) => {
    const k = `d${String(i).padStart(3, "0")}`;
    const v = `{"n":${i},"tag":"${i % 3 === 0 ? "hot" : "cold"}"}`;
    state.set(k, v);
    return { kind: "put" as const, key: utf(k), value: utf(v), seq: i + 1 };
  });
  const { body, end } = await encodeRun(entries, "lz4");
  const path = "l2/c1.0.sst";
  await put(fs, path, body);
  await put(fs, "m/0000000000000001.mft", encodeGeneration({ generation: 1, runs: [{ path, ...end }], tombstoneSeq: 0, through: 300, queues: [] }));
  return { name, fs, state };
}

async function put(fs: MemoryFs, path: string, body: Uint8Array): Promise<void> {
  const w = await fs.create(path);
  await w.write(body);
  await w.finish();
}

async function files(fs: MemoryFs, dir: string): Promise<string[]> {
  return (await fs.list(dir)).map((n) => `${dir}/${n}`).sort();
}

/** Replace `path` with `change(bytes)`. */
async function corruptFile(fs: MemoryFs, path: string, change: (b: Uint8Array) => Uint8Array): Promise<void> {
  const before = (await fs.read(path, 0, Number.POSITIVE_INFINITY))!;
  await put(fs, path, change(before.slice()));
}

const flipAt = (at: (len: number) => number, bit = 0x10) => (b: Uint8Array) => {
  b[at(b.byteLength)]! ^= bit;
  return b;
};

/** The newest manifest's runs of one level: older run files can wait on disk for the next reclaim pass. */
const listed = async (f: Fixture, level: string) => (await checkDatabase(f.fs)).runs.filter((p) => p.startsWith(`${level}/`));
const l0 = async (f: Fixture) => (await listed(f, "l0"))[0]!;
const l1 = async (f: Fixture) => (await listed(f, "l1"))[0]!;
const l2 = async (f: Fixture) => (await listed(f, "l2"))[0]!;
const manifestPath = (n: number) => `m/${String(n).padStart(16, "0")}.mft`;
const newest = async (f: Fixture) => (await manifestNumbers(f.fs))[0]!;
const newestPath = async (f: Fixture) => manifestPath(await newest(f));
const segments = async (f: Fixture) => {
  const [log] = await f.fs.list("w");
  return (await files(f.fs, `w/${log}`)).filter((p) => p.endsWith(".seg"));
};

async function step(r: Report, name: string, fn: () => Promise<Outcome>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve("HANG"), STEP_MS);
  });
  const named = (err: unknown): Outcome =>
    err instanceof CorruptDatabaseError
      ? "corrupt"
      : err instanceof CommitError
        ? "commit"
        : `THREW ${err instanceof Error ? `${err.name}: ${err.message}` : `${typeof err} ${String(err)}`}`.slice(0, 100);
  try {
    r[name] = await Promise.race([fn().catch(named), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Open, read, write, flush, compact and reopen, recording each step. */
async function exercise(f: Fixture): Promise<Report> {
  const r: Report = {};
  const host = quietHost(f.fs);
  const open = () => openHarnessDb({ name: f.name, fs: f.fs, host });
  const want = (k: string) => f.state.get(k);
  const keys = [...f.state.keys()].sort();
  let db: Db | undefined;
  await step(r, "open", async () => {
    db = await open();
    return "ok";
  });
  if (!db) return r;
  await step(r, "get", async () => {
    let wrong = 0;
    for (const k of [...keys, "k05", "zz"]) if (str(await db!.get(utf(k))) !== want(k)) wrong++;
    return wrong ? "wrong" : "ok";
  });
  await step(r, "range", async () => {
    const got: string[] = [];
    for await (const e of db!.range()) got.push(`${str(e.key)}=${str(e.value)}`);
    return got.join() === keys.map((k) => `${k}=${want(k)}`).join() ? "ok" : "wrong";
  });
  await step(r, "contains", async () => {
    const got: string[] = [];
    for await (const e of db!.range({ valueContains: [utf("hot")] })) got.push(str(e.key)!);
    return got.join() === keys.filter((k) => want(k)!.includes("hot")).join() ? "ok" : "wrong";
  });
  await step(r, "write", async () => {
    await db!.put(utf("new"), utf("new value"));
    f.state.set("new", "new value");
    return "ok";
  });
  await step(r, "flush", async () => {
    await db!.ingest();
    return str(await db!.get(utf("new"))) === "new value" ? "ok" : "wrong";
  });
  // Four more flushes: enough to compact every L0 run, and L1 with them.
  await step(r, "compact", async () => {
    for (let i = 0; i < 4; i++) {
      await db!.put(utf(`c${i}`), utf(`c${i}`));
      f.state.set(`c${i}`, `c${i}`);
      await db!.ingest();
    }
    return "ok";
  });
  await step(r, "reopen", async () => {
    await db!.close();
    db = await open();
    let wrong = 0;
    for (const k of [...f.state.keys(), "k05"]) if (str(await db.get(utf(k))) !== want(k)) wrong++;
    return wrong ? "wrong" : "ok";
  });
  await db?.close().catch(() => undefined);
  return r;
}

async function run(label: string, make: () => Promise<Fixture>, corrupt: (f: Fixture) => Promise<void>): Promise<Report> {
  const f = await make();
  await corrupt(f);
  const r = await exercise(f);
  table.push([label, r]);
  return r;
}

/** Steps that hung or threw a stray error: every step must fail as documented or answer. */
function crashes(r: Report): string[] {
  return Object.entries(r)
    .filter(([, o]) => o === "HANG" || o.startsWith("THREW"))
    .map(([s, o]) => `${s}: ${o}`);
}

/** Steps that answered wrong. A CRC-checked file must fail as corrupt or answer right. */
function wrongAnswers(r: Report): string[] {
  return Object.entries(r)
    .filter(([, o]) => o === "wrong")
    .map(([s]) => s);
}

/** Compaction refused the corrupt run. */
const refused = (o: Outcome | undefined) => o === "corrupt";

describe("a healthy database", () => {
  it("passes every step (the harness is right)", async () => {
    expect(await run("none: healthy", standard, async () => undefined)).toEqual(HEALTHY);
    expect(await run("none: healthy, one L2 LZ4 run", deep, async () => undefined)).toEqual(HEALTHY);
  });

  it("the standard fixture has L0 and L1 runs, a log tail, and checks clean", async () => {
    const f = await standard();
    expect(await listed(f, "l0")).toHaveLength(1);
    expect(await listed(f, "l1")).toHaveLength(1);
    const report = await checkDatabase(f.fs);
    expect(report.problems).toEqual([]);
    expect(report.pending).toBe(2);
  });
});

describe("a corrupt run: tabs check no CRC, compaction does", () => {
  it("L0, a flipped data byte: compaction refuses the run", async () => {
    const r = await run("L0 run: data byte flipped", standard, async (f) => corruptFile(f.fs, await l0(f), flipAt(() => 12)));
    expect(crashes(r)).toEqual([]);
    // Compaction decodes with the CRC: the corrupt run never becomes a new run.
    expect(refused(r.compact)).toBe(true);
  });

  it("L1, a flipped data byte", async () => {
    const r = await run("L1 run: data byte flipped", standard, async (f) => corruptFile(f.fs, await l1(f), flipAt(() => 40)));
    expect(crashes(r)).toEqual([]);
    expect(refused(r.compact)).toBe(true);
  });

  it("L0, the footer's magic flipped: every read of it fails as corrupt", async () => {
    const r = await run("L0 run: magic flipped", standard, async (f) => corruptFile(f.fs, await l0(f), flipAt((n) => n - 2)));
    expect(crashes(r)).toEqual([]);
    expect(wrongAnswers(r)).toEqual([]);
  });

  it("L0, truncated by half", async () => {
    const r = await run("L0 run: truncated", standard, async (f) => corruptFile(f.fs, await l0(f), (b) => b.slice(0, b.byteLength >> 1)));
    expect(crashes(r)).toEqual([]);
    expect(wrongAnswers(r)).toEqual([]);
  });

  it("L0, the index offset field inflated", async () => {
    const r = await run("L0 run: footer index offset inflated", standard, async (f) =>
      corruptFile(f.fs, await l0(f), (b) => {
        new DataView(b.buffer).setUint32(b.byteLength - 44 + 20, 0x7fffffff, true);
        return b;
      }),
    );
    expect(crashes(r)).toEqual([]);
    expect(wrongAnswers(r)).toEqual([]);
  });

  // KT2 (fuzz/findings.test.ts): one flipped bit in the high byte of the
  // footer's block count made a tab allocate 2^24 x 8 bytes before it read
  // the index. `readFooter` now refuses a count the index cannot hold.
  it("L0, the footer's block count high byte flipped", async () => {
    const r = await run("L0 run: block count bit 24 flipped", standard, async (f) => corruptFile(f.fs, await l0(f), flipAt((n) => n - 44 + 7, 0x01)));
    expect(crashes(r)).toEqual([]);
    expect(wrongAnswers(r)).toEqual([]);
  });

  it("L2 (LZ4), a flipped byte in a compressed block: the unpack fails as corrupt", async () => {
    const r = await run("L2 LZ4 run: data byte flipped", deep, async (f) => corruptFile(f.fs, await l2(f), flipAt(() => 200)));
    expect(crashes(r)).toEqual([]);
    expect(r.get).toBe("corrupt");
  });

  // KW2: with wasm, compaction's decode threw the Rust error as a bare
  // string ("CrcMismatch") out of `db.ingest()`, not CorruptDatabaseError.
  it("KW2: compaction over a corrupt run fails with CorruptDatabaseError", async () => {
    const r = await run("L0 run: data byte flipped (KW2)", standard, async (f) => corruptFile(f.fs, await l0(f), flipAt(() => 12)));
    expect(r.compact).toBe("corrupt");
  });
});

describe("a corrupt manifest: CRC-checked everywhere", () => {
  it("an older manifest that fails its CRC is never read: recovery stops at the newest intact one", async () => {
    const r = await run("manifest: an older one, byte flipped", standard, async (f) => {
      const older = (await manifestNumbers(f.fs))[1]!;
      await corruptFile(f.fs, manifestPath(older), flipAt(() => 20, 1));
    });
    expect(r).toEqual(HEALTHY);
  });

  it("the newest manifest, a flipped byte: open fails as corrupt", async () => {
    const r = await run("manifest: newest, byte flipped", standard, async (f) => corruptFile(f.fs, await newestPath(f), flipAt(() => 50)));
    expect(crashes(r)).toEqual([]);
    expect(r.open).toBe("corrupt");
  });

  it("the newest manifest truncated: open fails as corrupt", async () => {
    const r = await run("manifest: newest, truncated", standard, async (f) => corruptFile(f.fs, await newestPath(f), (b) => b.slice(0, 30)));
    expect(crashes(r)).toEqual([]);
    expect(r.open).toBe("corrupt");
  });
});

/**
 * Recovery (`newestIntact` and `recoverQueues`, src/recover.ts) tells a
 * power loss from corruption. A power loss cannot tear a manifest (OPFS
 * publishes a file whole), so a manifest on disk that fails its CRC is
 * corruption, and every open and ingest refuses with CorruptDatabaseError
 * and writes nothing. A manifest that lists a run that is gone is what a
 * power loss leaves of a publish: recovery takes an older manifest, and
 * the logs still hold what it lacks (RECLAIM_LAG), or `checkCover` refuses.
 * Before these rules, either case could become silent, permanent loss.
 */
describe("recovery never turns corruption into data loss", () => {
  /** How many keys a reopened database still reads right. */
  async function survivors(f: Fixture): Promise<number> {
    const db = await openHarnessDb({ name: f.name, fs: f.fs, host: quietHost(f.fs) });
    let n = 0;
    for (const [k, v] of f.state) if (str(await db.get(utf(k))) === v) n++;
    await db.close();
    return n;
  }

  /**
   * Every file and its bytes: what a refusal must leave as it was. A page
   * that fails to open still started its own log, so only the logs of
   * `logs` count.
   */
  async function snapshot(f: Fixture, logs: readonly string[]) {
    const out: Record<string, number[]> = {};
    const dirs = ["m", "l0", "l1", "l2", ...logs.map((log) => `w/${log}`)];
    for (const dir of dirs) {
      for (const p of await files(f.fs, dir)) out[p] = [...(await f.fs.read(p, 0, Number.POSITIVE_INFINITY))!];
    }
    return out;
  }

  it("a run of the newest manifest removed: an older manifest and the logs stand in, and nothing is lost", async () => {
    const f = await standard();
    await f.fs.remove(await l0(f));
    expect(await survivors(f)).toBe(f.state.size);
    expect(await run("L0 run: removed, an older manifest stands in", async () => f, async () => undefined)).toEqual(HEALTHY);
  });

  it("a run every kept manifest lists removed: open refuses or reads everything, and a refusal deletes nothing", async () => {
    const f = await standard();
    await f.fs.remove(await l1(f));
    const logs = await f.fs.list("w");
    const before = await snapshot(f, logs);
    const opened = await survivors(f).catch((err: unknown) => err);
    if (opened instanceof CorruptDatabaseError) expect(await snapshot(f, logs)).toEqual(before);
    else expect(opened).toBe(f.state.size);
  });

  it("a merged run that stands in for the newest manifest's runs: nothing is lost", async () => {
    // A compaction's power-loss shape with the old manifest kept: the
    // newest manifest lost a run, and a newer one with the same `through`
    // and cursors lists one run that merges all of its runs.
    const f = await standard();
    const gen = await newest(f);
    const old = decodeGeneration((await f.fs.read(manifestPath(gen), 0, Number.POSITIVE_INFINITY))!);
    const bodies = await Promise.all(old.runs.map(async (r) => (await f.fs.read(r.path, 0, Number.POSITIVE_INFINITY))!));
    const merged = (await mergeSsts(bodies, true)).runs[0]!;
    const path = `l1/c${gen + 1}.0.sst`;
    await put(f.fs, path, merged.body);
    await put(f.fs, manifestPath(gen + 1), encodeGeneration({ ...old, generation: gen + 1, runs: [{ path, ...merged.end }] }));
    await f.fs.remove(await l0(f));
    expect(await survivors(f)).toBe(f.state.size);
    expect(await run("L0 run: removed, a merged manifest stands in", async () => f, async () => undefined)).toEqual(HEALTHY);
  });

  it("a newest manifest that fails its CRC is never replaced, and nothing is deleted", async () => {
    const f = await standard();
    await corruptFile(f.fs, await newestPath(f), flipAt(() => 50));
    const logs = await f.fs.list("w");
    const before = await snapshot(f, logs);
    await expect(survivors(f)).rejects.toBeInstanceOf(CorruptDatabaseError);
    expect(await snapshot(f, logs)).toEqual(before);
  });

  it("an empty newest manifest is a power loss: the newest intact one stands in", async () => {
    // OPFS can leave a file created and never closed. Not corruption.
    const f = await standard();
    await put(f.fs, await newestPath(f), new Uint8Array(0));
    const r = await exercise(f);
    expect(crashes(r)).toEqual([]);
    expect(wrongAnswers(r)).toEqual([]);
  });
});

describe("a corrupt log segment: records carry a CRC", () => {
  it("a byte of the tail record flipped: the log stops there, and no step crashes", async () => {
    const r = await run("log segment: last record byte flipped", standard, async (f) => {
      const seg = (await segments(f)).at(-1)!;
      await corruptFile(f.fs, seg, flipAt((n) => n - 3));
    });
    expect(crashes(r)).toEqual([]);
  });

  it("truncated inside the tail record: a torn tail, and no step crashes", async () => {
    const r = await run("log segment: truncated mid-record", standard, async (f) => {
      const seg = (await segments(f)).at(-1)!;
      await corruptFile(f.fs, seg, (b) => b.slice(0, b.byteLength - 3));
    });
    expect(crashes(r)).toEqual([]);
  });

  it("the first segment's header flipped: no step crashes", async () => {
    const r = await run("log segment: header byte flipped", standard, async (f) => {
      const seg = (await segments(f))[0]!;
      await corruptFile(f.fs, seg, flipAt(() => 4));
    });
    expect(crashes(r)).toEqual([]);
  });
});
