import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CommitError, CorruptDatabaseError } from "../../src/errors.js";
import { EngineHost, MemoryFs, createLocalIngestClient, type Db } from "../../src/index.js";
import { encodeSst as encodeSstWasm, ensureEngine } from "../../src/store/engine.js";
import { encodeGeneration, runMeta } from "../../src/store/generation.js";
import { openHarnessDb } from "../../src/testing.js";
import { checkDatabase, deleteWal, walMeta, walStore } from "./check-database.js";

/**
 * End-to-end corruption (docs/research/corruption-hardening-test-suite.md,
 * techniques 7 and 10). One database file is corrupted: a run of L0, L1 or
 * L2 (LZ4), the recorded manifest, a leftover manifest, a WAL row, or a WAL
 * `meta` row. Then a fresh tab and host open it and get, scan, write, flush,
 * compact and reopen. Each step is recorded as one outcome, and the rules
 * are checked:
 *
 * - No step hangs, and none fails with anything but an `OpfsLsmError`.
 * - Where a CRC is checked (manifests everywhere, runs in the SharedWorker's
 *   compaction), the corruption never becomes a wrong answer or lost data:
 *   a step fails with `CorruptDatabaseError`, or answers right.
 * - Where none is (a tab's run reads, WAL rows and `meta`), a wrong answer
 *   is allowed.
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

afterEach(async () => {
  for (let i = 1; i <= dbs; i++) await deleteWal(`corrupt-${i}`);
});

/** The database every case starts from, and what it must read. */
type Fixture = {
  readonly name: string;
  readonly fs: MemoryFs;
  /** Live keys and their values, as the log says. */
  readonly state: Map<string, string>;
};

/**
 * Five flushes: four L0 runs compact into one L1 run, then one more L0 run,
 * and two batches left in the WAL. Values are unique per write.
 */
async function standard(): Promise<Fixture> {
  const name = `corrupt-${++dbs}`;
  const fs = new MemoryFs();
  const state = new Map<string, string>();
  const db = await openHarnessDb({ name, fs, ingest: createLocalIngestClient(new EngineHost(() => fs)) });
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
  await db.put(utf("tail"), utf("in the WAL"));
  state.set("tail", "in the WAL");
  await db.close();
  return { name, fs, state };
}

/**
 * One LZ4 run in L2, as compaction writes deep runs, recorded by a manifest
 * whose `through` covers its seqs. IndexedDB starts empty, and recovery
 * records the manifest (design.md, "Recovery", rule 3).
 */
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
  const body = await encodeSstWasm(entries, "lz4");
  const path = `l2/c1.0-${body.byteLength}.sst`;
  await put(fs, path, body);
  await put(fs, "m/0000000000000001.mft", encodeGeneration({ generation: 1, runs: [runMeta(path, body)], tombstoneSeq: 0, through: 300 }));
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

const l0 = async (f: Fixture) => (await files(f.fs, "l0")).at(-1)!;
const l1 = async (f: Fixture) => (await files(f.fs, "l1"))[0]!;
const l2 = async (f: Fixture) => (await files(f.fs, "l2"))[0]!;
const recorded = async (f: Fixture) => `m/${String((await walMeta(f.name)).generation).padStart(16, "0")}.mft`;
const runFiles = async (f: Fixture) => [...(await files(f.fs, "l0")), ...(await files(f.fs, "l1"))];

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
  const host = new EngineHost(() => f.fs);
  const open = () => openHarnessDb({ name: f.name, fs: f.fs, ingest: createLocalIngestClient(host) });
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

/**
 * KW2 (fuzz/known-bugs.test.ts): with wasm, compaction over a corrupt run
 * fails with the Rust error as a bare string. Reported, not fixed; the KW2
 * test below pins it, and the other tests let it pass.
 */
const kw2 = (o: Outcome | undefined) =>
  /^THREW string (CrcMismatch|BadMagic|BadVersion|Truncated|TooShort|BadBlock|BadTag|TrailingGarbage|CountMismatch|BadCodec)/.test(o ?? "");

/** Steps that hung or threw a stray error: every step must fail as documented or answer. */
function crashes(r: Report): string[] {
  return Object.entries(r)
    .filter(([s, o]) => o === "HANG" || (o.startsWith("THREW") && !(s === "compact" && kw2(o))))
    .map(([s, o]) => `${s}: ${o}`);
}

/** Steps that answered wrong. A CRC-checked file must fail as corrupt or answer right. */
function wrongAnswers(r: Report): string[] {
  return Object.entries(r)
    .filter(([, o]) => o === "wrong")
    .map(([s]) => s);
}

