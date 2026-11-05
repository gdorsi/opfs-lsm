import type { Db } from "../dist/index.js";

const out = document.getElementById("out")!;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const params = new URLSearchParams(location.search);
const N = Number(params.get("n") ?? 100_000);
const VALUE_BYTES = Number(params.get("val") ?? 1024);
const AUTO = params.has("auto");
/** Raise to keep the memtable large, e.g. `maxBatches=1000000000`. */
const MAX_BATCHES = params.get("maxBatches");
const NAME = "bench-latency";

type Stats = {
  readonly label: string;
  readonly n: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly p999: number;
  readonly max: number;
  readonly over1ms: number;
};

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

function stats(label: string, samples: Float64Array): Stats {
  const s = Float64Array.from(samples).sort();
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  let over1ms = 0;
  for (const x of s) if (x > 1) over1ms++;
  const row = {
    label,
    n: s.length,
    p50: q(0.5),
    p90: q(0.9),
    p99: q(0.99),
    p999: q(0.999),
    max: s[s.length - 1]!,
    over1ms,
  };
  const ms = (x: number) => x.toFixed(3).padStart(8);
  log(
    `${label.padEnd(18)} p50 ${ms(row.p50)}  p90 ${ms(row.p90)}  p99 ${ms(row.p99)}  p99.9 ${ms(row.p999)}  max ${ms(row.max)}  >1ms ${over1ms}`,
  );
  return row;
}

async function timeEach(
  label: string,
  count: number,
  op: (i: number) => Promise<void>,
): Promise<Stats> {
  const samples = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const t = performance.now();
    await op(i);
    samples[i] = performance.now() - t;
  }
  return stats(label, samples);
}

async function resetStorage(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`opfs-lsm-wal/${NAME}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
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
  const { openDb, openBrowserFs } = await import("../dist/index.js");
  const { loadLatestGeneration } = await import("../dist/store/generation.js");
  await resetStorage();
  log(`N=${N}  value=${VALUE_BYTES} B  maxBatches=${MAX_BATCHES ?? "default"}  isolated=${crossOriginIsolated}  mode=SharedWorker`);

  const enc = new TextEncoder();
  const key = (i: number) => enc.encode(`user:${String(i).padStart(8, "0")}`);
  const value = new Uint8Array(VALUE_BYTES).fill(7);
  const options = {
    name: NAME,
    workerUrl: new URL("../dist/host/shared-worker.js", import.meta.url),
    ...(MAX_BATCHES ? { ingestPolicy: { maxBatches: Number(MAX_BATCHES), maxBytes: 2 ** 40 } } : {}),
  };
  const fs = await openBrowserFs(NAME);
  const runs = async () => (await loadLatestGeneration(fs))?.runs.length ?? 0;

  const order = Uint32Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) {
    const j = (Math.imul(i, 2654435761) >>> 0) % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const probe = (i: number) => (Math.imul(i, 40503) >>> 0) % N;
  const expectValue = (got: Uint8Array | undefined, k: number) => {
    if (!got || got.byteLength !== VALUE_BYTES) throw new Error(`get missing ${k}`);
  };

  let db: Db = await openDb(options);
  const rows: Stats[] = [];
  rows.push(await timeEach("put", N, (i) => db.put(key(order[i]!), value)));
  await db.close();

  const t = performance.now();
  db = await openDb(options);
  log(`reopen ${(performance.now() - t).toFixed(1)} ms with ${await runs()} runs`);
  rows.push(
    await timeEach("get hit", N, async (i) => expectValue(await db.get(key(probe(i))), probe(i))),
  );
  rows.push(
    await timeEach("get miss", N, async (i) => {
      if ((await db.get(key(N + 1 + i))) !== undefined) throw new Error(`miss found ${i}`);
    }),
  );
  await db.ingest();
  log(`ingested, ${await runs()} runs`);
  rows.push(
    await timeEach("get hit (all SST)", N, async (i) =>
      expectValue(await db.get(key(probe(i))), probe(i)),
    ),
  );
  await db.close();
  await report({ n: N, rows, log: out.textContent });
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
    log(`latency FAILED: ${e?.stack || err}`);
    await report({ error: String(e?.stack || err), log: out.textContent });
  });
}
