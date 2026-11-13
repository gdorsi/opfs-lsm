import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent, Db, Entry } from "../src/index.js";
import { layersChannel } from "../src/locks.js";
import { openHarnessDb, __resetMemoryFsForTests, ingest } from "../src/testing.js";

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

const open = (writerId: string, rowPostMs?: number): Promise<Db> =>
  openHarnessDb({
    name: NAME,
    forceMemory: true,
    writerId,
    maxWalBytes: 1 << 30,
    ...(rowPostMs === undefined ? {} : { rowPostMs }),
  });

/** A window no test outlasts: a row that waits is posted only by a later landing or by `close`. */
const NEVER = 3_600_000;

/** The seqs of every `rows` message on the channel, one array per message. */
function tapRows(): { readonly messages: number[][]; close(): void } {
  const tap = new BroadcastChannel(layersChannel(NAME));
  const messages: number[][] = [];
  tap.onmessage = (ev: MessageEvent<{ kind: string; rows: { seq: number }[] }>) => {
    if (ev.data.kind === "rows") messages.push(ev.data.rows.map((r) => r.seq));
  };
  return { messages, close: () => tap.close() };
}

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

    await ingest(db);
    expect(seqs(events), "a flush announces nothing").toEqual([1, 2, 3, 4]);

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

  it("posts a lone row at once, and the rows that land soon after it in one message", async () => {
    const a = await open("wa", NEVER);
    const bus = await track(open("wb"));
    const onBus = record(bus);
    const tap = tapRows();
    try {
      const lone = until(bus, (e) => e.kind === "append");
      const first = await a.put(b("k0"), b("v0"));
      await lone;
      for (let i = 1; i <= 20; i++) await a.put(b(`k${i}`), b(`v${i}`));
      const rest = Array.from({ length: 20 }, (_, i) => first + 1 + i);
      const last = until(bus, (e) => e.kind === "append" && e.seq === rest.at(-1));
      expect(tap.messages).toEqual([[first]]);
      expect(seqs(onBus), "the waiting rows have reached nobody").toEqual([first]);

      await a.close();
      await last;
      await vi.waitFor(() => expect(tap.messages).toEqual([[first], rest]));
      expect(seqs(onBus)).toEqual([first, ...rest]);
      for (let i = 0; i <= 20; i++) expect(await bus.get(b(`k${i}`))).toEqual(b(`v${i}`));
    } finally {
      tap.close();
      await a.close();
    }
  });

  it("posts a waiting row once the window has passed, with no later write", async () => {
    // Long enough that the second put lands inside it, so only the timer can post its row.
    const a = await track(open("wa", 200));
    const bus = await track(open("wb"));
    const tap = tapRows();
    try {
      const first = await a.put(b("k0"), b("v0"));
      const arrived = until(bus, (e) => e.kind === "append" && e.seq === first + 1);
      await a.put(b("k1"), b("v1"));
      await arrived;
      await vi.waitFor(() => expect(tap.messages).toEqual([[first], [first + 1]]));
      expect(await bus.get(b("k1"))).toEqual(b("v1"));
    } finally {
      tap.close();
    }
  });

  it("reads a row that still waits from the WAL when a later seq arrives first, and announces it once", async () => {
    const a = await track(open("wa", NEVER));
    const c = await track(open("wc"));
    const bus = await track(open("wb"));
    const onBus = record(bus);
    const first = await a.put(b("k0"), b("v0"));
    const waiting = await a.put(b("k1"), b("v1"));
    const arrived = until(bus, (e) => e.kind === "append" && e.seq === waiting + 1);
    const later = await c.put(b("k2"), b("v2"));
    await arrived;
    expect(seqs(onBus)).toEqual([first, waiting, later]);

    // The close posts the waiting row, which `bus` already holds.
    const tap = tapRows();
    try {
      await a.close();
      await vi.waitFor(() => expect(tap.messages).toEqual([[waiting]]));
    } finally {
      tap.close();
    }
    await bus.sync();
    expect(seqs(onBus)).toEqual([first, waiting, later]);
  });

  it("reads the WAL when a message skips a seq, and announces every seq once, in order", async () => {
    const a = await open("wa", NEVER);
    const c = await open("wc", NEVER);
    const bus = await track(open("wb"));
    const onBus = record(bus);
    try {
      // Each writer's first row goes out at once. The later ones wait: 3 and 5 with `a`, 4 with `c`.
      const s1 = await a.put(b("a0"), b("1"));
      const s2 = await c.put(b("c0"), b("2"));
      const s3 = await a.put(b("a1"), b("3"));
      const s4 = await c.put(b("c1"), b("4"));
      const s5 = await a.put(b("a2"), b("5"));
      expect([s1, s2, s3, s4, s5]).toEqual([s1, s1 + 1, s1 + 2, s1 + 3, s1 + 4]);
      await vi.waitFor(() => expect(seqs(onBus)).toEqual([s1, s2]));

      // `a` posts [3, 5]: 3 applies, 5 does not follow it, and the catch-up reads 4 and 5.
      const tap = tapRows();
      const caughtUp = until(bus, (e) => e.kind === "append" && e.seq === s5);
      await a.close();
      await caughtUp;
      await vi.waitFor(() => expect(tap.messages).toEqual([[s3, s5]]));
      expect(seqs(onBus)).toEqual([s1, s2, s3, s4, s5]);

      // `c` posts [4], which `bus` already holds.
      await c.close();
      await vi.waitFor(() => expect(tap.messages).toEqual([[s3, s5], [s4]]));
      tap.close();
      await bus.sync();
      expect(seqs(onBus)).toEqual([s1, s2, s3, s4, s5]);
      expect(await bus.get(b("c1"))).toEqual(b("4"));
    } finally {
      await a.close();
      await c.close();
    }
  });

  it("ignores the rows of a message that a flush already covered", async () => {
    const a = await open("wa", NEVER);
    const bus = await track(open("wb"));
    try {
      const first = await a.put(b("k0"), b("v0"));
      await a.put(b("k1"), b("v1"));
      const last = await a.put(b("k2"), b("v2"));
      await ingest(a);
      await bus.sync();
      const onBus = record(bus);
      const tap = tapRows();
      await a.close();
      await vi.waitFor(() => expect(tap.messages).toEqual([[first + 1, last]]));
      tap.close();
      await bus.sync();
      expect(onBus).toEqual([]);
      for (let i = 0; i < 3; i++) expect(await bus.get(b(`k${i}`))).toEqual(b(`v${i}`));
    } finally {
      await a.close();
    }
  });

  it("posts every row at once from a hidden page, and the waiting rows when the page becomes hidden", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", page);
    const tap = tapRows();
    try {
      const a = await track(open("wa", NEVER));
      const first = await a.put(b("k0"), b("v0"));
      await a.put(b("k1"), b("v1"));
      await vi.waitFor(() => expect(tap.messages).toEqual([[first]]));

      page.visibilityState = "hidden";
      page.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() => expect(tap.messages).toEqual([[first], [first + 1]]));

      await a.put(b("k2"), b("v2"));
      await a.put(b("k3"), b("v3"));
      await vi.waitFor(() => expect(tap.messages).toEqual([[first], [first + 1], [first + 2], [first + 3]]));
    } finally {
      tap.close();
      for (const db of opened.splice(0)) await db.close();
      vi.unstubAllGlobals();
    }
  });

  it("applies another handle's batch from BroadcastChannel, every put and delete in order, with no sync()", async () => {
    const a = await track(open("wa"));
    const bus = await track(open("wb"));
    await a.batch((tx) => {
      for (let i = 0; i < 2_000; i += 2) tx.put(b(`k${i}`), b("old"));
    });
    await bus.sync();
    const arrived = until(bus, (e) => e.kind === "append");

    await a.batch((tx) => {
      for (let i = 0; i < 2_000; i++) {
        if (i % 4 === 0) tx.delete(b(`k${i}`));
        else tx.put(b(`k${i}`), b(`v${i}`));
      }
      tx.put(b("k1"), b("last"));
    });
    await arrived;
    const want = (i: number) => (i === 1 ? "last" : i % 4 === 0 ? undefined : `v${i}`);
    for (let i = 0; i < 2_000; i++) {
      const got = await bus.get(b(`k${i}`));
      expect(got && new TextDecoder().decode(got), `k${i}`).toBe(want(i));
    }
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
    await ingest(writer);
    const after = await writer.put(b("z"), b("2"));
    await behind.sync();

    expect(events).toEqual([
      { kind: "gap", through: after - 1 },
      { kind: "append", seq: after, ops: [{ type: "put", key: b("z"), value: b("2") }] },
    ]);
    expect(await collect(behind.range())).toEqual(await collect(writer.range()));
  });
});