/** Compaction refused the corrupt run: CorruptDatabaseError, or KW2's string. */
const refused = (o: Outcome | undefined) => o === "corrupt" || kw2(o);

describe("a healthy database", () => {
  it("passes every step (the harness is right)", async () => {
    expect(await run("none: healthy", standard, async () => undefined)).toEqual(HEALTHY);
    expect(await run("none: healthy, one L2 LZ4 run", deep, async () => undefined)).toEqual(HEALTHY);
  });

  it("the standard fixture has L0 and L1 runs, a WAL tail, and checks clean", async () => {
    const f = await standard();
    expect(await files(f.fs, "l0")).toHaveLength(1);
    expect(await files(f.fs, "l1")).toHaveLength(1);
    const report = await checkDatabase(f.fs, f.name);
    expect(report.problems).toEqual([]);
    expect(report.head - report.ingestedThrough).toBe(2);
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

  // KT2 (fuzz/known-bugs.test.ts): one flipped bit in the high byte of the
  // footer's block count makes a tab allocate 2^24 x 8 bytes before it reads
  // the index. The read then fails as corrupt, so the outcomes look fine;
  // the allocation breaks the rule, and the fuzz suite pins it.
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

  // KW2: with wasm, compaction's decode throws the Rust error as a bare
  // string ("CrcMismatch") out of `db.ingest()`, not CorruptDatabaseError.
  // Candidate fix: wrap `decode_sst_js` and `merge_ssts_js` in engine.ts as
  // the block scanner is wrapped.
  it.fails("KW2: compaction over a corrupt run fails with CorruptDatabaseError", async () => {
    const r = await run("L0 run: data byte flipped (KW2)", standard, async (f) => corruptFile(f.fs, await l0(f), flipAt(() => 12)));
    expect(r.compact).toBe("corrupt");
  });
});

describe("a corrupt manifest: CRC-checked everywhere", () => {
  it("a leftover manifest past the recorded one is ignored", async () => {
    const r = await run("manifest: leftover past the recorded one, flipped", standard, async (f) => {
      const gen = (await walMeta(f.name)).generation!;
      const body = (await f.fs.read(await recorded(f), 0, Number.POSITIVE_INFINITY))!.slice();
      body[20]! ^= 1;
      await put(f.fs, `m/${String(gen + 1).padStart(16, "0")}.mft`, body);
    });
    expect(r).toEqual(HEALTHY);
  });

  it("the recorded manifest, a flipped byte: open fails as corrupt", async () => {
    const r = await run("manifest: recorded one, byte flipped", standard, async (f) => corruptFile(f.fs, await recorded(f), flipAt(() => 50)));
    expect(crashes(r)).toEqual([]);
    expect(r.open).toBe("corrupt");
  });

  it("the recorded manifest truncated: open fails as corrupt", async () => {
    const r = await run("manifest: recorded one, truncated", standard, async (f) => corruptFile(f.fs, await recorded(f), (b) => b.slice(0, 30)));
    expect(crashes(r)).toEqual([]);
    expect(r.open).toBe("corrupt");
  });
});

/**
 * Recovery (`reconcile`, src/recover.ts) treats a recorded manifest that
 * does not decode, or whose runs are not all on disk, as a power loss
 * (design.md, "Recovery", rule 3): it records the newest intact manifest,
 * or generation 0, and drops every WAL record that cannot follow it. The
 * host's sweep then removes every run the new generation does not list.
 *
 * A power loss cannot tear a manifest (OPFS publishes a file whole), and
 * OPFS keeps its writes in order, so a recorded manifest that is on disk
 * but fails its CRC, or lists a run that is gone while no newer intact
 * manifest takes its place, is corruption, not a power loss. Today both
 * become silent, permanent loss of the whole database (R1, R2). The
 * research note, technique 10: "A missing or corrupt run throws
 * CorruptDatabaseError. It must never be skipped silently", and "The engine
 * must not 'fix' a gap by deleting data".
 *
 * Candidate fix: in `choose`, tell a manifest file that is missing or empty
 * (power loss: rule 3 as today) from one that is present and fails to
 * decode (throw CorruptDatabaseError, record nothing). For a present,
 * decodable recorded manifest with a missing run, fall back only to a
 * manifest whose `through` reaches `ingestedThrough` (the compaction
 * power-loss row of design.md's table, which loses nothing); else throw.
 */
describe("recovery never turns corruption into data loss (reported, not fixed)", () => {
  /** How many keys a reopened database still reads right. */
  async function survivors(f: Fixture): Promise<number> {
    const db = await openHarnessDb({ name: f.name, fs: f.fs, ingest: createLocalIngestClient(new EngineHost(() => f.fs)) });
    let n = 0;
    for (const [k, v] of f.state) if (str(await db.get(utf(k))) === v) n++;
    await db.close();
    return n;
  }

  // R1: one L0 run of the recorded generation removed. `openDb` records
  // generation 0, drops the WAL (ingestedThrough moves to head), and reads
  // an empty database: the intact L1 run and the uningested WAL rows are
  // lost too, and the next sweep deletes the L1 run.
  it.fails("R1: a missing run of the recorded generation fails open as corrupt", async () => {
    const r = await run("L0 run: removed", standard, async (f) => f.fs.remove(await l0(f)));
    expect(r.open).toBe("corrupt");
  });

  it("R1 today: open records generation 0 and reads an empty database", async () => {
    const f = await standard();
    await f.fs.remove(await l0(f));
    expect(await survivors(f)).toBe(0);
    expect((await walMeta(f.name)).generation).toBe(0);
  });

  // R2: the recorded manifest fails its CRC. `openDb` throws
  // CorruptDatabaseError, as it should, but the SharedWorker's next flush
  // (any `db.ingest()`, or another tab's writes past `maxWalBytes`)
  // reconciles without trusting it: `readManifest` maps the CRC error to
  // "missing", rule 3 finds no other intact manifest and records generation
  // 0, the WAL is dropped, and the sweep deletes every run file. One flipped
  // bit in a manifest erases the database.
  it.fails("R2: a manifest that fails its CRC is never replaced, and no run is deleted", async () => {
    const f = await standard();
    await corruptFile(f.fs, await recorded(f), flipAt(() => 50));
    const before = await runFiles(f);
    await new EngineHost(() => f.fs).ingest(f.name, Number.POSITIVE_INFINITY, true).catch(() => undefined);
    expect(await runFiles(f)).toEqual(before);
    expect((await walMeta(f.name)).generation).not.toBe(0);
  });

  it("R2 today: the host's flush records generation 0 and deletes every run", async () => {
    const f = await standard();
    await corruptFile(f.fs, await recorded(f), flipAt(() => 50));
    await new EngineHost(() => f.fs).ingest(f.name, Number.POSITIVE_INFINITY, true);
    expect((await walMeta(f.name)).generation).toBe(0);
    expect(await runFiles(f)).toEqual([]);
    expect(await survivors(f)).toBe(0);
  });
});

describe("a corrupt WAL row: no checksum", () => {
  const head = async (f: Fixture) => (await walMeta(f.name)).head;

  it("an uningested row cut inside an op: open fails with corrupt wal row", async () => {
    const r = await run("WAL row: truncated", standard, async (f) => {
      const seq = await head(f);
      await walStore(f.name, "readwrite", async (wal) => {
        const raw = await new Promise<ArrayBuffer>((resolve) => {
          const req = wal.get(seq);
          req.onsuccess = () => resolve(req.result as ArrayBuffer);
        });
        return wal.put(raw.slice(0, raw.byteLength - 3), seq);
      });
    });
    expect(crashes(r)).toEqual([]);
    expect(r.open).toBe("commit");
  });

  it("an uningested row that is not bytes: open fails with corrupt wal row", async () => {
    const r = await run("WAL row: not an ArrayBuffer", standard, async (f) => {
      const seq = await head(f);
      await walStore(f.name, "readwrite", (wal) => wal.put({ ops: "garbage" }, seq));
    });
    expect(crashes(r)).toEqual([]);
    expect(r.open).toBe("commit");
  });

  it("an uningested row deleted: open fails on the gap", async () => {
    const r = await run("WAL row: deleted (a gap)", standard, async (f) => {
      const seq = await head(f);
      await walStore(f.name, "readwrite", (wal) => wal.delete(seq - 1));
    });
    expect(crashes(r)).toEqual([]);
    expect(r.open).toBe("commit");
  });

  it("meta.generation names a manifest that is not there", async () => {
    const r = await run("WAL meta: generation past every manifest", standard, async (f) => {
      await walStore(f.name, "readwrite", (_wal, meta) => meta.put(999, "generation"));
    });
    expect(crashes(r)).toEqual([]);
  });

  // `num()` reads a `meta` value that is not a number as 0. With `head` 0
  // a tab reads no WAL tail and answers without the uningested writes.
  // `meta` has no checksum, so the rules allow it; the table records it.
  it("meta.head is not a number: reads miss the WAL tail", async () => {
    const r = await run("WAL meta: head not a number", standard, async (f) => {
      await walStore(f.name, "readwrite", (_wal, meta) => meta.put("x", "head"));
    });
    expect(crashes(r)).toEqual([]);
    expect(r.get).toBe("wrong");
  });
});
