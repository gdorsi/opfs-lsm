import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangeEvent } from "../src/index.js";
import { openHarnessDb, __resetMemoryFsForTests } from "../src/testing.js";

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
  openHarnessDb({ name: NAME, forceMemory: true, writerId, maxWalBytes: 1 << 30 });

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

describe("keys and values", () => {
  it("rejects a key or a value whose buffer was detached, and stores empty ones", async () => {
    const db = await open("w1");
    const detached = () => {
      const bytes = enc.encode("gone");
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      return bytes;
    };
    await expect(db.put(detached(), enc.encode("v"))).rejects.toThrow("key buffer is detached");
    await expect(db.put(enc.encode("k"), detached())).rejects.toThrow("value buffer is detached");
    await db.put(new Uint8Array(0), new Uint8Array(0));
    expect(await db.get(new Uint8Array(0))).toEqual(new Uint8Array(0));
    expect(await db.get(enc.encode("k"))).toBeUndefined();
    await db.close();
  });
});
