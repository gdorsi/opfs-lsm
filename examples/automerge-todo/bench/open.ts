/**
 * Headless Chrome bench: time openDb against an uningested IndexedDB WAL.
 *
 *   pnpm --filter @opfs-lsm/kv build
 *   pnpm --filter @opfs-lsm/example-automerge bench:open
 *
 * Query: runs, cases, valueBytes. Cold is a page reload with the host idle.
 * Warm is a second open started as soon as the first resolves. Idle is a
 * third open after both host WAL scans have finished.
 */
import { Repo } from "@automerge/react";
import type { Db } from "@opfs-lsm/kv";
import {
  openHarnessDb,
  type OpenSpan,
  type OpenTrace,
} from "@opfs-lsm/kv/testing";
import { encodeKey, kvStorage } from "../src/storage.ts";

type Note = {
  title: string;
  body: string;
  created: number;
  tags: string[];
};

type CaseSpec =
  | { id: string; kind: "rows"; rows: number; valueBytes: number }
  | { id: string; kind: "automerge"; docs: number };

type PassName = "cold" | "warm" | "idle";

type Pass = {
  pass: PassName;
  openMs: number;
  traceOpenMs: number | null;
  rows: number;
  phases: Record<string, number | null>;
  openStartedAt: number;
  openEndedAt: number;
  hostScanEndedAt: number | null;
  wasmEndedAt: number | null;
  gapMs: number;
  syncGapMs: number | null;
};

type FloorRead = {
  ms: number;
  idbMs: number;
  decodeMs: number;
  rows: number;
  bytes: number;
};

type Floor = {
  rounds: number;
  cursor: FloorRead;
  cursorCount: FloorRead;
  getAll: FloorRead;
  /** One get of a single value the size of the whole WAL. A layout ceiling, not an open. */
  oneBlobMs: number;
};

type CaseResult = {
  id: string;
  kind: string;
  rows: number;
  valueBytes: number | null;
  docs: number | null;
  walRows: number;
  populateMs: number;
  runs: { cold: Pass; warm: Pass; idle: Pass; coldScanOverlappedWarm: boolean }[];
  floor: Floor | null;
};

type BenchState = {
  runs: number;
  valueBytes: number;
  casesKey: string;
  caseIndex: number;
  nextRun: number;
  step: "populate" | "measure";
  results: CaseResult[];
  sampleKey: string;
  sampleValue: string;
  expectedRows: number;
};

type Published = {
  runs: number;
  valueBytes: number;
  casesKey: string;
  userAgent: string;
  results: CaseResult[];
};

declare global {
  interface Window {
    __BENCH?: Published | { error: string };
    __BENCH_STATUS?: string;
  }
}

const PHASES = [
  "opfs",
  "worker-ctor",
  "idb-open",
  "generation",
  "manifest",
  "sync",
  "wal-read",
  "memtable",
  "sst",
  "wasm",
  "wasm-error",
  "host-scan",
  "open",
] as const;

const NO_INGEST = Number.MAX_SAFE_INTEGER;
const params = new URLSearchParams(location.search);
const RUNS = Number(params.get("runs") ?? 5);
const VALUE_BYTES = Number(params.get("valueBytes") ?? 512);
const CASE_IDS = (params.get("cases") ?? "rows-1k,rows-5k,rows-20k,am-5k")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
const STATE_KEY = "wal-open-bench";

const ALL_CASES: CaseSpec[] = [
  { id: "rows-1k", kind: "rows", rows: 1000, valueBytes: VALUE_BYTES },
  { id: "rows-5k", kind: "rows", rows: 5000, valueBytes: VALUE_BYTES },
  { id: "rows-20k", kind: "rows", rows: 20000, valueBytes: VALUE_BYTES },
  { id: "am-5k", kind: "automerge", docs: Number(params.get("docs") ?? 5000) },
];

