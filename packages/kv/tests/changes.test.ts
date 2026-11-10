import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangeEvent, Db, Entry } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "changes-test";
const enc = new TextEncoder();
const b = (s: string) => enc.encode(s);

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

const open = (writerId: string): Promise<Db> =>
  openHarnessDb({ name: NAME, forceMemory: true, writerId, ingestPolicy: { maxWalBytes: 1 << 30 } });

/** A handle that gets no BroadcastChannel message, so it learns of other writes only through `sync()`. */
async function openWithoutBus(writerId: string): Promise<Db> {
  const g = globalThis as { BroadcastChannel?: unknown };
  const real = g.BroadcastChannel;
  g.BroadcastChannel = undefined;
  try {
    return await open(writerId);
  } finally {
    g.BroadcastChannel = real;
  }
}

function record(db: Db): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  db.changes((e) => events.push(e));
  return events;
}

function until(db: Db, done: (e: ChangeEvent) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stop = db.changes((e) => {
      if (!done(e)) return;
      stop();
      resolve();
    });
  });
}

const appends = (events: readonly ChangeEvent[]) => events.filter((e) => e.kind === "append");
const seqs = (events: readonly ChangeEvent[]) => appends(events).map((e) => e.seq);

async function collect(it: AsyncIterable<Entry>): Promise<Entry[]> {
  const out: Entry[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const opened: Db[] = [];

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  __resetMemoryFsForTests(NAME);
});

async function track(db: Promise<Db>): Promise<Db> {
  opened.push(await db);
  return opened.at(-1)!;
}

describe("changes()", () => {
  it("announces a write with its ops before the write resolves with its seq, and closed last", async () => {
    const db = await track(open("w1"));
    const events = record(db);

    const first = await db.batch((tx) => {
      tx.put(b("a"), b("1"));
      tx.delete(b("b"));
    });
    expect(first).toBe(1);
    expect(events).toEqual([
      { kind: "append", seq: 1, ops: [{ type: "put", key: b("a"), value: b("1") }, { type: "del", key: b("b") }] },
    ]);

    expect(await db.put(b("c"), b("2"))).toBe(2);
    expect(seqs(events)).toEqual([1, 2]);
    expect(await db.delete(b("c"))).toBe(3);
    expect(seqs(events)).toEqual([1, 2, 3]);
    await db.update([b("a")], ([cur], tx) => tx.put(b("a"), cur!));
    expect(seqs(events)).toEqual([1, 2, 3, 4]);
    expect(await db.batch(() => {}), "an empty batch writes nothing").toBe(4);
    expect(seqs(events)).toEqual([1, 2, 3, 4]);

    await db.ingest();
    expect(events.at(-1)).toEqual({ kind: "ingest", writerId: "w1" });

    await db.close();
    expect(events.at(-1)).toEqual({ kind: "closed" });
    expect(events.filter((e) => e.kind === "closed")).toHaveLength(1);
  });

  it("announces another handle's write once, over BroadcastChannel or through sync()", async () => {
    const a = await track(open("wa"));
    const bus = await track(open("wb"));
    const nobus = await track(openWithoutBus("wc"));
    const onBus = record(bus);
    const onNobus = record(nobus);
    const arrived = until(bus, (e) => e.kind === "append");

    const seq = await a.put(b("k"), b("v"));
    const event = { kind: "append", seq, ops: [{ type: "put", key: b("k"), value: b("v") }] };
    await arrived;
    expect(onBus).toEqual([event]);
    expect(onNobus).toEqual([]);

    await nobus.sync();
    expect(onNobus).toEqual([event]);
    await bus.sync();
    expect(onBus, "a record already applied is not announced again").toEqual([event]);
  });

  it("announces every seq once on each handle, in order, readable when announced, under interleaved writers", async () => {
    const one = await track(open("w1"));
    const two = await track(openWithoutBus("w2"));
    const handles = [one, two];
    const reads: { seq: number; want: Uint8Array | undefined; got: Promise<Uint8Array | undefined> }[] = [];
    const logs = handles.map((db) => {
      const events = record(db);
      db.changes((e) => {
        if (e.kind !== "append") return;
        for (const op of e.ops) {
          const want = op.type === "put" ? op.value : undefined;
          reads.push({ seq: e.seq, want, got: db.get(op.key) });
        }
      });
      return events;
    });

    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      const db = handles[i % 2]!;
      const key = b(`k${i}`);
      if (i % 5 === 4) writes.push(db.update([key], (_, tx) => tx.put(key, b(`u${i}`))));
      else if (i % 7 === 6) writes.push(db.delete(key));
      else writes.push(db.put(key, b(`p${i}`)));
    }
    await Promise.all(writes);
    await Promise.all(handles.map((db) => db.sync()));
    for (const read of reads) expect(await read.got, `seq ${read.seq} readable when announced`).toEqual(read.want);

    const all = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(seqs(logs[0]!)).toEqual(all);
    expect(seqs(logs[1]!)).toEqual(all);
    expect(appends(logs[0]!)).toEqual(appends(logs[1]!));
  });

  it("a handle that falls behind a flush gets one gap, then reads what the writer reads", async () => {
    const writer = await track(open("wa"));
    const behind = await track(openWithoutBus("wb"));
    await writer.put(b("x"), b("0"));
    await behind.sync();
    const events = record(behind);

    await writer.delete(b("x"));
    await writer.put(b("y"), b("1"));
    await writer.ingest();
    const after = await writer.put(b("z"), b("2"));
    await behind.sync();

    expect(events).toEqual([
      { kind: "gap", through: after - 1 },
      { kind: "append", seq: after, ops: [{ type: "put", key: b("z"), value: b("2") }] },
    ]);
    expect(await collect(behind.range())).toEqual(await collect(writer.range()));
  });
});
