import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { checkDbName } from "../src/check.js";
import { readDestroyed } from "../src/idb/destroyed.js";
import { ClosedError, type ChangeEvent, type Db, type Entry } from "../src/index.js";
import { compactLock, ingestLock, openLock, pressureLock, reclaimLock, runLock } from "../src/locks.js";
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
 * One origin's storage: a folder of run files for each name, and one host
 * and one ingest client that serve every name. In a browser each name gets
 * its own SharedWorker, and only the in-page host of `two-tab-local` serves
 * several. One host for both names is the stricter setup: any per-name
 * state the host shared would show here.
 *
 * `reopen` opens a handle through a new host on the same folders, as a later
 * page load does, so it reads what reached each name's own files.
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
  const options = (name: string, ingest = client, maxWalBytes = 1e12, writerId?: string) => ({
    name,
    ...(writerId ? { writerId } : {}),
    fs: folder(name),
    ingest,
    maxWalBytes,
  });
  let handles = 0;
  const openWith = async (name: string, ingest = client, maxWalBytes?: number) => {
    const db = await openHarnessDb(options(name, ingest, maxWalBytes, `tab-${++handles}`));
    opened.push(db);
    return db;
  };
  return {
    host,
    folder,
    /** A handle on `name`. `maxWalBytes` defaults to never flushing on its own. */
    open: (name: string, maxWalBytes?: number) => openWith(name, client, maxWalBytes),
    reopen: (name: string) => openWith(name, createLocalIngestClient(new EngineHost(folder))),
    destroy: (name: string) => destroyHarnessDb(options(name)),
  };
}

/** Waits for `done`, polling; fails after `ms`. */
async function until(what: string, done: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(5);
  }
}

/** Node 22 has no LockManager; Node 24 and CI do. */
const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;

/** Takes each Web Lock and keeps it until `release`. */
async function hold(names: readonly (readonly [string, LockMode])[]) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const held: Promise<unknown>[] = [];
  for (const [name, mode] of names) {
    await new Promise<void>((taken) => {
      held.push(
        locks!.request(name, { mode }, () => {
          taken();
          return released;
        }),
      );
    });
  }
  return async () => {
    release();
    await Promise.all(held);
  };
}

const waitsFor = async (name: string) => ((await locks!.query()).pending ?? []).some((lock) => lock.name === name);