function status(text: string): void {
  window.__BENCH_STATUS = text;
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

function selectedCases(): CaseSpec[] {
  const cases = ALL_CASES.filter((spec) => CASE_IDS.includes(spec.id));
  if (cases.length === 0) throw new Error(`no cases match ${CASE_IDS.join(",")}`);
  return cases;
}

function dbName(id: string): string {
  return `ob-${id}`;
}

function rowKey(i: number): Uint8Array {
  const key = new Uint8Array(8);
  new DataView(key.buffer).setUint32(4, i);
  return key;
}

function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromB64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function sameBytes(got: Uint8Array | undefined, expected: Uint8Array): boolean {
  if (!got || got.byteLength !== expected.byteLength) return false;
  for (let i = 0; i < expected.byteLength; i++) {
    if (got[i] !== expected[i]) return false;
  }
  return true;
}

function casesKey(): string {
  return `${selectedCases().map((spec) => spec.id).join("+")}:v${VALUE_BYTES}:r${RUNS}`;
}

function loadState(): BenchState | undefined {
  const raw = sessionStorage.getItem(STATE_KEY);
  if (!raw) return undefined;
  const state = JSON.parse(raw) as BenchState;
  if (state.casesKey !== casesKey() || state.runs !== RUNS) return undefined;
  return state;
}

function saveState(state: BenchState): void {
  sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function idbReq<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("idb request"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("idb tx"));
    tx.onabort = () => reject(tx.error ?? new Error("idb abort"));
  });
}

function openWal(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`opfs-lsm-wal/${name}`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("idb open"));
  });
}

async function walRows(name: string): Promise<number> {
  const db = await openWal(name);
  try {
    const tx = db.transaction("wal", "readonly");
    const count = await idbReq(tx.objectStore("wal").count());
    await txDone(tx);
    return count;
  } finally {
    db.close();
  }
}

async function walGeneration(name: string): Promise<unknown> {
  const db = await openWal(name);
  try {
    const tx = db.transaction("meta", "readonly");
    const value = await idbReq(tx.objectStore("meta").get("generation"));
    await txDone(tx);
    return value;
  } finally {
    db.close();
  }
}

function consumeOps(raw: unknown): number {
  if (!Array.isArray(raw)) throw new Error("wal value is not ops");
  let bytes = 0;
  for (const item of raw) {
    const row = item as { type?: string; key?: ArrayBuffer; value?: ArrayBuffer };
    if (!row.key) throw new Error("wal op missing key");
    bytes += new Uint8Array(row.key).byteLength;
    if (row.type === "put") {
      if (!row.value) throw new Error("wal put missing value");
      bytes += new Uint8Array(row.value).byteLength;
    }
  }
  return bytes;
}

async function readCursor(db: IDBDatabase, decode: boolean): Promise<FloorRead> {
  const tx = db.transaction("wal", "readonly");
  const done = txDone(tx);
  const started = performance.now();
  let rows = 0;
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const request = tx.objectStore("wal").openCursor();
    request.onerror = () => reject(request.error ?? new Error("cursor"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      rows += 1;
      if (decode) bytes += consumeOps(cursor.value);
      cursor.continue();
    };
  });
  await done;
  return {
    ms: performance.now() - started,
    idbMs: 0,
    decodeMs: 0,
    rows,
    bytes,
  };
}

