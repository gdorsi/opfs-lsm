import type { Db } from "../dist/index.js";
import { formatMs, summarize } from "./stats.ts";

const out = document.getElementById("out")!;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const params = new URLSearchParams(location.search);
const ROWS = Number(params.get("n") ?? 130_000);
const BATCH = Number(params.get("batch") ?? 1000);
const VALUE_BYTES = Number(params.get("val") ?? 16);
const STEPS = Number(params.get("steps") ?? 10);
const AUTO = params.has("auto");
const NAME = "bench-batch";

function log(line: string): void {
  out.textContent += line + "\n";
}

async function report(payload: unknown): Promise<void> {
  if (!AUTO) return;
  await fetch("/bench-results", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function resetStorage(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("opfs-lsm", { recursive: true });
  } catch {
    /* missing is fine */
  }
}

async function run(): Promise<void> {
  out.textContent = "";
  const { openHarnessDb } = await import("../dist/testing.js");
  await resetStorage();
  log(`rows=${ROWS}  batch=${BATCH} new keys  value=${VALUE_BYTES} B  no flush  isolated=${crossOriginIsolated}`);
  const enc = new TextEncoder();
  const value = new Uint8Array(VALUE_BYTES).fill(7);
  const db: Db = await openHarnessDb({
    name: NAME,
    ingestPolicy: { maxWalBytes: 2 ** 40 },
  });
  const batches = Math.floor(ROWS / BATCH);
  const perStep = Math.max(1, Math.floor(batches / STEPS));
  let samples: number[] = [];
  for (let b = 0; b < batches; b++) {
    const t = performance.now();
    await db.batch((tx) => {
      for (let j = 0; j < BATCH; j++) {
        const k = (Math.imul(b * BATCH + j, 2654435761) >>> 0) % 1e9;
        tx.put(enc.encode(`user:${String(k).padStart(10, "0")}`), value);
      }
    });
    samples.push(performance.now() - t);
    if ((b + 1) % perStep === 0) {
      log(formatMs(summarize(`at ${(b + 1) * BATCH} rows`, samples)));
      samples = [];
    }
  }
  await db.close();
  await report({ rows: ROWS, log: out.textContent });
}

runBtn.addEventListener("click", () => {
  runBtn.disabled = true;
  void run().finally(() => {
    runBtn.disabled = false;
  });
});

if (AUTO) {
  runBtn.disabled = true;
  void run().catch(async (err) => {
    const e = err as Error;
    log(`batch FAILED: ${e?.stack || err}`);
    await report({ error: String(e?.stack || err), log: out.textContent });
  });
}
