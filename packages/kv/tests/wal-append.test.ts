import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangeEvent, Db } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "wal-append-test";
const enc = new TextEncoder();
const dec = new TextDecoder();
const text = (v: Uint8Array | undefined) => (v ? dec.decode(v) : undefined);

/** Every Db a test opened, closed after it even when it fails: an open one stays a live tab. */
const opened: Db[] = [];
async function open(writerId: string): Promise<Db> {
  const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId, ingestPolicy: { maxWalBytes: 1 << 30 } });
  opened.push(db);
  return db;
}

beforeEach(() => {
  __resetMemoryFsForTests(NAME);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
  __resetMemoryFsForTests(NAME);
});

describe("blind writes", () => {
  it("continue the seqs past the committed generation's through", async () => {
    const w0 = await open("w0");
    for (let i = 0; i < 50; i++) await w0.put(enc.encode(`k${i}`), enc.encode("x"));
    await w0.ingest();
    await w0.close();

    const db = await open("w1");
    const seqs: number[] = [];
    db.changes((e: ChangeEvent) => {
      if (e.kind === "append") seqs.push(e.seq!);
    });
    await db.put(enc.encode("a"), enc.encode("1"));
    await db.put(enc.encode("b"), enc.encode("2"));
    // The only open tab: each write is stable at its ack, so its event carries the seq.
    expect(seqs).toEqual([51, 52]);
    await db.close();

    const reopened = await open("w2");
    expect(text(await reopened.get(enc.encode("a")))).toBe("1");
    expect(text(await reopened.get(enc.encode("b")))).toBe("2");
    expect(text(await reopened.get(enc.encode("k49")))).toBe("x");
  });

  it("read their own write at the ack, and another tab's earlier write once synced", async () => {
    const one = await open("w1");
    const two = await open("w2");
    await one.put(enc.encode("first"), enc.encode("1"));
    await two.put(enc.encode("second"), enc.encode("2"));
    // Session puts: a tab reads its own write at once.
    expect(text(await two.get(enc.encode("second")))).toBe("2");
    // Another tab's acked write is visible after sync, and so is the reader's own.
    await two.sync();
    expect(text(await two.get(enc.encode("first")))).toBe("1");
    expect(text(await two.get(enc.encode("second")))).toBe("2");
    await one.sync();
    expect(text(await one.get(enc.encode("second")))).toBe("2");
  });
});