async function readGetAll(db: IDBDatabase): Promise<FloorRead> {
  const tx = db.transaction("wal", "readonly");
  const store = tx.objectStore("wal");
  const done = txDone(tx);
  const started = performance.now();
  const [keys, values] = await Promise.all([
    idbReq(store.getAllKeys()),
    idbReq(store.getAll()),
  ]);
  const afterRead = performance.now();
  if (keys.length !== values.length) throw new Error("getAll keys and values differ");
  let bytes = 0;
  for (const value of values) bytes += consumeOps(value);
  const afterDecode = performance.now();
  await done;
  const ended = performance.now();
  return {
    ms: ended - started,
    idbMs: afterRead - started + (ended - afterDecode),
    decodeMs: afterDecode - afterRead,
    rows: keys.length,
    bytes,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function medianRead(reads: FloorRead[]): FloorRead {
  return {
    ms: median(reads.map((read) => read.ms)),
    idbMs: median(reads.map((read) => read.idbMs)),
    decodeMs: median(reads.map((read) => read.decodeMs)),
    rows: reads[0]?.rows ?? 0,
    bytes: reads[0]?.bytes ?? 0,
  };
}

async function measureFloor(name: string): Promise<Floor> {
  const rounds = 5;
  const cursor: FloorRead[] = [];
  const cursorCount: FloorRead[] = [];
  const getAll: FloorRead[] = [];
  const kinds = ["cursor", "count", "getAll"] as const;
  for (let i = 0; i < rounds; i++) {
    for (let step = 0; step < kinds.length; step++) {
      const kind = kinds[(i + step) % kinds.length]!;
      const db = await openWal(name);
      if (kind === "cursor") cursor.push(await readCursor(db, true));
      else if (kind === "count") cursorCount.push(await readCursor(db, false));
      else getAll.push(await readGetAll(db));
      db.close();
    }
  }
  const cursorMedian = medianRead(cursor);
  const countMedian = medianRead(cursorCount);
  const getAllMedian = medianRead(getAll);
  if (
    cursorMedian.rows !== getAllMedian.rows ||
    cursorMedian.rows !== countMedian.rows ||
    cursorMedian.bytes !== getAllMedian.bytes
  ) {
    throw new Error(
      `floor mismatch cursor ${cursorMedian.rows}/${cursorMedian.bytes} getAll ${getAllMedian.rows}/${getAllMedian.bytes} count ${countMedian.rows}`,
    );
  }
  return {
    rounds,
    cursor: cursorMedian,
    cursorCount: countMedian,
    getAll: getAllMedian,
    oneBlobMs: await oneBlobGet(cursorMedian.bytes),
  };
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`delete ${name}`));
    request.onblocked = () => resolve();
  });
}

async function oneBlobGet(bytes: number): Promise<number> {
  const name = "ob-blob-floor";
  await deleteDatabase(name);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("blob");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("blob open"));
  });
  try {
    const payload = new Uint8Array(bytes);
    if (bytes > 0) {
      payload[0] = 1;
      payload[bytes - 1] = 2;
    }
    const write = db.transaction("blob", "readwrite");
    write.objectStore("blob").put(payload.buffer, "v");
    await txDone(write);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const tx = db.transaction("blob", "readonly");
      const started = performance.now();
      const value = await idbReq(tx.objectStore("blob").get("v"));
      await txDone(tx);
      const ms = performance.now() - started;
      const view = new Uint8Array(value as ArrayBuffer);
      if (view.byteLength !== bytes || (bytes > 0 && (view[0] !== 1 || view[bytes - 1] !== 2))) {
        throw new Error("blob floor read the wrong bytes");
      }
      samples.push(ms);
    }
    return median(samples);
  } finally {
    db.close();
    await deleteDatabase(name);
  }
}

