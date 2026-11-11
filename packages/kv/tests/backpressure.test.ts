import { afterEach, describe, expect, it, vi } from "vitest";
import { Backpressure, memtableCaps } from "../src/backpressure.js";
import type { Db } from "../src/index.js";
import { loadLatestGeneration } from "../src/store/generation.js";
import {
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
  openHarnessDb,
  __resetMemoryFsForTests,
  type HarnessOpenOptions,
  type IngestClient,
} from "../src/testing.js";

const NAME = "backpressure";
const MiB = 1024 * 1024;
const enc = new TextEncoder();
const key = (i: number) => enc.encode(`k${String(i).padStart(6, "0")}`);
const value = (i: number) => new Uint8Array(16 * 1024).fill(i % 251);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True when `promise` settles within `ms`. */
function settlesWithin(promise: Promise<unknown>, ms = 15): Promise<boolean> {
  return Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
}

describe("memtableCaps", () => {
  it("are 7/8 and 1x of the request, 16 MiB by default, and at least 1 MiB", () => {
    expect(memtableCaps()).toEqual({ soft: 14 * MiB, hard: 16 * MiB });
    expect(memtableCaps(8 * MiB)).toEqual({ soft: 7 * MiB, hard: 8 * MiB });
    expect(memtableCaps(1)).toEqual({ soft: 896 * 1024, hard: MiB });
  });
});

/** A gate over a table whose size the test sets, and flushes the test settles by hand. */
function gateOf() {
  const table = { bytes: 0 };
  const flushes: { advance: (advanced: boolean) => void; fail: () => void }[] = [];
  const gate = new Backpressure(
    { soft: 70, hard: 80 },
    () => table.bytes,
    () =>
      new Promise<boolean>((resolve, reject) =>
        flushes.push({ advance: resolve, fail: () => reject(new Error("host gone")) }),
      ),
  );
  return { gate, table, flushes };
}

describe("Backpressure", () => {
  it("does nothing below the soft cap", async () => {
    const { gate, table, flushes } = gateOf();
    table.bytes = 69;
    gate.landed();
    await gate.admit();
    expect(flushes).toHaveLength(0);
  });

  it("asks for one flush at the soft cap and lets writes go on", async () => {
    const { gate, table, flushes } = gateOf();
    table.bytes = 70;
    gate.landed();
    table.bytes = 79;
    gate.landed();
    await gate.admit();
    expect(flushes).toHaveLength(1);
  });

  it("holds a write at the hard cap until the flush it already asked for returns", async () => {
    const { gate, table, flushes } = gateOf();
    table.bytes = 70;
    gate.landed();
    table.bytes = 80;
    const admitted = gate.admit();
    expect(await settlesWithin(admitted)).toBe(false);
    expect(flushes).toHaveLength(1);

    table.bytes = 5;
    flushes[0]!.advance(true);
    expect(await settlesWithin(admitted)).toBe(true);
    expect(flushes).toHaveLength(1);
  });

  it("starts a flush when the table jumps from under the soft cap to the hard one", async () => {
    const { gate, table, flushes } = gateOf();
    table.bytes = 200;
    const admitted = gate.admit();
    expect(flushes).toHaveLength(1);
    table.bytes = 0;
    flushes[0]!.advance(true);
    expect(await settlesWithin(admitted)).toBe(true);
  });

  it("makes writers that wait together share one flush", async () => {
    const { gate, table, flushes } = gateOf();
    table.bytes = 90;
    const first = gate.admit();
    const second = gate.admit();
    expect(flushes).toHaveLength(1);
    table.bytes = 0;
    flushes[0]!.advance(true);
    expect(await settlesWithin(Promise.all([first, second]))).toBe(true);
    expect(flushes).toHaveLength(1);
  });

  it("looks again when a flush moved the generation but the table is still full", async () => {
    const { gate, table, flushes } = gateOf();
    table.bytes = 90;
    const admitted = gate.admit();
    flushes[0]!.advance(true);
    await sleep(5);
    expect(flushes).toHaveLength(2);
    expect(await settlesWithin(admitted)).toBe(false);

    table.bytes = 0;
    flushes[1]!.advance(true);
    expect(await settlesWithin(admitted)).toBe(true);
  });

  it("lets the write go when a flush leaves the generation where it was", async () => {
    const { gate, table, flushes } = gateOf();
    table.bytes = 90;
    const admitted = gate.admit();
    flushes[0]!.advance(false);
    expect(await settlesWithin(admitted)).toBe(true);
  });

  it("lets the write go when a flush fails", async () => {
    const { gate, table, flushes } = gateOf();
    table.bytes = 90;
    const admitted = gate.admit();
    flushes[0]!.fail();
    expect(await settlesWithin(admitted)).toBe(true);
  });

  it("asks again only after the table grew by an eighth of the limit past a flush that did not help", async () => {
    const { gate, table, flushes } = gateOf();
    table.bytes = 90;
    const first = gate.admit();
    flushes[0]!.advance(false);
    await first;

    // 90 + (80 - 70) = 100 is where the next flush is asked for.
    table.bytes = 99;
    await gate.admit();
    gate.landed();
    expect(flushes).toHaveLength(1);

    table.bytes = 100;
    const again = gate.admit();
    expect(flushes).toHaveLength(2);
    flushes[1]!.advance(false);
    await again;
  });

  it("asks at the soft cap again after a flush that helped", async () => {
    const { gate, table, flushes } = gateOf();
    table.bytes = 75;
    gate.landed();
    table.bytes = 0;
    flushes[0]!.advance(true);
    await sleep(5);

    table.bytes = 70;
    gate.landed();
    expect(flushes).toHaveLength(2);
  });
});

const opened: Db[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  __resetMemoryFsForTests(NAME);
});

