/**
 * Microbench: @opfs-lsm/kv vs raw IndexedDB vs Dexie (Node + fake-indexeddb).
 * Not a browser OPFS measurement — relative ack-path cost only.
 *
 *   pnpm bench
 */
import "fake-indexeddb/auto";
import { performance } from "node:perf_hooks";
import type { Db } from "../src/index.ts";

const N = Number(process.env.BENCH_N ?? 500);
const enc = new TextEncoder();

async function time(label: string, fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  console.log(
    `${label.padEnd(28)} ${ms.toFixed(1)} ms  (${(N / (ms / 1000)).toFixed(0)} ops/s)`,
  );
  return ms;
}

async function resetIdb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

async function benchKv(): Promise<void> {
  const { openDb, __resetMemoryFsForTests, MemoryFs } = await import(
    "../src/index.ts"
  );
  await resetIdb("opfs-lsm-wal/bench-kv");
  __resetMemoryFsForTests("bench-kv");
  const fs = new MemoryFs();
  const db: Db = await openDb({
    name: "bench-kv",
    writerId: "bench",
    fs,
    forceMemory: true,
    ingestPolicy: { maxBatches: 1e9, maxDelayMs: 60_000, maxBytes: 1 << 30 },
  });
  await time("kv solitary put", async () => {
    for (let i = 0; i < N; i++) {
      await db.put(enc.encode(`k${i}`), enc.encode(`v${i}`));
    }
  });
  await time("kv one batch", async () => {
    await db.batch((tx) => {
      for (let i = 0; i < N; i++) {
        tx.put(enc.encode(`b${i}`), enc.encode(`v${i}`));
      }
    });
  });
  await time("kv point get", async () => {
    for (let i = 0; i < N; i++) {
      await db.get(enc.encode(`k${i}`));
    }
  });
  await db.close();
}

async function benchRawIdb(): Promise<void> {
  await resetIdb("bench-raw");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("bench-raw", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await time("idb solitary put", async () => {
    for (let i = 0; i < N; i++) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(`v${i}`, `k${i}`);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  });
  await time("idb one transaction", async () => {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      const store = tx.objectStore("kv");
      for (let i = 0; i < N; i++) store.put(`v${i}`, `b${i}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
  db.close();
}

async function benchDexie(): Promise<void> {
  type DexieCtor = new (name: string) => {
    version(n: number): { stores(s: Record<string, string>): unknown };
    open(): Promise<unknown>;
    close(): Promise<void> | void;
    kv: {
      put(row: { key: string; value: string }): Promise<unknown>;
      bulkPut(rows: Array<{ key: string; value: string }>): Promise<unknown>;
    };
  };
  let Dexie: DexieCtor;
  try {
    ({ default: Dexie } = (await import("dexie")) as { default: DexieCtor });
  } catch {
    console.log("(dexie not installed — skip; pnpm add -D dexie --filter @opfs-lsm/kv)");
    return;
  }
  await resetIdb("bench-dexie");
  const db = new Dexie("bench-dexie");
  db.version(1).stores({ kv: "key" });
  await db.open();
  await time("dexie solitary put", async () => {
    for (let i = 0; i < N; i++) {
      await db.kv.put({ key: `k${i}`, value: `v${i}` });
    }
  });
  await time("dexie bulkPut", async () => {
    await db.kv.bulkPut(
      Array.from({ length: N }, (_, i) => ({ key: `b${i}`, value: `v${i}` })),
    );
  });
  await db.close();
}

console.log(`N=${N}  (fake-indexeddb / Node — not OPFS)\n`);
await benchKv();
await benchRawIdb();
await benchDexie();
