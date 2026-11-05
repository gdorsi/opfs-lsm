import { formatMs, summarize } from "./stats.ts";

const out = document.getElementById("out")!;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const params = new URLSearchParams(location.search);
const N = Number(params.get("n") ?? 20_000);
const VALUE_BYTES = Number(params.get("val") ?? 1024);
const AUTO = params.has("auto");

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

async function timeEach(label: string, op: (i: number) => Promise<unknown>): Promise<void> {
  const samples = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await op(i);
    samples[i] = performance.now() - t;
  }
  log(formatMs(summarize(label, samples)));
}

function openIdb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    indexedDB.deleteDatabase(name);
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("s");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, durability: IDBTransactionDurability, key: number, value: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("s", "readwrite", { durability });
    tx.objectStore("s").put({ ops: [{ value: value.buffer.slice(0) }] }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function run(): Promise<void> {
  out.textContent = "";
  log(`N=${N}  value=${VALUE_BYTES} B  isolated=${crossOriginIsolated}`);
  const value = new Uint8Array(VALUE_BYTES).fill(7);

  const db = await openIdb("bench-floors");
  for (const durability of ["default", "relaxed", "strict"] as const) {
    await timeEach(`idb put ${durability}`, (i) => idbPut(db, durability, i, value));
  }
  db.close();

  const worker = new Worker(new URL("./floors-worker.ts", import.meta.url), { type: "module" });
  const call = (msg: unknown) =>
    new Promise<unknown>((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage(msg);
    });
  await call({ op: "open" });
  await timeEach("opfs append", () => call({ op: "append", bytes: value, flush: false }));
  await timeEach("opfs append+flush", () => call({ op: "append", bytes: value, flush: true }));
  log(String(await call({ op: "inner", n: N, bytes: value })));
  worker.terminate();
  await report({ n: N, log: out.textContent });
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
    log(`floors FAILED: ${e?.stack || err}`);
    await report({ error: String(e?.stack || err), log: out.textContent });
  });
}
