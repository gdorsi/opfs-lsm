import { afterEach, describe, expect, it } from "vitest";
import { checkDbName, type CheckedKey, type CheckedValue, type DbName } from "../src/check.js";
import { Host, type HostLimits } from "../src/host/host.js";
import { layersChannel, parseGenerationNote, parseHostToPage, type HostToPage, type PageToHost } from "../src/host/protocol.js";
import type { LogId } from "../src/host/queues.js";
import { tryLock } from "../src/locks.js";
import { logLockName } from "../src/log/log-worker-boot.js";
import { QueueWriter, type SegmentStore } from "../src/log/queue-writer.js";
import { encodeOps } from "../src/log/record.js";
import type { AsyncFs } from "../src/opfs/async-fs.js";
import { MemoryFs } from "../src/opfs/memory-fs.js";
import { loadLatestGeneration, publishRun } from "../src/store/generation.js";
import { QueueFs } from "./sim/queue-fs.js";

const enc = new TextEncoder();
let dbCount = 0;
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const body = (key: string, bytes = 8): Uint8Array =>
  encodeOps([{ type: "put", key: enc.encode(key) as CheckedKey, value: new Uint8Array(bytes) as CheckedValue }]);

/** A page as the host sees it: requests over a MessageChannel, and a `flush` answer it can be told to give or withhold. */
class TestPage {
  private nextId = 1;
  private readonly waiting = new Map<number, (msg: HostToPage) => void>();
  readonly flushes: HostToPage[] = [];
  onFlush: ((msg: Extract<HostToPage, { t: "flush" }>) => Promise<void> | void) | "silent" = () => undefined;
  private readonly port: MessagePort;

  constructor(host: Host) {
    const channel = new MessageChannel();
    this.port = channel.port1;
    cleanup.push(host.serve(channel.port2), () => channel.port1.close());
    this.port.onmessage = (ev) => {
      const msg = parseHostToPage(ev.data);
      if (!msg) throw new Error(`unparsed ${JSON.stringify(ev.data)}`);
      if (msg.t === "flush") {
        this.flushes.push(msg);
        if (this.onFlush === "silent") return;
        void Promise.resolve(this.onFlush(msg)).then(() => this.send({ t: "flushed", id: msg.id }));
        return;
      }
      this.waiting.get(msg.id)?.(msg);
    };
  }

  send(msg: PageToHost): void {
    this.port.postMessage(msg);
  }

  request(make: (id: number) => PageToHost): Promise<HostToPage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.send(make(id));
    });
  }

  async generation(make: (id: number) => PageToHost): Promise<number> {
    const reply = await this.request(make);
    if (reply.t !== "done") throw new Error(`expected done, got ${JSON.stringify(reply)}`);
    return reply.generation;
  }
}

/** A log written the way a dedicated WebWorker writes it: holding its lock, through a real `QueueWriter`. */
async function openLog(db: DbName, segments: SegmentStore, log: LogId, segmentBytes = 1 << 20): Promise<{ w: QueueWriter; release: () => void }> {
  const release = await tryLock(logLockName(db, log));
  if (!release) throw new Error(`${log} is locked`);
  return { w: await QueueWriter.open(segments, log, { segmentBytes }), release };
}

function setup(fs: AsyncFs, limits: Partial<HostLimits> = {}): { db: DbName; host: Host; notes: number[] } {
  const db = checkDbName(`host-${process.pid}-${++dbCount}`);
  const host = new Host(() => fs, { maxLatencyMs: 50, ...limits });
  const notes: number[] = [];
  const bus = new BroadcastChannel(layersChannel(db));
  bus.onmessage = (ev) => {
    const note = parseGenerationNote(ev.data);
    if (note) notes.push(note.generation);
  };
  cleanup.push(() => bus.close());
  return { db, host, notes };
}

