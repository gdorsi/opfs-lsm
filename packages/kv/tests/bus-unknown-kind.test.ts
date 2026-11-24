import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/index.js";
import { __resetMemoryFsForTests, openHarnessDb } from "../src/testing.js";

const NAME = "bus-unknown-kind";
const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string) => enc.encode(s);
const s = (v: Uint8Array | undefined) => (v === undefined ? undefined : dec.decode(v));

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

const opened: Db[] = [];

async function open(writerId: string): Promise<Db> {
  const db = await openHarnessDb({ name: NAME, forceMemory: true, writerId, maxWalBytes: 1 << 30 });
  opened.push(db);
  return db;
}

/** A handle that posts nothing on the channel, so another handle learns of its writes only from the WAL. */
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

beforeEach(async () => {
  __resetMemoryFsForTests(NAME);
  await wipe();
});

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
  __resetMemoryFsForTests(NAME);
});

describe("a message on the layers channel of a kind this build does not know", () => {
  it("makes the handle catch up from the WAL, as a tab of a newer build counts on", async () => {
    const reader = await open("reader");
    const silent = await openWithoutBus("silent");
    await silent.put(b("k"), b("v"));
    expect(await reader.get(b("k")), "nothing told the reader of the write yet").toBeUndefined();

    const newer = new BroadcastChannel(`opfs-lsm-layers/${NAME}`);
    try {
      newer.postMessage({ kind: "a-kind-of-a-later-build", detail: [1, 2, 3] });
      await vi.waitFor(async () => expect(s(await reader.get(b("k")))).toBe("v"), { timeout: 5_000 });
    } finally {
      newer.close();
    }
  });
});
