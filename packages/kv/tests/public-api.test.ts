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
};

type TestingApi = {
  openHarnessDb: typeof import("@opfs-lsm/kv/testing").openHarnessDb;
  __resetMemoryFsForTests: typeof import("@opfs-lsm/kv/testing").__resetMemoryFsForTests;
  MemoryFs: typeof import("@opfs-lsm/kv/testing").MemoryFs;
};

let api: Api;
let testing: TestingApi;
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

beforeAll(async () => {
  const entry = exportFile("@opfs-lsm/kv");
  expect(entry.endsWith("/dist/index.js")).toBe(true);
  expect(existsSync(entry)).toBe(true);
  api = (await import(entry)) as Api;
  const testingEntry = exportFile("@opfs-lsm/kv/testing");
  expect(testingEntry.endsWith("/dist/testing.js")).toBe(true);
  testing = (await import(testingEntry)) as TestingApi;
});

afterEach(async () => {
  await closeDb?.();
  closeDb = undefined;
  testing?.__resetMemoryFsForTests(NAME);
});

describe("public API", () => {
  it("resolves the SharedWorker and testing exports from the package exports map", () => {
    const worker = exportFile("@opfs-lsm/kv/shared-worker");
    expect(existsSync(worker)).toBe(true);
    expect(worker.endsWith("/dist/host/shared-worker.js")).toBe(true);
    expect(typeof api.openDb).toBe("function");
  });

  it("runs put, get, batch, update, view, changes, ingest, and close", async () => {
    const fs = new testing.MemoryFs();
    const db = await testing.openHarnessDb({
      name: NAME,
      fs,
      forceMemory: true,
      writerId: "w1",
      ingestPolicy: {
        maxWalBytes: 1 << 30,
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

    await db.update([enc.encode("a")], ([cur], tx) => {
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
