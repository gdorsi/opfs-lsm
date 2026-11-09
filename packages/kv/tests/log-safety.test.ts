import { describe, expect, it } from "vitest";
import { checkBatch } from "../src/check.js";
import { encodeOps, segmentPath } from "../src/log/frame.js";
import type { TabLogClient } from "../src/log/client.js";
import { LogSession } from "../src/log/session.js";
import { TabWriter, type SegmentStore } from "../src/log/tab-writer.js";
import type { AsyncFs, Db } from "../src/index.js";
import { EngineHost, MemoryFs, createLocalIngestClient } from "../src/index.js";
import { openHarnessDb } from "../src/testing.js";
import { Traced } from "./sim/crash.js";

/**
 * Paths where a write was acked and then lost, or where the logs lost
 * records silently. Each test drives the public `Db` (or the pure merge
 * and frame code) and asserts what a caller can observe.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf = (s: string) => enc.encode(s);
const str = (b: Uint8Array | undefined) => (b ? dec.decode(b) : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uniqueName = (label: string) => `${label}-${Math.random().toString(36).slice(2)}`;

function put(key: string): Uint8Array {
  return encodeOps(checkBatch([{ type: "put", key: utf(key), value: utf(key) }]));
}

const TAB = "00000000000000aa";

type Outcome = "acked" | "rejected";
const outcome = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    () => "acked",
    () => "rejected",
  );

/** `fs` with its log segment creates parked while `park` is on. */
function parkableLogs(fs: MemoryFs) {
  let parked: (() => void)[] | undefined;
  const wrapped: AsyncFs = {
    read: (p, o, l) => fs.read(p, o, l),
    open: (p) => fs.open(p),
    list: (d) => fs.list(d),
    remove: (p) => fs.remove(p),
    removeUnlessOpen: (p) => fs.removeUnlessOpen(p),
    create: (p) => fs.create(p),
    segments: () => ({
      create: async (path) => {
        if (parked) await new Promise<void>((r) => parked!.push(r));
        return fs.segments().create(path);
      },
    }),
  };
  return {
    fs: wrapped,
    park: () => (parked = []),
    async waitParked() {
      while (!parked || parked.length === 0) await sleep(1);
    },
    resume() {
      const all = parked ?? [];
      parked = undefined;
      for (const r of all) r();
    },
  };
}

/**
 * Make the first `navigator.locks.query()` after this call answer late:
 * its snapshot is taken at call time, and the answer waits for `release`.
 */
function slowFirstLockQuery() {
  const locks = navigator.locks;
  const query = locks.query.bind(locks);
  let release: (() => void) | undefined;
  let armed = true;
  locks.query = (async () => {
    const snap = await query();
    if (armed) {
      armed = false;
      await new Promise<void>((r) => (release = r));
    }
    return snap;
  }) as typeof locks.query;
  return {
    async waitAsked() {
      while (!release) await sleep(1);
    },
    answer: () => release!(),
    restore: () => (locks.query = query as typeof locks.query),
  };
}

describe("a tab is retired only once it is dead", () => {
  it("a tab that joins while another tab's liveness query is in flight has its writes seen by that tab", async () => {
    const name = uniqueName("retire-join");
    const fs = new MemoryFs();
    const ingest = createLocalIngestClient(new EngineHost(() => fs));
    const dbs: Db[] = [await openHarnessDb({ name, fs, ingest })];
    const slow = slowFirstLockQuery();
    try {
      const bOpen = openHarnessDb({ name, fs, ingest });
      await slow.waitAsked();
      const c = await openHarnessDb({ name, fs, ingest });
      dbs.push(c);
      slow.answer();
      const b = await bOpen;
      dbs.push(b);
      await c.put(utf("k"), utf("from-c"));
      await c.sync();
      await b.sync();
      expect(str(await b.get(utf("k"))), "a write of a live tab is visible to every tab after sync").toBe("from-c");
    } finally {
      slow.restore();
      await Promise.all(dbs.map((d) => d.close()));
    }
  });

  it("an ingest by a tab whose liveness query raced a join keeps the joined tab's acked write", async () => {
    const name = uniqueName("retire-ingest");
    const fs = new MemoryFs();
    const ingest = createLocalIngestClient(new EngineHost(() => fs));
    const cLogs = parkableLogs(fs);
    const dbs: Db[] = [await openHarnessDb({ name, fs, ingest })];
    const slow = slowFirstLockQuery();
    try {
      const bOpen = openHarnessDb({ name, fs, ingest });
      await slow.waitAsked();
      const c = await openHarnessDb({ name, fs: cLogs.fs, ingest });
      dbs.push(c);
      slow.answer();
      const b = await bOpen;
      dbs.push(b);
      cLogs.park();
      const cPut = outcome(c.put(utf("c"), utf("1")));
      await cLogs.waitParked();
      await sleep(2);
      await b.put(utf("b"), utf("1"));
      const ingesting = b.ingest();
      await sleep(30);
      cLogs.resume();
      await ingesting;
      expect(await cPut, "the put of the joined tab is acked").toBe("acked");
      await c.sync();
      const fresh = await openHarnessDb({ name, fs, ingest });
      dbs.push(fresh);
      expect(str(await fresh.get(utf("c"))), "an acked write survives another tab's ingest and a reopen").toBe("1");
    } finally {
      slow.restore();
      await Promise.all(dbs.map((d) => d.close()));
    }
  });
});

