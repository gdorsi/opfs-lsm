import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const NAME = "public-api";
const enc = new TextEncoder();
const dec = new TextDecoder();

type Api = {
  openDb: typeof import("@opfs-lsm/kv").openDb;
  ClosedError: typeof import("@opfs-lsm/kv").ClosedError;
  MemoryFs: typeof import("@opfs-lsm/kv").MemoryFs;
  __resetMemoryFsForTests: typeof import("@opfs-lsm/kv").__resetMemoryFsForTests;
};

let api: Api;
let closeDb: (() => Promise<void>) | undefined;

function exportFile(spec: string): string {
  const href = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "console.log(import.meta.resolve(process.argv[1], process.argv[2]))",
      spec,
      import.meta.url,
    ],
    { encoding: "utf8" },
  ).trim();
  return fileURLToPath(href);
}

function wipe(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeAll(async () => {
  const entry = exportFile("@opfs-lsm/kv");
  expect(entry.endsWith("/dist/index.js")).toBe(true);
  expect(existsSync(entry)).toBe(true);
  api = (await import(entry)) as Api;
});

afterEach(async () => {
  await closeDb?.();
  closeDb = undefined;
  api?.__resetMemoryFsForTests(NAME);
  await wipe();
});

describe("public API", () => {
  it("resolves the SharedWorker export from the package exports map", () => {
    const worker = exportFile("@opfs-lsm/kv/shared-worker");
    expect(existsSync(worker)).toBe(true);
    expect(worker.endsWith("/dist/host/shared-worker.js")).toBe(true);
  });

  it("runs put, get, batch, transaction, view, changes, ingest, and close", async () => {
    const fs = new api.MemoryFs();
    const db = await api.openDb({
      name: NAME,
      fs,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: {
        maxBatches: 1_000_000_000,
        maxDelayMs: 60_000,
        maxBytes: 1 << 30,
      },
    });
    closeDb = () => db.close();

    const kinds: string[] = [];
    const stop = db.changes((event) => {
      kinds.push(event.kind);
    });

    await db.put(enc.encode("a"), enc.encode("1"));
    expect(dec.decode((await db.get(enc.encode("a")))!)).toBe("1");

    await db.batch((tx) => {
      tx.put(enc.encode("b"), enc.encode("2"));
    });
    expect(dec.decode((await db.get(enc.encode("b")))!)).toBe("2");

    await db.transaction(async (tx) => {
      const cur = await tx.get(enc.encode("a"));
      tx.put(enc.encode("a"), enc.encode(`${dec.decode(cur!)}!`));
    });
    expect(dec.decode((await db.get(enc.encode("a")))!)).toBe("1!");

    const viewed = await db.view(async (snap) =>
      dec.decode((await snap.get(enc.encode("b")))!),
    );
    expect(viewed).toBe("2");

    const ingested = await db.ingest();
    expect(ingested.generation).toBeGreaterThan(0);
    expect(kinds).toContain("append");
    expect(kinds).toContain("ingest");
    stop();

    await db.close();
    closeDb = undefined;
    await expect(db.get(enc.encode("a"))).rejects.toBeInstanceOf(api.ClosedError);
  });
});
