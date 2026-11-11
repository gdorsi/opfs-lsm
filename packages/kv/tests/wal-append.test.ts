import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent } from "../src/index.js";
import { openHarnessDb, readStats, __resetMemoryFsForTests } from "../src/testing.js";

const NAME = "wal-append-test";
const IDB = `opfs-lsm-wal/${NAME}`;
const enc = new TextEncoder();
const dec = new TextDecoder();
const text = (v: Uint8Array | undefined) => (v ? dec.decode(v) : undefined);

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(IDB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function setMeta(values: Record<string, number>): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("meta", "readwrite");
      for (const [key, value] of Object.entries(values)) tx.objectStore("meta").put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

const open = (writerId: string) =>
  openHarnessDb({ name: NAME, forceMemory: true, writerId, ingestPolicy: { maxWalBytes: 1 << 30 } });

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

afterEach(() => {
  __resetMemoryFsForTests(NAME);
});

describe("blind writes", () => {
  it("continue past a head the key generator has not reached", async () => {
    await (await open("w0")).close();
    await setMeta({ head: 50, ingestedThrough: 50 });

    const db = await open("w1");
    const seqs: number[] = [];
    db.changes((e: ChangeEvent) => {
      if (e.kind === "append") seqs.push(e.seq!);
    });
    await db.put(enc.encode("a"), enc.encode("1"));
    await db.put(enc.encode("b"), enc.encode("2"));
    expect(seqs).toEqual([51, 52]);
    await db.close();

    const reopened = await open("w2");
    expect(text(await reopened.get(enc.encode("a")))).toBe("1");
    expect(text(await reopened.get(enc.encode("b")))).toBe("2");
    await reopened.close();
  });

  it("read their own write and every earlier one at the ack when another tab appended first", async () => {
    const one = await open("w1");
    const two = await open("w2");
    await one.put(enc.encode("first"), enc.encode("1"));
    await two.put(enc.encode("second"), enc.encode("2"));
    expect(text(await two.get(enc.encode("second")))).toBe("2");
    expect(text(await two.get(enc.encode("first")))).toBe("1");
    await one.close();
    await two.close();
  });
});

describe("group commit", () => {
  it("writes overlapping appends in one transaction, one seq each, landing in seq order", async () => {
    const db = await open("w0");
    const landed: number[] = [];
    db.changes((e: ChangeEvent) => {
      if (e.kind === "append") landed.push(e.seq!);
    });
    const before = await readStats(db);
    const acks = await Promise.all(
      Array.from({ length: 6 }, (_, i) => db.put(enc.encode(`k${i}`), enc.encode(`v${i}`))),
    );
    const after = await readStats(db);
    // The first append opens a transaction at once. The other five queue behind it.
    expect(after.tab.walAppends - before.tab.walAppends).toBe(6);
    expect(after.tab.walCommits - before.tab.walCommits).toBe(2);
    expect(acks).toEqual([1, 2, 3, 4, 5, 6]);
    expect(landed).toEqual(acks);
    for (let i = 0; i < 6; i++) expect(text(await db.get(enc.encode(`k${i}`)))).toBe(`v${i}`);
    await db.close();
  });

  it("falls back to an explicit key for every append of a stale group", async () => {
    await (await open("w0")).close();
    await setMeta({ head: 50, ingestedThrough: 50 });
    const db = await open("w1");
    const seqs = await Promise.all(
      Array.from({ length: 4 }, (_, i) => db.put(enc.encode(`k${i}`), enc.encode(`v${i}`))),
    );
    expect(seqs).toEqual([51, 52, 53, 54]);
    await db.close();
    const reopened = await open("w2");
    for (let i = 0; i < 4; i++) expect(text(await reopened.get(enc.encode(`k${i}`)))).toBe(`v${i}`);
    await reopened.close();
  });

  it("rejects every append of a group that aborts and consumes no seq", async () => {
    const db = await open("w0");
    await db.put(enc.encode("a"), enc.encode("1"));
    const add = IDBObjectStore.prototype.add;
    let calls = 0;
    const spy = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["add"]>
    ) {
      // Put "a" and b0 each ran alone. Fail the second add of the group b1..b3 share.
      calls += 1;
      if (calls === 4) throw new Error("injected");
      return add.apply(this, args);
    });
    const writes = Array.from({ length: 4 }, (_, i) =>
      db.put(enc.encode(`b${i}`), enc.encode("x")).then(
        () => "ok",
        (err: Error) => err.message,
      ),
    );
    const results = await Promise.all(writes);
    spy.mockRestore();
    // Put 0 left alone in its own transaction, puts 1..3 shared the group that failed.
    expect(results).toEqual(["ok", "injected", "injected", "injected"]);
    expect(await db.put(enc.encode("c"), enc.encode("2"))).toBe(3);
    expect(text(await db.get(enc.encode("b1")))).toBeUndefined();
    await db.close();
    const reopened = await open("w1");
    expect(text(await reopened.get(enc.encode("c")))).toBe("2");
    expect(text(await reopened.get(enc.encode("b0")))).toBe("x");
    await reopened.close();
  });
});