describe("close", () => {
  it("a put whose log write outlasts close's wait is acked and visible, or rejected", async () => {
    const name = uniqueName("close-inflight");
    const fs = new MemoryFs();
    const ingest = createLocalIngestClient(new EngineHost(() => fs));
    const cLogs = parkableLogs(fs);
    const a = await openHarnessDb({ name, fs, ingest });
    const c = await openHarnessDb({ name, fs: cLogs.fs, ingest });
    cLogs.park();
    const cPut = outcome(c.put(utf("c"), utf("1")));
    await cLogs.waitParked();
    const closing = c.close();
    await sleep(1200);
    await a.put(utf("a"), utf("1"));
    const ingesting = a.ingest();
    await sleep(50);
    cLogs.resume();
    await ingesting;
    const got = await cPut;
    await closing;
    await a.sync();
    const fresh = await openHarnessDb({ name, fs, ingest });
    const seen = str(await fresh.get(utf("c")));
    await Promise.all([a.close(), fresh.close()]);
    expect(got !== "acked" || seen === "1", "a put acked across close is in the database").toBe(true);
  });
});

describe("a failed log write", () => {
  it("fails every later write of the tab, so none is acked behind a lost one", async () => {
    const t = new Traced(uniqueName("failed-write"));
    t.faults.kinds = new Set(["log-write"]);
    t.faults.spare = (label) => !label.startsWith("write ");
    t.faults.failAt = 1;
    const db = await t.open();
    const first = outcome(db.put(utf("a"), utf("1")));
    await Promise.resolve();
    await Promise.resolve();
    const second = outcome(db.put(utf("b"), utf("1")));
    expect(await first, "the faulted write is rejected").toBe("rejected");
    const later = await second;
    await db.close();
    t.faults.heal();
    const again = await t.open();
    const b = str(await again.get(utf("b")));
    await again.close();
    expect(t.faults.injected, "the fault fired").toBe(1);
    if (later === "acked") expect(b, "a write acked after a failed one is in the database").toBe("1");
    expect(later, "a write after a failed log write is refused").toBe("rejected");
  });
});

/**
 * A log client that answers the way the log worker does: requests in
 * order, their answers delivered together once per task, so a flush and
 * the writes sent after it resolve in one go.
 */
function workerLikeClient(): TabLogClient {
  let queue: (() => void)[] = [];
  const answer = () => {
    const due = queue;
    queue = [];
    for (const resolve of due) resolve();
  };
  const request = () =>
    new Promise<void>((resolve) => {
      if (queue.length === 0) setTimeout(answer, 0);
      queue.push(resolve);
    });
  return { append: request, flush: request, close: async () => undefined };
}

describe("the log writer", () => {
  it("refuses every write and flush after one failed, so no record lands past a gap", async () => {
    const fs = new MemoryFs();
    const inner = fs.segments();
    let failNext = true;
    const store: SegmentStore = {
      async create(path) {
        const file = await inner.create(path);
        return {
          ...file,
          write(bytes, at) {
            if (failNext) {
              failNext = false;
              throw new Error("injected write error");
            }
            return file.write(bytes, at);
          },
        };
      },
    };
    const writer = new TabWriter(store, TAB, 1 << 20);
    await expect(writer.write([{ stamp: 10, n: 1, body: put("a") }]), "the faulted write throws").rejects.toThrow("injected write error");
    await expect(writer.write([{ stamp: 20, n: 2, body: put("b") }]), "a later write throws").rejects.toThrow("injected write error");
    expect(() => writer.flush(), "a later flush throws").toThrow("injected write error");
    const bytes = await fs.read(segmentPath(TAB, { firstN: 1, prevStamp: 0 }), 0, Number.POSITIVE_INFINITY);
    expect(bytes?.byteLength ?? 0, "nothing was written after the failure").toBe(0);
  });
});

describe("ingest", () => {
  it("a stable cut is taken while the tab keeps writing", async () => {
    const session = new LogSession({
      name: uniqueName("cut-busy"),
      tab: TAB,
      fs: new MemoryFs(),
      client: workerLikeClient(),
      onStable: () => undefined,
      maxWalBytes: 1 << 30,
    });
    await session.prepareJoin();
    await session.finishJoin();
    const ops = checkBatch([{ type: "put", key: utf("k"), value: utf("v") }]);
    let writing = true;
    const writers = Array.from({ length: 4 }, async () => {
      while (writing) await session.append(ops, "w");
    });
    try {
      const cut = await Promise.race([session.stableCut(), sleep(3000).then(() => undefined)]);
      expect(cut, "stableCut returns within 3 s while writes go on").toBeTypeOf("number");
    } finally {
      writing = false;
      await Promise.all(writers);
      await session.close();
    }
  });
});
