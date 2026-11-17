import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeEvent, Db, Entry } from "../src/index.js";
import {
  EngineHost,
  MemoryFs,
  createLocalIngestClient,
  destroyHarnessDb,
  ingest,
  openHarnessDb,
} from "../src/testing.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Both names write these keys, with a different value in each. */
const KEYS = 12;
const key = (i: number) => enc.encode(`k${String(i).padStart(2, "0")}`);
const text = (bytes: Uint8Array | undefined) => (bytes && dec.decode(bytes)) as string | undefined;

/** The value `name` writes to key `i` in `round`. */
const value = (name: string, round: number, i: number) => `${name}/r${round}/${i}`;
const roundOf = (name: string, round: number) => Array.from({ length: KEYS }, (_, i) => value(name, round, i));

let counter = 0;
const opened: Db[] = [];
const used: string[] = [];

/** Two names no other test uses, so what a test leaves in IndexedDB reaches none. */
function names(): [string, string] {
  const n = ++counter;
  const pair: [string, string] = [`two-db-${n}-a`, `two-db-${n}-b`];
  used.push(...pair);
  return pair;
}

async function cleanUp(): Promise<void> {
  await Promise.all(opened.splice(0).map((db) => db.close()));
  for (const name of used.splice(0)) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${name}`);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
}

afterEach(cleanUp);

/**
 * What one SharedWorker serves: one host and one ingest client for every name,
 * and a folder of run files for each.
 */
function origin() {
  const folders = new Map<string, MemoryFs>();
  const folder = (name: string) => {
    let fs = folders.get(name);
    if (!fs) folders.set(name, (fs = new MemoryFs()));
    return fs;
  };
  const host = new EngineHost(folder);
  const client = createLocalIngestClient(host);
  const options = (name: string, writerId?: string) => ({
    name,
    ...(writerId ? { writerId } : {}),
    fs: folder(name),
    ingest: client,
    maxWalBytes: 1e12,
  });
  let handles = 0;
  const open = async (name: string) => {
    const db = await openHarnessDb(options(name, `tab-${++handles}`));
    opened.push(db);
    return db;
  };
  return { host, folder, open, destroy: (name: string) => destroyHarnessDb(options(name)) };
}

/** Writes `round` of `name` and flushes it, which compacts once four runs wait. */
async function flushRound(db: Db, round: number): Promise<void> {
  await writeRound(db, round);
  await ingest(db);
}

async function writeRound(db: Db, round: number): Promise<void> {
  await db.batch((tx) => {
    for (let i = 0; i < KEYS; i++) tx.put(key(i), enc.encode(value(db.name, round, i)));
  });
}

async function entries(rows: AsyncIterable<Entry>): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for await (const { key, value } of rows) out.push([dec.decode(key), dec.decode(value)]);
  return out;
}

/** `get`, `range` and a `view` must all read `expected`, one value per key, undefined for an absent key. */
async function expectRows(db: Db, expected: readonly (string | undefined)[]): Promise<void> {
  const live = expected.flatMap((v, i) => (v === undefined ? [] : [[dec.decode(key(i)), v] as [string, string]]));
  expect(await Promise.all(expected.map(async (_, i) => text(await db.get(key(i)))))).toEqual(expected);
  expect(await entries(db.range())).toEqual(live);
  await db.view(async (snap) => {
    expect(await Promise.all(expected.map(async (_, i) => text(await snap.get(key(i)))))).toEqual(expected);
    expect(await entries(snap.range())).toEqual(live);
  });
}

const none = Array.from({ length: KEYS }, () => undefined);

function record(db: Db): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  db.changes((event) => events.push(event));
  return events;
}

const writtenKeys = (events: readonly ChangeEvent[]) =>
  events.flatMap((e) => (e.kind === "append" ? e.ops.flatMap((op) => ("key" in op ? [dec.decode(op.key)] : [])) : []));

const levels = async (host: EngineHost, name: string) => (await host.stats(name)).layout;
const lowLevels = (layout: { level: number }[]) => layout.filter((l) => l.level > 0);

describe("two databases served by one host", () => {
  it("reads each name's own values from the WAL, after a flush and after a compaction", async () => {
    const { host, open } = origin();
    const [A, B] = names();
    const a = await open(A);
    const b = await open(B);

    await writeRound(a, 0);
    await writeRound(b, 0);
    await expectRows(a, roundOf(A, 0));
    await expectRows(b, roundOf(B, 0));

    await ingest(a);
    await ingest(b);
    expect((await host.stats(A)).flushes).toBe(1);
    expect((await host.stats(B)).flushes).toBe(1);
    await expectRows(a, roundOf(A, 0));
    await expectRows(b, roundOf(B, 0));

    for (let round = 1; round < 4; round++) {
      await flushRound(a, round);
      await flushRound(b, round);
    }
    expect((await host.stats(A)).compactionSteps).toBeGreaterThan(0);
    expect((await host.stats(B)).compactionSteps).toBeGreaterThan(0);
    await expectRows(a, roundOf(A, 3));
    await expectRows(b, roundOf(B, 3));

    // A write in the WAL over runs that were compacted.
    await a.put(key(0), enc.encode("wal-a"));
    await b.put(key(0), enc.encode("wal-b"));
    expect(text(await a.get(key(0)))).toBe("wal-a");
    expect(text(await b.get(key(0)))).toBe("wal-b");
    expect(text(await a.get(key(1)))).toBe(value(A, 3, 1));
    expect(text(await b.get(key(1)))).toBe(value(B, 3, 1));
  });

  it("keeps a view of one name on its own rows while the other name writes and flushes", async () => {
    const { open } = origin();
    const [A, B] = names();
    const a = await open(A);
    const b = await open(B);
    await flushRound(a, 0);
    await flushRound(b, 0);

    await a.view(async (snap) => {
      await flushRound(b, 1);
      await writeRound(b, 2);
      expect(await Promise.all(Array.from({ length: KEYS }, async (_, i) => text(await snap.get(key(i)))))).toEqual(
        roundOf(A, 0),
      );
      expect((await entries(snap.range())).map(([, v]) => v)).toEqual(roundOf(A, 0));
    });

    await expectRows(a, roundOf(A, 0));
    await expectRows(b, roundOf(B, 2));
  });

  it("keeps an IndexedDB database and a folder of files for each name", async () => {
    const { folder, open } = origin();
    const [A, B] = names();
    await flushRound(await open(A), 0);
    await flushRound(await open(B), 0);

    const wals = (await indexedDB.databases()).map((db) => db.name);
    expect(wals).toContain(`opfs-lsm-wal/${A}`);
    expect(wals).toContain(`opfs-lsm-wal/${B}`);
    expect(folder(A).publishedPaths().length).toBeGreaterThan(0);
    expect(folder(B).publishedPaths().length).toBeGreaterThan(0);
  });

  it("compacts one name and leaves the runs and the reads of the other alone", async () => {
    const { host, open } = origin();
    const [A, B] = names();
    const a = await open(A);
    const b = await open(B);
    for (let round = 0; round < 3; round++) await flushRound(b, round);
    const before = await levels(host, B);
    expect(before).toEqual([expect.objectContaining({ level: 0, runs: 3 })]);

    for (let round = 0; round < 4; round++) await flushRound(a, round);

    expect((await host.stats(A)).compactionSteps).toBeGreaterThan(0);
    expect(lowLevels(await levels(host, A)).length).toBeGreaterThan(0);
    expect((await host.stats(B)).compactionSteps).toBe(0);
    expect(await levels(host, B)).toEqual(before);
    await expectRows(a, roundOf(A, 3));
    await expectRows(b, roundOf(B, 2));

    const settled = await levels(host, A);
    await flushRound(b, 3);

    expect((await host.stats(B)).compactionSteps).toBeGreaterThan(0);
    expect(await levels(host, A)).toEqual(settled);
    await expectRows(a, roundOf(A, 3));
    await expectRows(b, roundOf(B, 3));
  });

  it("announces a write to the other handles of its name and to no handle of the other name", async () => {
    const { open } = origin();
    const [A, B] = names();
    const a1 = await open(A);
    const a2 = await open(A);
    const b1 = await open(B);
    const onA1 = record(a1);
    const onA2 = record(a2);
    const onB1 = record(b1);

    await a1.put(key(0), enc.encode("from-a1"));
    await a2.sync();
    await b1.sync();
    await pause(50);
    expect(writtenKeys(onA1)).toEqual(["k00"]);
    expect(writtenKeys(onA2)).toEqual(["k00"]);
    expect(onB1).toEqual([]);
    expect(text(await a2.get(key(0)))).toBe("from-a1");
    expect(await b1.get(key(0))).toBeUndefined();

    await b1.put(key(1), enc.encode("from-b1"));
    await a1.sync();
    await a2.sync();
    await pause(50);
    expect(writtenKeys(onB1)).toEqual(["k01"]);
    expect(writtenKeys(onA1)).toEqual(["k00"]);
    expect(writtenKeys(onA2)).toEqual(["k00"]);

    await ingest(a1);
    await a2.sync();
    await b1.sync();
    await pause(50);
    expect(onB1.map((e) => e.kind)).toEqual(["append"]);
  });
});

describe("dangerousDestroy of one name", () => {
  it("empties that name and leaves every handle of the other reading and writing", async () => {
    const { host, folder, open } = origin();
    const [A, B] = names();
    const a1 = await open(A);
    const a2 = await open(A);
    const b1 = await open(B);
    const b2 = await open(B);
    for (let round = 0; round < 5; round++) {
      await flushRound(a1, round);
      await flushRound(b1, round);
    }
    // Rows that wait in the WAL, over the runs.
    await a1.put(key(0), enc.encode("wal-a"));
    await b1.put(key(0), enc.encode("wal-b"));
    await a2.sync();
    await b2.sync();
    const bFiles = folder(B).publishedPaths();
    const bLayout = await levels(host, B);
    const bGeneration = (await host.stats(B)).generation;
    const onA2 = record(a2);
    const onB1 = record(b1);
    const onB2 = record(b2);
    const expectedB = roundOf(B, 4).map((v, i) => (i === 0 ? "wal-b" : v));

    await a1.dangerousDestroy();
    await a2.sync();
    await b1.sync();
    await b2.sync();
    await pause(50);

    await expectRows(a1, none);
    await expectRows(a2, none);
    expect(onA2.map((e) => e.kind)).toContain("gap");
    expect(folder(A).publishedPaths()).toEqual([]);
    await expectRows(b1, expectedB);
    await expectRows(b2, expectedB);
    expect(onB1.map((e) => e.kind)).toEqual([]);
    expect(onB2.map((e) => e.kind)).toEqual([]);
    expect(folder(B).publishedPaths()).toEqual(bFiles);
    expect(await levels(host, B)).toEqual(bLayout);
    expect((await host.stats(B)).generation).toBe(bGeneration);

    await flushRound(b1, 5);
    await b2.sync();
    await expectRows(b2, roundOf(B, 5));
    await expectRows(a1, none);
  });

  it("lets the destroyed name take new writes next to the other name", async () => {
    const { open } = origin();
    const [A, B] = names();
    const a = await open(A);
    const b = await open(B);
    await flushRound(a, 0);
    await flushRound(b, 0);

    await a.dangerousDestroy();
    expect(await a.get(key(0))).toBeUndefined();
    await flushRound(a, 1);

    await expectRows(a, roundOf(A, 1));
    await expectRows(b, roundOf(B, 0));
  });
});

describe("destroyDb of one name", () => {
  it("empties that name while the other stays open and keeps its rows", async () => {
    const { host, folder, open, destroy } = origin();
    const [A, B] = names();
    const a = await open(A);
    const b = await open(B);
    for (let round = 0; round < 5; round++) {
      await flushRound(a, round);
      await flushRound(b, round);
    }
    await a.put(key(0), enc.encode("wal-a"));
    await b.put(key(0), enc.encode("wal-b"));
    await a.close();
    const bFiles = folder(B).publishedPaths();
    const bLayout = await levels(host, B);
    const onB = record(b);

    await destroy(A);
    await pause(50);

    expect(folder(A).publishedPaths()).toEqual([]);
    expect(folder(B).publishedPaths()).toEqual(bFiles);
    expect(await levels(host, B)).toEqual(bLayout);
    expect(onB).toEqual([]);
    await expectRows(b, roundOf(B, 4).map((v, i) => (i === 0 ? "wal-b" : v)));
    await expectRows(await open(A), none);

    await flushRound(b, 5);
    await expectRows(b, roundOf(B, 5));
  });
});

describe("closing every handle of one name", () => {
  it("reopens its rows, with the other name unaffected", async () => {
    const { host, open } = origin();
    const [A, B] = names();
    const a1 = await open(A);
    const a2 = await open(A);
    const b = await open(B);
    for (let round = 0; round < 4; round++) {
      await flushRound(a1, round);
      await flushRound(b, round);
    }
    await a1.put(key(0), enc.encode("wal-a"));
    const expectedA = roundOf(A, 3).map((v, i) => (i === 0 ? "wal-a" : v));
    const generation = (await host.stats(B)).generation;

    await a1.close();
    await a2.close();
    await expectRows(b, roundOf(B, 3));
    await flushRound(b, 4);
    expect((await host.stats(B)).generation).toBeGreaterThan(generation);

    const reopened = await open(A);
    await expectRows(reopened, expectedA);
    await expectRows(b, roundOf(B, 4));
    await flushRound(reopened, 4);
    await expectRows(reopened, roundOf(A, 4));
    await expectRows(b, roundOf(B, 4));
  });
});

describe("interleaved writes to two names", () => {
  type Op =
    | { name: 0 | 1; kind: "put"; key: number; value: number }
    | { name: 0 | 1; kind: "delete"; key: number }
    | { name: 0 | 1; kind: "flush" };

  const ops = fc.array(
    fc.oneof(
      fc.record({ name: fc.constantFrom(0, 1), kind: fc.constant("put"), key: fc.nat(5), value: fc.nat(99) }),
      fc.record({ name: fc.constantFrom(0, 1), kind: fc.constant("delete"), key: fc.nat(5) }),
      fc.record({ name: fc.constantFrom(0, 1), kind: fc.constant("flush") }),
    ),
    { maxLength: 24 },
  ) as fc.Arbitrary<Op[]>;

  it("matches a map per name, in every handle", async () => {
    await fc.assert(
      fc.asyncProperty(ops, async (history) => {
        const { open } = origin();
        const pair = names();
        const dbs = await Promise.all(pair.map(open));
        const oracle = pair.map(() => new Map<string, string>());
        for (const op of history) {
          const db = dbs[op.name]!;
          const model = oracle[op.name]!;
          if (op.kind === "flush") {
            await ingest(db);
            continue;
          }
          const k = `k${op.key}`;
          if (op.kind === "put") {
            const v = `${pair[op.name]}/${op.value}`;
            await db.put(enc.encode(k), enc.encode(v));
            model.set(k, v);
          } else {
            await db.delete(enc.encode(k));
            model.delete(k);
          }
        }
        for (const [n, db] of dbs.entries()) {
          const live = [...oracle[n]!].sort(([x], [y]) => (x < y ? -1 : 1));
          expect(await entries(db.range())).toEqual(live);
          for (let i = 0; i < 6; i++) expect(text(await db.get(enc.encode(`k${i}`)))).toBe(oracle[n]!.get(`k${i}`));
        }
        await cleanUp();
      }),
      { numRuns: 100 },
    );
  });
});