/** Fails if `work` has not finished within `ms`: something of another name holds it up. */
async function notHeldUp<T>(what: string, work: Promise<T>, ms = 3_000): Promise<T> {
  const late = Symbol("late");
  const result = await Promise.race([work, pause(ms).then(() => late)]);
  if (result === late) throw new Error(`${what} waited ${ms} ms`);
  return result as T;
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

let markers = 0;
const isMarker = (event: ChangeEvent) => writtenKeys([event]).some((k) => k.startsWith("marker/"));
const withoutMarkers = (events: readonly ChangeEvent[]) => events.filter((e) => !isMarker(e));

/**
 * Has `writer` delete an absent key, and waits until `events`, recorded on
 * another handle of the same name, show it. That handle's BroadcastChannel
 * brings it every message posted before the marker first, so an event it
 * should not get has arrived by then. Returns its events without markers.
 */
async function settle(writer: Db, events: ChangeEvent[]): Promise<ChangeEvent[]> {
  const marker = `marker/${++markers}`;
  await writer.delete(enc.encode(marker));
  await until(marker, () => writtenKeys(events).includes(marker));
  return withoutMarkers(events);
}

const walDatabases = async () => (await indexedDB.databases()).map((db) => db.name);
const destroyedRow = (name: string) => readDestroyed(checkDbName(name));
const closedByDestroy = { kind: "closed", reason: "destroyed" };

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
    const { host, folder, open } = origin();
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
    const inputs = folder(B).publishedPaths().filter((path) => path.startsWith("l0/"));
    await flushRound(b, 3);

    expect((await host.stats(B)).compactionSteps).toBeGreaterThan(0);
    expect(await levels(host, A)).toEqual(settled);
    await expectRows(a, roundOf(A, 3));
    await expectRows(b, roundOf(B, 3));

    // A moves to a generation B never had; B's next pass still sweeps its merged runs.
    await flushRound(a, 4);
    await ingest(b);
    expect(folder(B).publishedPaths().filter((path) => inputs.includes(path))).toEqual([]);
  });

  it("announces a write to the other handles of its name and to no handle of the other name", async () => {
    const { open } = origin();
    const [A, B] = names();
    const a1 = await open(A);
    const a2 = await open(A);
    const b1 = await open(B);
    const b2 = await open(B);
    const onA1 = record(a1);
    const onA2 = record(a2);
    const onB1 = record(b1);

    await a1.put(key(0), enc.encode("from-a1"));
    expect(writtenKeys(await settle(a1, onA2))).toEqual(["k00"]);
    expect(await settle(b2, onB1)).toEqual([]);
    expect(writtenKeys(withoutMarkers(onA1))).toEqual(["k00"]);
    expect(text(await a2.get(key(0)))).toBe("from-a1");
    expect(await b1.get(key(0))).toBeUndefined();

    await b1.put(key(1), enc.encode("from-b1"));
    expect(writtenKeys(await settle(a2, onA1))).toEqual(["k00"]);
    expect(writtenKeys(await settle(a1, onA2))).toEqual(["k00"]);
    expect(writtenKeys(withoutMarkers(onB1))).toEqual(["k01"]);

    await ingest(a1);
    expect((await settle(b2, onB1)).map((e) => e.kind)).toEqual(["append"]);
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
    await settle(b2, onB1);
    await settle(b1, onB2);

    await expectRows(a1, none);
    await expectRows(a2, none);
    expect(onA2.map((e) => e.kind)).toContain("gap");
    expect(folder(A).publishedPaths()).toEqual([]);
    await expectRows(b1, expectedB);
    await expectRows(b2, expectedB);
    expect(withoutMarkers(onB1)).toEqual([]);
    expect(withoutMarkers(onB2)).toEqual([]);
    expect(folder(B).publishedPaths()).toEqual(bFiles);
    expect(await levels(host, B)).toEqual(bLayout);
    expect((await host.stats(B)).generation).toBe(bGeneration);

    await flushRound(b1, 5);
    await b2.sync();
    await expectRows(b2, roundOf(B, 5));
    await expectRows(a1, none);
  });

  it.skipIf(!locks)("lets the other name compact while it runs", async () => {
    const { host, open } = origin();
    const [A, B] = names();
    const a = await open(A);
    const b = await open(B);
    for (let round = 0; round < 3; round++) {
      await flushRound(a, round);
      await flushRound(b, round);
    }
    expect((await host.stats(B)).compactionSteps).toBe(0);

    // A's destroy has started and waits for A's compaction lock, which the test holds.
    const release = await hold([[compactLock(A), "exclusive"]]);
    const destroying = a.dangerousDestroy();
    await until(`${A}'s destroy to wait for its compaction lock`, () => waitsFor(compactLock(A)));
    // B's fourth run starts a compaction.
    await flushRound(b, 3);
    expect((await host.stats(B)).compactionSteps).toBeGreaterThan(0);
    expect(lowLevels(await levels(host, B)).length).toBeGreaterThan(0);
    await release();
    await destroying;

    await expectRows(b, roundOf(B, 3));
    await expectRows(a, none);
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
  it("removes that name's stores and closes only its handles, while every handle of the other keeps its rows", async () => {
    const { host, folder, open, destroy } = origin();
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
    const onA1 = record(a1);
    const onA2 = record(a2);
    const onB1 = record(b1);
    const onB2 = record(b2);
    const expectedB = roundOf(B, 4).map((v, i) => (i === 0 ? "wal-b" : v));

    await destroy(A);

    expect(onA1.at(-1)).toEqual(closedByDestroy);
    expect(onA2.at(-1)).toEqual(closedByDestroy);
    await expect(a2.get(key(1))).rejects.toBeInstanceOf(ClosedError);
    expect(await walDatabases()).not.toContain(`opfs-lsm-wal/${A}`);
    expect(folder(A).publishedPaths()).toEqual([]);

    await settle(b2, onB1);
    await settle(b1, onB2);
    expect(withoutMarkers(onB1)).toEqual([]);
    expect(withoutMarkers(onB2)).toEqual([]);
    expect(await walDatabases()).toContain(`opfs-lsm-wal/${B}`);
    expect(folder(B).publishedPaths()).toEqual(bFiles);
    expect(await levels(host, B)).toEqual(bLayout);
    expect((await host.stats(B)).generation).toBe(bGeneration);
    expect(await destroyedRow(B)).toBeUndefined();
    await expectRows(b1, expectedB);
    await expectRows(b2, expectedB);

    await flushRound(b1, 5);
    await b2.sync();
    expect((await host.stats(B)).generation).toBeGreaterThan(bGeneration);
    await expectRows(b2, roundOf(B, 5));

    const reborn = await open(A);
    await expectRows(reborn, none);
    await flushRound(reborn, 0);
    await expectRows(reborn, roundOf(A, 0));
    await expectRows(b1, roundOf(B, 5));
  });

  it("keeps each name's destroyed row apart, and reopening a name forgets only its own", async () => {
    const { open, destroy } = origin();
    const [A, B] = names();
    await flushRound(await open(A), 0);
    const b = await open(B);
    for (let round = 0; round < 3; round++) await flushRound(b, round);
    await b.put(key(0), enc.encode("wal-b"));

    await destroy(A);
    const rowA = (await destroyedRow(A))!;
    expect(rowA).toBeDefined();

    // A reopens, which forgets A's row, while B's destroy writes B's.
    const [againA] = await Promise.all([open(A), destroy(B)]);
    const rowB = (await destroyedRow(B))!;
    expect(rowB).toBeDefined();
    expect(await destroyedRow(A)).toBeUndefined();
    expect(rowA.head).toBeLessThan(rowB.head);
    expect(await againA.put(key(0), enc.encode("a"))).toBeGreaterThanOrEqual(rowA.head);

    // B starts past its own row, which is higher than A's.
    const againB = await open(B);
    expect(await destroyedRow(B)).toBeUndefined();
    expect(await againB.put(key(0), enc.encode("b"))).toBeGreaterThanOrEqual(rowB.head);
    expect(text(await againA.get(key(0)))).toBe("a");
    expect(text(await againB.get(key(0)))).toBe("b");
  });

  it("brings no row of a destroyed name back after a power loss, while a new name opens next to it", async () => {
    const { folder, open, destroy } = origin();
    const [A, B] = names();
    const a = await open(A);
    for (let round = 0; round < 2; round++) await flushRound(a, round);
    const fs = folder(A);
    const files = new Map<string, Uint8Array>();
    for (const path of fs.publishedPaths()) files.set(path, (await fs.read(path, 0, Number.POSITIVE_INFINITY))!);

    await destroy(A);
    // OPFS lost the removes; IndexedDB kept the row and the delete.
    for (const [path, bytes] of files) {
      const w = await fs.create(path);
      await w.write(bytes);
      await w.finish();
    }
    const row = await destroyedRow(A);
    expect(row).toBeDefined();

    // A name never destroyed starts without a row, and leaves A's alone.
    const b = await open(B);
    await flushRound(b, 0);
    expect(await destroyedRow(B)).toBeUndefined();
    expect(await destroyedRow(A)).toEqual(row);

    await expectRows(await open(A), none);
    await expectRows(b, roundOf(B, 0));
  });

  it("creates nothing for a name never opened, and leaves the open names alone", async () => {
    const { open, destroy } = origin();
    const [A, B] = names();
    const [C] = names();
    const a = await open(A);
    const a2 = await open(A);
    const b = await open(B);
    const b2 = await open(B);
    await flushRound(a, 0);
    await flushRound(b, 0);
    const onA = record(a);
    const onB = record(b);

    await destroy(C);

    expect(await walDatabases()).not.toContain(`opfs-lsm-wal/${C}`);
    expect(await destroyedRow(C)).toBeUndefined();
    expect(await settle(a2, onA)).toEqual([]);
    expect(await settle(b2, onB)).toEqual([]);
    await expectRows(a, roundOf(A, 0));
    await expectRows(b, roundOf(B, 0));
  });

  it("destroys two names at once while a third flushes and compacts", async () => {
    const { host, open, destroy } = origin();
    const [A, B] = names();
    const [C] = names();
    // Both destroys create the shared row store.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase("opfs-lsm-destroyed");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    const a = await open(A);
    const b = await open(B);
    const c = await open(C);
    for (let round = 0; round < 3; round++) {
      await flushRound(a, round);
      await flushRound(b, round);
      await flushRound(c, round);
    }

    expect((await host.stats(C)).compactionSteps).toBe(0);

    // C's fourth run starts a compaction.
    await Promise.all([destroy(A), destroy(B), flushRound(c, 3), flushRound(c, 4)]);

    expect((await host.stats(C)).compactionSteps).toBeGreaterThan(0);
    expect(await destroyedRow(A)).toBeDefined();
    expect(await destroyedRow(B)).toBeDefined();
    expect(await destroyedRow(C)).toBeUndefined();
    const wals = await walDatabases();
    expect(wals).not.toContain(`opfs-lsm-wal/${A}`);
    expect(wals).not.toContain(`opfs-lsm-wal/${B}`);
    expect(wals).toContain(`opfs-lsm-wal/${C}`);
    await expectRows(c, roundOf(C, 4));
    await expectRows(await open(A), none);
    await expectRows(await open(B), none);
  });
});