const log = (n: number): LogId => n.toString(16).padStart(16, "0") as LogId;
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  for (const end = Date.now() + ms; !(await ok()); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

describe("Host", () => {
  it("answers attach with the newest manifest, and refuses a manifest that does not decode", async () => {
    const fs = new MemoryFs();
    const { db, host } = setup(fs);
    const page = new TestPage(host);
    expect(await page.generation((id) => ({ t: "attach", id, db }))).toBe(0);

    await publishRun(fs, "m/0000000000000007.mft", new Uint8Array([1, 2, 3]));
    const other = new TestPage(host);
    expect(await other.request((id) => ({ t: "attach", id, db }))).toMatchObject({ t: "failed", code: "corrupt" });
  });

  it("ingests at once past batchBytes, and after maxLatencyMs below it", async () => {
    const fs = new MemoryFs();
    const { db, host, notes } = setup(fs, { batchBytes: 100, maxLatencyMs: 200 });
    const page = new TestPage(host);
    await page.generation((id) => ({ t: "attach", id, db }));
    const { w } = await openLog(db, fs.segments, log(1));

    const small = body("a", 4);
    await w.append([small]);
    page.send({ t: "durable", log: log(1), n: 1, bytes: small.byteLength });
    await tick(50);
    expect(notes, "a small hint waits for the timer").toEqual([]);
    await until("the timer's ingest", () => notes.length === 1);

    const big = body("b", 200);
    await w.append([big]);
    const at = Date.now();
    page.send({ t: "durable", log: log(1), n: 2, bytes: small.byteLength + big.byteLength });
    await until("the batch's ingest", () => notes.length === 2);
    expect(Date.now() - at, "a hint past batchBytes does not wait for the timer").toBeLessThan(150);
    expect((await loadLatestGeneration(fs))?.queues).toEqual([{ log: log(1), state: "open", n: 2 }]);
  });

  it("syncs through what the other pages flush, and stops waiting for a silent page after 500 ms", async () => {
    const fs = new MemoryFs();
    const { db, host } = setup(fs, { maxLatencyMs: 60_000 });
    const asker = new TestPage(host);
    const writer = new TestPage(host);
    const silent = new TestPage(host);
    for (const p of [asker, writer, silent]) await p.generation((id) => ({ t: "attach", id, db }));
    silent.onFlush = "silent";

    const { w } = await openLog(db, fs.segments, log(2));
    await w.append([body("k")]);
    writer.onFlush = async () => {
      await w.flush();
      writer.send({ t: "durable", log: log(2), n: 1, bytes: 1 });
    };
    const before = asker.flushes.length;
    const at = Date.now();
    const generation = await asker.generation((id) => ({ t: "sync", id }));
    expect(Date.now() - at).toBeGreaterThanOrEqual(450);
    expect(generation).toBe(1);
    expect((await loadLatestGeneration(fs))?.queues).toEqual([{ log: log(2), state: "open", n: 1 }]);
    expect(asker.flushes.length, "the asker flushed before it asked").toBe(before);
  });

  it("reads a closed page's log to its end once its lock is free", async () => {
    const fs = new MemoryFs();
    const { db, host, notes } = setup(fs);
    const page = new TestPage(host);
    await page.generation((id) => ({ t: "attach", id, db }));
    const { w, release } = await openLog(db, fs.segments, log(3));
    for (const k of ["a", "b", "c"]) await w.append([body(k)]);
    await w.close();
    release();
    page.send({ t: "detach" });
    await until("the dead log's ingest", () => notes.length > 0);
    expect((await loadLatestGeneration(fs))?.queues).toEqual([{ log: log(3), state: "final", n: 3 }]);
  });

  it("stops at a full L0 until a compaction pass, and goes past it when the pass installs nothing", async () => {
    const fs = new MemoryFs();
    const { db, host } = setup(fs, { l0StopRuns: 1 });
    const page = new TestPage(host);
    await page.generation((id) => ({ t: "attach", id, db }));
    const { w } = await openLog(db, fs.segments, log(4));
    for (let n = 1; n <= 2; n++) {
      await w.append([body(`k${n}`)]);
      await w.flush();
      page.send({ t: "durable", log: log(4), n, bytes: n });
      await page.generation((id) => ({ t: "sync", id }));
    }
    const stats = await page.request((id) => ({ t: "stats", id }));
    expect(stats).toMatchObject({ t: "stats", stats: { flushes: 2, l0Stops: 1 } });
    expect((await loadLatestGeneration(fs))?.queues).toEqual([{ log: log(4), state: "open", n: 2 }]);
  });

  it("asks the page to rotate a log Chrome will not let it read, then reads the sealed segment", async () => {
    const fs = new QueueFs("chrome");
    const { db, host } = setup(fs, { maxLatencyMs: 60_000 });
    const asker = new TestPage(host);
    const writer = new TestPage(host);
    for (const p of [asker, writer]) await p.generation((id) => ({ t: "attach", id, db }));
    const { w } = await openLog(db, fs.segments, log(5));
    await w.append([body("k")]);
    await w.flush();
    writer.send({ t: "durable", log: log(5), n: 1, bytes: 1 });
    writer.onFlush = async (msg) => {
      if (msg.rotate.includes(log(5))) await w.rotate();
    };

    expect(await asker.generation((id) => ({ t: "sync", id }))).toBe(1);
    expect(writer.flushes.map((m) => m.t === "flush" && m.rotate)).toEqual([[], [log(5)]]);
    expect((await loadLatestGeneration(fs))?.queues).toEqual([{ log: log(5), state: "open", n: 1 }]);
  });
});
