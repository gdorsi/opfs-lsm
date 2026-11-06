import type { Db } from "../dist/index.js";
import type { HarnessOpenOptions } from "../dist/testing.js";

const out = document.getElementById("out")!;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const params = new URLSearchParams(location.search);
const N = Number(params.get("n") ?? 200);
const AUTO = params.has("auto");
/** SharedWorker path (default) or in-page EngineHost (`?local=1`). */
const LOCAL = params.has("local");

type BenchRow = { label: string; ms: number; ops: number };

function log(line: string): void {
  out.textContent += line + "\n";
  if (AUTO) void fetch("/bench-progress", { method: "POST", body: line }).catch(() => {});
}

async function report(payload: unknown): Promise<void> {
  if (!AUTO) return;
  try {
    await fetch("/bench-results", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("report failed", err);
  }
}

function sameBytes(got: Uint8Array | undefined, expected: Uint8Array): boolean {
  if (!got || got.byteLength !== expected.byteLength) return false;
  for (let i = 0; i < expected.byteLength; i += 1) {
    if (got[i] !== expected[i]) return false;
  }
  return true;
}

async function time(label: string, fn: () => Promise<void>): Promise<BenchRow> {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  const ops = Number((N / (ms / 1000)).toFixed(0));
  const row = `${label.padEnd(28)} ${ms.toFixed(1)} ms  (${ops} ops/s)`;
  log(row);
  return { label, ms, ops };
}

async function resetIdb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

async function clearOpfs(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("opfs-lsm", { recursive: true });
  } catch {
    /* missing is fine */
  }
}

async function benchKv(): Promise<BenchRow[]> {
  const mod = await import("../dist/index.js");
  const { openHarnessDb } = await import("../dist/testing.js");
  const {
    openBrowserFs,
    EngineHost,
    createLocalIngestClient,
  } = mod;
  await resetIdb("opfs-lsm-wal/bench-opfs");
  await clearOpfs();
  const enc = new TextEncoder();

  let opts: HarnessOpenOptions = {
    name: "bench-opfs",
    writerId: "bench",
    ingestPolicy: { maxWalBytes: 1 << 30 },
  };

  if (LOCAL) {
    const fs = await openBrowserFs("bench-opfs");
    const host = new EngineHost(() => fs);
    opts = {
      ...opts,
      fs,
      ingest: createLocalIngestClient(host),
    };
    log("mode=local EngineHost + BrowserFs (OPFS)");
  } else {
    log("mode=SharedWorker + BrowserFs (OPFS)");
  }

  const db: Db = await openHarnessDb(opts);
  const rows: BenchRow[] = [];
  rows.push(
    await time("kv solitary put", async () => {
      for (let i = 0; i < N; i++) {
        await db.put(enc.encode(`k${i}`), enc.encode(`v${i}`));
      }
    }),
  );
  rows.push(
    await time("kv one batch", async () => {
      await db.batch((tx) => {
        for (let i = 0; i < N; i++) {
          tx.put(enc.encode(`b${i}`), enc.encode(`v${i}`));
        }
      });
    }),
  );
  rows.push(
    await time("kv point get (warm)", async () => {
      for (let i = 0; i < N; i++) {
        const got = await db.get(enc.encode(`k${i}`));
        if (!sameBytes(got, enc.encode(`v${i}`))) {
          throw new Error(`warm get missing k${i}`);
        }
      }
    }),
  );
  rows.push(
    await time("kv ingest → OPFS", async () => {
      await db.ingest();
    }),
  );
  rows.push(
    await time("kv point get (post-ingest)", async () => {
      for (let i = 0; i < N; i++) {
        const got = await db.get(enc.encode(`k${i}`));
        if (!sameBytes(got, enc.encode(`v${i}`))) {
          throw new Error(`post-ingest get missing k${i}`);
        }
      }
    }),
  );
  await db.close();
  return rows;
}

async function benchDexie(): Promise<BenchRow[]> {
  // Dexie ships an ESM build under this path (third-party; not our source).
  const { default: Dexie } = await import(
    "../node_modules/dexie/dist/dexie.mjs"
  );
  await resetIdb("bench-dexie-opfs");
  const db = new Dexie("bench-dexie-opfs");
  db.version(1).stores({ kv: "key" });
  await db.open();
  const rows: BenchRow[] = [];
  rows.push(
    await time("dexie solitary put", async () => {
      for (let i = 0; i < N; i++) {
        await db.table("kv").put({ key: `k${i}`, value: `v${i}` });
      }
    }),
  );
  rows.push(
    await time("dexie bulkPut", async () => {
      await db.table("kv").bulkPut(
        Array.from({ length: N }, (_, i) => ({
          key: `b${i}`,
          value: `v${i}`,
        })),
      );
    }),
  );
  rows.push(
    await time("dexie point get", async () => {
      for (let i = 0; i < N; i++) {
        const row = await db.table("kv").get(`k${i}`);
        if (row?.value !== `v${i}`) {
          throw new Error(`dexie point get missing k${i}`);
        }
      }
    }),
  );
  await db.close();
  return rows;
}

async function run(): Promise<void> {
  out.textContent = "";
  log(`N=${N}  origin=${location.origin}`);
  log(
    `OPFS=${!!navigator.storage?.getDirectory}  SharedWorker=${typeof SharedWorker !== "undefined"}`,
  );
  log("");
  let results: BenchRow[] = [];
  try {
    results = results.concat(await benchKv());
  } catch (err) {
    const e = err as Error;
    log(`kv FAILED: ${e?.stack || err}`);
    await report({ error: String(e?.stack || err), log: out.textContent });
    throw err;
  }
  log("");
  try {
    results = results.concat(await benchDexie());
  } catch (err) {
    const e = err as Error;
    log(`dexie FAILED: ${e?.stack || err}`);
  }
  await report({ n: N, results, log: out.textContent });
}

runBtn.addEventListener("click", () => {
  runBtn.disabled = true;
  void run().finally(() => {
    runBtn.disabled = false;
  });
});

if (AUTO) {
  runBtn.disabled = true;
  void run().catch((err) => {
    console.error(err);
  });
}
