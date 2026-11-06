import {
  IndexedDBStorageAdapter,
  Repo,
  splice,
  type Chunk,
  type DocHandle,
  type StorageAdapterInterface,
  type StorageKey,
} from "@automerge/react";
import { openDb } from "@opfs-lsm/kv";
import { kvStorage } from "../src/storage.ts";
import {
  ADAPTERS,
  METRICS,
  parseWorkload,
  type Adapter,
  type MetricName,
  type RunResult,
  type Variant,
} from "./big-doc-metrics.ts";

type TextDoc = { text: string };
type Edit = [pos: number, del: number, ...insert: string[]];

const query = new URLSearchParams(location.search);
const adapterParam = query.get("adapter");
const adapter: Adapter = ADAPTERS.find((a) => a === adapterParam) ?? "kv";
const walBytesParam = query.get("walBytes");
const walBytes = walBytesParam ? Number(walBytesParam) : undefined;
const variant: Variant = { label: query.get("label") ?? adapter, adapter, ...(walBytes ? { walBytes } : {}) };
const params = { workload: query.get("workload") ?? "trace:100", loads: Number(query.get("loads") ?? 5) };
const workload = parseWorkload(params.workload);
const dbName = `bench-${adapter}-${Date.now()}`;
let ingests = 0;

/** Survives Repo shutdown, so a cold load in the same page sees what was written. */
const memStore = new Map<string, { key: StorageKey; data: Uint8Array }>();
const memKey = (key: StorageKey) => JSON.stringify(key);
const memHas = (key: StorageKey, prefix: StorageKey) => prefix.every((p, i) => key[i] === p);

const openers: Record<Adapter, () => Promise<StorageAdapterInterface>> = {
  kv: async () => {
    const db = await openDb({ name: dbName, ...(walBytes ? { ingestPolicy: { maxWalBytes: walBytes } } : {}) });
    db.changes((event) => {
      if (event.kind === "ingest") ingests++;
    });
    return kvStorage(db);
  },
  idb: async () => {
    const storage = new IndexedDBStorageAdapter(dbName);
    await storage.load(["__warm"]);
    return storage;
  },
  mem: async () => ({
    async load(key) {
      return memStore.get(memKey(key))?.data;
    },
    async save(key, data) {
      memStore.set(memKey(key), { key, data });
    },
    async remove(key) {
      memStore.delete(memKey(key));
    },
    async loadRange(prefix) {
      const out: Chunk[] = [];
      for (const { key, data } of memStore.values()) if (memHas(key, prefix)) out.push({ key, data });
      return out;
    },
    async removeRange(prefix) {
      for (const [k, { key }] of memStore) if (memHas(key, prefix)) memStore.delete(k);
    },
  }),
};

const newRepo = (storage: StorageAdapterInterface) => new Repo({ network: [], storage });

/** A macrotask without setTimeout's 4 ms clamp, so Repo's save debounce can fire mid-replay. */
const channel = new MessageChannel();
const yieldTask = () =>
  new Promise<void>((resolve) => {
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });

async function fetchBytes(file: string): Promise<Uint8Array> {
  const res = await fetch(`/bench-data/${file}`);
  if (!res.ok) throw new Error(`fetch ${file}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Chrome sets up a fresh profile's storage on first use; pay that before timing any adapter. */
function touchStorage(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("__bench-touch");
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

async function run(): Promise<RunResult> {
  const metrics = Object.fromEntries(METRICS.map((m) => [m.name, NaN])) as Record<MetricName, number>;
  const checks: RunResult["checks"] = { changes: 0, docBytes: 0, goodLoads: 0, ingests: 0, errors: [] };
  const result: RunResult = { variant, params, metrics, checks };
  try {
    const input =
      workload.kind === "trace"
        ? ((await (await fetch("/bench-data/data/edits.json")).json()) as Edit[])
        : await fetchBytes(workload.file);

    await touchStorage();
    let t = performance.now();
    let repo = newRepo(await openers[adapter]());
    metrics.open = performance.now() - t;

    t = performance.now();
    let handle: DocHandle<TextDoc>;
    if (workload.kind === "trace") {
      const edits = input as Edit[];
      handle = repo.create<TextDoc>({ text: "" });
      for (let i = 0; i < edits.length; i += workload.perChange) {
        const group = edits.slice(i, i + workload.perChange);
        handle.change((doc) => {
          for (const [pos, del, ...ins] of group) splice(doc, ["text"], pos, del, ins.join(""));
        });
        checks.changes++;
        await yieldTask();
      }
    } else {
      handle = repo.import<TextDoc>(input as Uint8Array);
    }
    const tFlush = performance.now();
    await repo.flush();
    metrics.flush = performance.now() - tFlush;
    metrics.write = performance.now() - t;

    const url = handle.url;
    const heads = JSON.stringify(handle.heads());
    const text = workload.kind === "trace" ? handle.doc()?.text : undefined;
    checks.docBytes = (await repo.export(handle.documentId))?.byteLength ?? 0;

    const laps: number[] = [];
    for (let i = 0; i < params.loads; i++) {
      await repo.shutdown();
      t = performance.now();
      repo = newRepo(await openers[adapter]());
      const loaded = await repo.find<TextDoc>(url);
      const doc = loaded.doc();
      laps.push(performance.now() - t);
      const sameHeads = JSON.stringify(loaded.heads()) === heads;
      const sameText = text === undefined || doc?.text === text;
      if (sameHeads && sameText) checks.goodLoads++;
      else checks.errors.push(`load ${i}: heads ${sameHeads ? "ok" : "differ"}, text ${sameText ? "ok" : "differs"}`);
    }
    await repo.shutdown();
    metrics.load = median(laps);
    metrics.loadMax = Math.max(...laps);
  } catch (err) {
    checks.errors.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
  checks.ingests = ingests;
  return result;
}

const result = await run();
document.getElementById("out")!.textContent = JSON.stringify(result, null, 2);
await fetch("/bench-results", { method: "POST", body: JSON.stringify(result) });