type Call = { readonly through: number; readonly waitForCompaction: boolean };

/**
 * A tab's link to a host. It records the ingest requests, answers them with
 * `ingest`, and does not pass `watch` on, so only the tab asks for flushes.
 */
function tabLink(
  fs: MemoryFs,
  ingest: (call: Call, host: IngestClient) => Promise<{ generation: number }>,
) {
  const host = createLocalIngestClient(new EngineHost(() => fs));
  const calls: Call[] = [];
  const client: IngestClient = {
    ...host,
    watch: () => undefined,
    ingest: (_name, through, waitForCompaction) => {
      const call = { through, waitForCompaction: waitForCompaction ?? false };
      calls.push(call);
      return ingest(call, host);
    },
  };
  return { client, calls };
}

async function open(
  fs: MemoryFs,
  ingest: IngestClient,
  options: Partial<HarnessOpenOptions> = {},
): Promise<Db> {
  const db = await openHarnessDb({
    name: NAME,
    fs,
    ingest,
    ingestPolicy: { maxWalBytes: 1e12 },
    ...options,
  });
  opened.push(db);
  return db;
}

/**
 * Puts rows until one stays pending. Gives that put, the rows that landed
 * before it, and the rows that had landed when the host was first asked.
 */
async function putUntilHeld(db: Db, calls: readonly Call[]) {
  let rowsWhenAsked: number | undefined;
  for (let rows = 0; rows < 200; rows++) {
    const put = db.put(key(rows), value(rows));
    // Until the host is asked the gate is open, so a put is only slow.
    if (calls.length === 0) {
      await put;
      continue;
    }
    rowsWhenAsked ??= rows;
    if (!(await settlesWithin(put, 150))) return { held: put, rows, rowsWhenAsked };
  }
  throw new Error("the memtable never filled");
}

describe("a writer against memtableBytes", () => {
  it("asks for one flush at 7/8, then waits at the limit until the host returns it", async () => {
    const fs = new MemoryFs();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { client, calls } = tabLink(fs, async (call, host) => {
      await held;
      return host.ingest(NAME, call.through, call.waitForCompaction);
    });
    const db = await open(fs, client, { memtableBytes: MiB });

    const { held: put, rows, rowsWhenAsked } = await putUntilHeld(db, calls);

    expect(calls).toEqual([{ through: Number.POSITIVE_INFINITY, waitForCompaction: false }]);
    // Writes past the request went on while it was out.
    expect(rows).toBeGreaterThan(rowsWhenAsked + 1);
    const update = db.update([key(0)], (_values, tx) => tx.put(key(0), value(1)));
    expect(await settlesWithin(update)).toBe(false);

    release();
    await put;
    await update;
    expect(calls).toHaveLength(1);
    expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1);
    expect(await db.get(key(0))).toEqual(value(1));
    expect(await db.get(key(rows))).toEqual(value(rows));
  });

  it("is not held by a host that never moves the generation, and does not ask on every write", async () => {
    const fs = new MemoryFs();
    const { client, calls } = tabLink(fs, async () => {
      await sleep(1);
      return { generation: 0 };
    });
    const db = await open(fs, client, { memtableBytes: MiB });

    // 200 rows are over 3 MiB, three times the limit.
    const writes = 200;
    for (let i = 0; i < writes; i++) await db.put(key(i), value(i));

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThan(writes / 4);
    expect(await db.get(key(writes - 1))).toEqual(value(writes - 1));
  });

  it("is not held by a host that fails to flush", async () => {
    const fs = new MemoryFs();
    const { client } = tabLink(fs, () => Promise.reject(new Error("disk full")));
    const db = await open(fs, client, { memtableBytes: MiB });

    for (let i = 0; i < 120; i++) await db.put(key(i), value(i));

    expect(await db.get(key(119))).toEqual(value(119));
  });
});

describe("the host's flush limit", () => {
  /** The `maxWalBytes` a tab opened with `options` tells the host. */
  async function limitOf(fs: MemoryFs, options: Partial<HarnessOpenOptions>): Promise<number> {
    let limit = Number.NaN;
    const client: IngestClient = {
      ...createLocalIngestClient(new EngineHost(() => fs)),
      watch: (_name, policy) => {
        limit = policy.maxWalBytes;
      },
    };
    opened.push(await openHarnessDb({ name: NAME, fs, ingest: client, ...options }));
    return limit;
  }

  it("is the smaller of maxWalBytes and 7/8 of memtableBytes", async () => {
    const fs = new MemoryFs();
    expect(await limitOf(fs, {})).toBe(MiB);
    expect(await limitOf(fs, { ingestPolicy: { maxWalBytes: 1e12 } })).toBe(14 * MiB);
    expect(await limitOf(fs, { ingestPolicy: { maxWalBytes: 1e12 }, memtableBytes: MiB })).toBe(896 * 1024);
  });

  it("flushes the WAL at 7/8 of the smallest memtableBytes any tab opened with", async () => {
    const fs = new MemoryFs();
    const host = createLocalIngestClient(new EngineHost(() => fs));
    const tab = (writerId: string, memtableBytes?: number) =>
      open(fs, host, { writerId, ...(memtableBytes === undefined ? {} : { memtableBytes }) });
    const writer = await tab("writer");
    await tab("small", MiB);

    // 40 puts are 640 KiB of ops, under the 896 KiB the small tab asks for.
    for (let i = 0; i < 40; i++) await writer.put(key(i), value(i));
    await sleep(100);
    expect(await loadLatestGeneration(fs)).toBeUndefined();

    for (let i = 40; i < 60; i++) await writer.put(key(i), value(i));
    await vi.waitFor(async () => expect((await loadLatestGeneration(fs))?.runs).toHaveLength(1), {
      timeout: 3000,
      interval: 10,
    });
  });
});