describe("the Web Locks of one name", () => {
  it.skipIf(!locks)("hold up nothing of the other name: it opens, flushes, compacts and removes its old runs", async () => {
    const { host, folder, open } = origin();
    const [A, B] = names();
    await flushRound(await open(A), 0);
    const early = await open(B);
    for (let round = 0; round < 3; round++) await flushRound(early, round);
    const runs = folder(B).publishedPaths().filter((path) => !path.startsWith("m/"));
    expect(runs.length).toBe(3);

    // Every lock of A, and a reader's hold on each of B's run paths under A's name.
    const release = await hold([
      ...[openLock(A), compactLock(A), ingestLock(A), reclaimLock(A), pressureLock(A)].map((name) => [name, "exclusive"] as const),
      ...runs.map((path) => [runLock(A, path), "shared"] as const),
    ]);
    try {
      const b = await notHeldUp(`opening ${B}`, open(B));
      await notHeldUp(`${B}'s flush and compaction`, flushRound(b, 3));
      expect((await host.stats(B)).compactionSteps).toBeGreaterThan(0);
      // The next pass sweeps the merged runs.
      await notHeldUp(`${B}'s sweep`, ingest(b));
      expect(folder(B).publishedPaths().filter((path) => runs.includes(path))).toEqual([]);
      await expectRows(b, roundOf(B, 3));
    } finally {
      await release();
    }
  });
});

