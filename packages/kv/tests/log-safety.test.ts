import { describe, expect, it } from "vitest";
import { checkBatch } from "../src/check.js";
import { encodeOps, segmentPath } from "../src/log/frame.js";
import type { TabLogClient } from "../src/log/client.js";
import { LogSession } from "../src/log/session.js";
import { TabWriter, type SegmentStore } from "../src/log/tab-writer.js";
import { MemoryFs } from "../src/index.js";
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