async function waitPhase(trace: OpenTrace, phase: string, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (trace.spans.some((span) => span.phase === phase)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function sumPhase(spans: readonly OpenSpan[], phase: string): number | null {
  let total = 0;
  let saw = false;
  for (const span of spans) {
    if (span.phase !== phase) continue;
    total += span.ms;
    saw = true;
  }
  return saw ? total : null;
}

function replayRows(spans: readonly OpenSpan[]): number {
  let rows = -1;
  for (const span of spans) {
    if (span.phase === "wal-read" && span.rows !== undefined) {
      rows = Math.max(rows, span.rows);
    }
  }
  if (rows < 0) throw new Error("open recorded no WAL read");
  return rows;
}

function phasesOf(spans: readonly OpenSpan[]): Record<string, number | null> {
  const phases: Record<string, number | null> = {};
  for (const phase of PHASES) phases[phase] = sumPhase(spans, phase);
  return phases;
}

function gapMs(openMs: number, phases: Record<string, number | null>): number {
  const parts = ["opfs", "worker-ctor", "idb-open", "generation", "sync"];
  let sum = 0;
  for (const part of parts) sum += phases[part] ?? 0;
  return openMs - sum;
}

function syncGap(phases: Record<string, number | null>): number | null {
  if (phases.sync === null) return null;
  const inner = (phases["wal-read"] ?? 0) + (phases.memtable ?? 0) + (phases.sst ?? 0);
  return phases.sync - inner;
}

function endedAt(spans: readonly OpenSpan[], phase: string): number | null {
  let at: number | null = null;
  for (const span of spans) {
    if (span.phase === phase) at = span.endedAt;
  }
  return at;
}

async function timeOpen(name: string, pass: PassName, expectedRows: number): Promise<{
  db: Db;
  trace: OpenTrace;
  pass: Pass;
}> {
  const trace: OpenTrace = { spans: [] };
  const openStartedAt = performance.now();
  const db = await openHarnessDb({
    name,
    ingestPolicy: { maxWalBytes: NO_INGEST },
    trace,
  });
  const openEndedAt = performance.now();
  const phases = phasesOf(trace.spans);
  const passRow: Pass = {
    pass,
    openMs: openEndedAt - openStartedAt,
    traceOpenMs: phases.open,
    rows: replayRows(trace.spans),
    phases,
    openStartedAt,
    openEndedAt,
    hostScanEndedAt: null,
    wasmEndedAt: endedAt(trace.spans, "wasm"),
    gapMs: gapMs(openEndedAt - openStartedAt, phases),
    syncGapMs: syncGap(phases),
  };
  if (passRow.rows !== expectedRows) {
    throw new Error(`${pass} replayed ${passRow.rows} WAL rows, expected ${expectedRows}`);
  }
  return { db, trace, pass: passRow };
}

async function finishTrace(trace: OpenTrace, pass: Pass): Promise<void> {
  const scanOk = await waitPhase(trace, "host-scan", 120_000);
  const wasmOk = await waitPhase(trace, "wasm", 30_000);
  if (!scanOk) throw new Error(`${pass.pass} host scan did not report`);
  if (!wasmOk) throw new Error(`${pass.pass} wasm init did not report`);
  if (trace.spans.some((span) => span.phase === "wasm-error")) {
    throw new Error(`${pass.pass} wasm init failed`);
  }
  pass.phases = phasesOf(trace.spans);
  pass.hostScanEndedAt = endedAt(trace.spans, "host-scan");
  pass.wasmEndedAt = endedAt(trace.spans, "wasm");
  pass.gapMs = gapMs(pass.openMs, pass.phases);
  pass.syncGapMs = syncGap(pass.phases);
}

async function checkSample(db: Db, state: BenchState): Promise<void> {
  const got = await db.get(fromB64(state.sampleKey));
  if (!sameBytes(got, fromB64(state.sampleValue))) {
    throw new Error("opened database missed the sample key");
  }
}

async function assertUningested(name: string, expected: number): Promise<number> {
  const generation = await walGeneration(name);
  if (typeof generation === "number" && generation > 0) {
    throw new Error(`WAL was ingested, generation ${generation}`);
  }
  const rows = await walRows(name);
  if (rows !== expected) throw new Error(`WAL has ${rows} rows, expected ${expected}`);
  return rows;
}

async function populateRows(spec: Extract<CaseSpec, { kind: "rows" }>): Promise<{
  walRows: number;
  populateMs: number;
  sampleKey: string;
  sampleValue: string;
}> {
  const name = dbName(spec.id);
  const trace: OpenTrace = { spans: [] };
  const started = performance.now();
  const db = await openHarnessDb({
    name,
    ingestPolicy: { maxWalBytes: NO_INGEST },
    trace,
  });
  const value = new Uint8Array(spec.valueBytes);
  if (spec.valueBytes > 0) value[spec.valueBytes - 1] = 0x5a;
  for (let i = 0; i < spec.rows; i++) {
    value[0] = i & 0xff;
    if (spec.valueBytes > 1) value[1] = (i >>> 8) & 0xff;
    if (spec.valueBytes > 2) value[2] = (i >>> 16) & 0xff;
    await db.put(rowKey(i), value);
    if (i > 0 && i % 1000 === 0) {
      status(`write ${spec.id} ${i}/${spec.rows}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  value[0] = 0;
  if (spec.valueBytes > 1) value[1] = 0;
  if (spec.valueBytes > 2) value[2] = 0;
  const sampleKey = toB64(rowKey(0));
  const sampleValue = toB64(value.slice());
  if (!(await waitPhase(trace, "host-scan", 120_000))) {
    throw new Error("populate host scan did not report");
  }
  await db.close();
  const rows = await assertUningested(name, spec.rows);
  return { walRows: rows, populateMs: performance.now() - started, sampleKey, sampleValue };
}

async function populateAutomerge(spec: Extract<CaseSpec, { kind: "automerge" }>): Promise<{
  walRows: number;
  populateMs: number;
  sampleKey: string;
  sampleValue: string;
}> {
  const name = dbName(spec.id);
  const trace: OpenTrace = { spans: [] };
  const started = performance.now();
  const db = await openHarnessDb({
    name,
    ingestPolicy: { maxWalBytes: NO_INGEST },
    trace,
  });
  let sampleKey: Uint8Array | undefined;
  let sampleValue: Uint8Array | undefined;
  const inner = kvStorage(db);
  const storage = {
    load: (key: string[]) => inner.load(key),
    async save(key: string[], data: Uint8Array) {
      if (!sampleKey) {
        sampleKey = encodeKey(key);
        sampleValue = data.slice();
      }
      await inner.save(key, data);
    },
    remove: (key: string[]) => inner.remove(key),
    loadRange: (prefix: string[]) => inner.loadRange(prefix),
    removeRange: (prefix: string[]) => inner.removeRange(prefix),
    close: () => inner.close(),
  };
  const repo = new Repo({
    storage,
    network: [],
    peerId: "wal-open-bench" as never,
    saveDebounceRate: 60 * 60 * 1000,
    isEphemeral: false,
  });
  for (let i = 0; i < spec.docs; i++) {
    const handle = repo.create<Note>({
      title: `Note ${i}`,
      body: `Buy groceries and call the office about invoice ${i}. The meeting is Thursday at 10.`,
      created: 1_700_000_000_000 + i * 1000,
      tags: [i % 2 === 0 ? "work" : "home", "inbox"],
    });
    handle.change((doc) => {
      doc.body += " — done";
      doc.tags.push("edited");
    });
    if (i > 0 && i % 250 === 0) {
      status(`write ${spec.id} ${i}/${spec.docs}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  status(`write ${spec.id} flush`);
  await repo.flush();
  if (!sampleKey || !sampleValue) throw new Error("automerge saved nothing");
  if (!(await waitPhase(trace, "host-scan", 120_000))) {
    throw new Error("populate host scan did not report");
  }
  await repo.shutdown();
  const rows = await walRows(name);
  const generation = await walGeneration(name);
  if (typeof generation === "number" && generation > 0) {
    throw new Error(`WAL was ingested, generation ${generation}`);
  }
  if (rows < spec.docs) throw new Error(`WAL has ${rows} rows after ${spec.docs} docs`);
  return {
    walRows: rows,
    populateMs: performance.now() - started,
    sampleKey: toB64(sampleKey),
    sampleValue: toB64(sampleValue),
  };
}

async function populate(spec: CaseSpec): Promise<{
  walRows: number;
  populateMs: number;
  sampleKey: string;
  sampleValue: string;
}> {
  if (spec.kind === "rows") return populateRows(spec);
  return populateAutomerge(spec);
}

async function main(): Promise<void> {
  if (!params.has("auto")) {
    status("open with ?auto=1");
    return;
  }
  const cases = selectedCases();
  let state = loadState();
  if (!state) {
    state = {
      runs: RUNS,
      valueBytes: VALUE_BYTES,
      casesKey: casesKey(),
      caseIndex: 0,
      nextRun: 0,
      step: "populate",
      results: [],
      sampleKey: "",
      sampleValue: "",
      expectedRows: 0,
    };
  }

  for (;;) {
    const spec = cases[state.caseIndex];
    if (!spec) break;
    const name = dbName(spec.id);
    if (state.step === "populate") {
      status(`populate ${spec.id}`);
      const wrote = await populate(spec);
      state.sampleKey = wrote.sampleKey;
      state.sampleValue = wrote.sampleValue;
      state.expectedRows = wrote.walRows;
      state.results.push({
        id: spec.id,
        kind: spec.kind,
        rows: spec.kind === "rows" ? spec.rows : wrote.walRows,
        valueBytes: spec.kind === "rows" ? spec.valueBytes : null,
        docs: spec.kind === "automerge" ? spec.docs : null,
        walRows: wrote.walRows,
        populateMs: wrote.populateMs,
        runs: [],
        floor: null,
      });
      state.step = "measure";
      state.nextRun = 0;
      saveState(state);
      status(`reload for cold ${spec.id}`);
      location.reload();
      return;
    }

    const result = state.results[state.results.length - 1];
    if (!result || result.id !== spec.id) throw new Error(`missing result for ${spec.id}`);
    status(`run ${state.nextRun + 1}/${state.runs} ${spec.id} cold`);
    const cold = await timeOpen(name, "cold", state.expectedRows);
    await checkSample(cold.db, state);
    status(`run ${state.nextRun + 1}/${state.runs} ${spec.id} warm`);
    const warm = await timeOpen(name, "warm", state.expectedRows);
    await checkSample(warm.db, state);
    await finishTrace(cold.trace, cold.pass);
    await finishTrace(warm.trace, warm.pass);
    await cold.db.close();
    await warm.db.close();
    status(`run ${state.nextRun + 1}/${state.runs} ${spec.id} idle`);
    const idle = await timeOpen(name, "idle", state.expectedRows);
    await checkSample(idle.db, state);
    await finishTrace(idle.trace, idle.pass);
    await idle.db.close();
    const coldScanEnded = cold.pass.hostScanEndedAt;
    result.runs.push({
      cold: cold.pass,
      warm: warm.pass,
      idle: idle.pass,
      coldScanOverlappedWarm:
        coldScanEnded !== null && coldScanEnded > warm.pass.openStartedAt,
    });
    state.nextRun += 1;
    if (state.nextRun < state.runs) {
      saveState(state);
      status(`reload for cold run ${state.nextRun + 1}/${state.runs} ${spec.id}`);
      location.reload();
      return;
    }
    status(`floor ${spec.id}`);
    result.floor = await measureFloor(name);
    if (result.floor.cursor.rows !== state.expectedRows) {
      throw new Error(`floor read ${result.floor.cursor.rows} rows, expected ${state.expectedRows}`);
    }
    state.caseIndex += 1;
    state.step = "populate";
    state.nextRun = 0;
    saveState(state);
  }

  const published: Published = {
    runs: state.runs,
    valueBytes: state.valueBytes,
    casesKey: state.casesKey,
    userAgent: navigator.userAgent,
    results: state.results,
  };
  window.__BENCH = published;
  status("done");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  window.__BENCH = { error: message };
  status(message);
});