describe("auto-flush of one name", () => {
  it("flushes the name whose WAL passed its maxWalBytes, and leaves the other's WAL alone", async () => {
    const { host, folder, open } = origin();
    const [A, B] = names();
    const a = await open(A, 1_000);
    const b = await open(B);
    await writeRound(b, 0);

    for (let round = 0; round < 8; round++) await writeRound(a, round);
    await until(`an auto-flush of ${A}`, async () => (await host.stats(A)).flushes > 0);

    expect((await host.stats(B)).flushes).toBe(0);
    expect(folder(B).publishedPaths()).toEqual([]);
    await expectRows(a, roundOf(A, 7));
    await expectRows(b, roundOf(B, 0));
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

  it("matches a map per name, with both names running at once, and after a reopen on a new host", async () => {
    await fc.assert(
      fc.asyncProperty(ops, async (history) => {
        const { open, reopen } = origin();
        const pair = names();
        const dbs = await Promise.all(pair.map((name) => open(name)));
        const oracle = pair.map(() => new Map<string, string>());
        // Each name runs its own ops in order, concurrently with the other's.
        await Promise.all(
          pair.map(async (name, n) => {
            const db = dbs[n]!;
            const model = oracle[n]!;
            for (const op of history.filter((o) => o.name === n)) {
              if (op.kind === "flush") {
                await ingest(db);
                continue;
              }
              const k = `k${op.key}`;
              if (op.kind === "put") {
                const v = `${name}/${op.value}`;
                await db.put(enc.encode(k), enc.encode(v));
                model.set(k, v);
              } else {
                await db.delete(enc.encode(k));
                model.delete(k);
              }
            }
          }),
        );
        for (const [n, name] of pair.entries()) {
          const live = [...oracle[n]!].sort(([x], [y]) => (x < y ? -1 : 1));
          for (const db of [dbs[n]!, await reopen(name)]) {
            expect(await entries(db.range())).toEqual(live);
            for (let i = 0; i < 6; i++) expect(text(await db.get(enc.encode(`k${i}`)))).toBe(oracle[n]!.get(`k${i}`));
          }
        }
        await cleanUp();
      }),
      { numRuns: 100 },
    );
  });
});
