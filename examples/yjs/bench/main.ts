/**
 * Headless Chrome load bench: Yjs on kv (KvPersistence) vs y-indexeddb.
 *
 *   pnpm --filter @opfs-lsm/example-yjs bench:load
 *
 * Query: docs, runs, concurrency, edits. The page writes docs * 10 documents
 * to each storage once, then reloads the page `runs` times. Each reload opens
 * fresh storage and loads the same `docs` documents, picked at random from the
 * set, cold and then warm. The driver reads window.__BENCH when every run is in.
 *
 * Each document is a note: a Y.Map with a title and a Y.Text body written in
 * `edits` transactions, so it is stored as `edits` updates. Every load must
 * return the title and body that were written.
 *
 * kv-wal keeps every update in the WAL (a huge maxWalBytes stops auto ingest).
 * kv-sst calls db.ingest() after the write, so loads read SSTs.
 * idb is y-indexeddb: one IndexedDB database per document, its default.
 */
import { openDb, type Db } from "@opfs-lsm/kv"
import { IndexeddbPersistence } from "y-indexeddb"
import * as Y from "yjs"
import { KvPersistence } from "../src/kv-persistence.ts"

type Shape = "kv-wal" | "kv-sst" | "idb"

type LoadPass = {
  pass: "cold" | "warm"
  openMs: number
  firstMs: number
  allMs: number
  docMsSum: number
  docMsMax: number
  checked: number
}

type WriteResult = {
  shape: Shape
  writeMs: number
  ingestMs: number
  docs: number
  updates: number
  updateBytes: number
  opfsBytes: number
  walRecords: number
  originUsage: number
}

type BenchState = {
  docs: number
  total: number
  runs: number
  concurrency: number
  edits: number
  writes: WriteResult[]
  loads: { shape: Shape; run: number; order: number; passes: LoadPass[] }[]
  nextRun: number
}

const SHAPES: Shape[] = ["kv-wal", "kv-sst", "idb"]
const NO_AUTO_INGEST = Number.MAX_SAFE_INTEGER
const params = new URLSearchParams(location.search)
const DOCS = Number(params.get("docs") ?? 5000)
const TOTAL = DOCS * 10
const RUNS = Number(params.get("runs") ?? 3)
const CONCURRENCY = Number(params.get("concurrency") ?? 20)
const EDITS = Number(params.get("edits") ?? 5)
const SAMPLE_SEED = 0x5eed
const STATE_KEY = "yjs-load-bench"

declare global {
  interface Window {
    __BENCH?: BenchState | { error: string }
    __BENCH_STATUS?: string
  }
}

function status(text: string): void {
  window.__BENCH_STATUS = text
  const el = document.getElementById("status")
  if (el) el.textContent = text
}

function docName(i: number): string {
  return `ybench-note-${i}`
}

function title(i: number): string {
  return `Note ${i}`
}

function sentence(i: number, edit: number): string {
  return `Edit ${edit} of note ${i}: call the office about invoice ${i * 7 + edit}. `
}

function expectedBody(i: number): string {
  let body = ""
  for (let edit = 0; edit < EDITS; edit++) body += sentence(i, edit)
  return body
}

/** One transaction per edit, so each document is stored as EDITS updates. */
function writeNote(doc: Y.Doc, i: number): void {
  const meta = doc.getMap<string | number>("meta")
  const body = doc.getText("body")
  for (let edit = 0; edit < EDITS; edit++) {
    doc.transact(() => {
      if (edit === 0) {
        meta.set("title", title(i))
        meta.set("created", 1_700_000_000_000 + i * 1000)
      }
      body.insert(body.length, sentence(i, edit))
    })
  }
}

function checkNote(doc: Y.Doc, i: number): boolean {
  return doc.getMap("meta").get("title") === title(i) && doc.getText("body").toString() === expectedBody(i)
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The same DOCS indices out of TOTAL for every shape and run. */
function sample(): number[] {
  const all = Array.from({ length: TOTAL }, (_, i) => i)
  const rand = mulberry32(SAMPLE_SEED)
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[all[i], all[j]] = [all[j]!, all[i]!]
  }
  return all.slice(0, DOCS)
}

function dbName(shape: Shape): string {
  return `ybench-${shape}`
}

async function openKv(shape: Shape): Promise<Db> {
  return openDb({
    name: dbName(shape),
    ingestPolicy: { maxWalBytes: NO_AUTO_INGEST },
  } as Parameters<typeof openDb>[0])
}

/** Resolves after y-indexeddb's queued writes on this connection commit. */
function idbSettled(persistence: IndexeddbPersistence): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = persistence.db!.transaction("updates", "readonly")
    const count = tx.objectStore("updates").count()
    count.onsuccess = () => resolve(count.result)
    count.onerror = () => reject(count.error ?? new Error("count updates"))
  })
}

type DocStore = {
  /** Open, apply what storage has, return the doc and a closer. */
  open(i: number): Promise<{ doc: Y.Doc; settle(): Promise<void>; close(): Promise<void> }>
  close(): Promise<void>
}

function kvStore(db: Db): DocStore {
  return {
    async open(i) {
      const doc = new Y.Doc()
      const persistence = new KvPersistence(db, docName(i), doc)
      await persistence.whenSynced
      return {
        doc,
        settle: () => persistence.flush(),
        async close() {
          await persistence.destroy()
          doc.destroy()
        },
      }
    },
    close: () => db.close(),
  }
}

function idbStore(): DocStore {
  return {
    async open(i) {
      const doc = new Y.Doc()
      const persistence = new IndexeddbPersistence(docName(i), doc)
      await persistence.whenSynced
      return {
        doc,
        async settle() {
          await idbSettled(persistence)
        },
        async close() {
          await persistence.destroy()
          doc.destroy()
        },
      }
    },
    close: async () => {},
  }
}

async function openStore(shape: Shape): Promise<{ store: DocStore; db?: Db }> {
  if (shape === "idb") return { store: idbStore() }
  const db = await openKv(shape)
  return { store: kvStore(db), db }
}

async function pool(count: number, body: (i: number) => Promise<void>): Promise<void> {
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= count) return
      await body(i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count) }, () => worker()))
}

async function measurePass(shape: Shape, indices: readonly number[], pass: "cold" | "warm"): Promise<LoadPass> {
  const t0 = performance.now()
  const { store } = await openStore(shape)
  const openMs = performance.now() - t0
  let firstMs = 0
  let docMsSum = 0
  let docMsMax = 0
  let checked = 0
  const bad: number[] = []
  await pool(indices.length, async (k) => {
    const i = indices[k]!
    const started = performance.now()
    const handle = await store.open(i)
    const took = performance.now() - started
    docMsSum += took
    docMsMax = Math.max(docMsMax, took)
    if (firstMs === 0) firstMs = performance.now() - t0
    if (checkNote(handle.doc, i)) checked += 1
    else bad.push(i)
    await handle.close()
  })
  const allMs = performance.now() - t0
  await store.close()
  if (bad.length > 0) throw new Error(`${shape} ${pass}: ${bad.length} documents loaded wrong, first ${docName(bad[0]!)}`)
  return { pass, openMs, firstMs, allMs, docMsSum, docMsMax, checked }
}

async function dirBytes(dir: FileSystemDirectoryHandle): Promise<number> {
  let total = 0
  const entries = (
    dir as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>
    }
  ).entries()
  for await (const [, handle] of entries) {
    if (handle.kind === "file") total += (await (handle as FileSystemFileHandle).getFile()).size
    else total += await dirBytes(handle as FileSystemDirectoryHandle)
  }
  return total
}

async function opfsBytes(shape: Shape): Promise<number> {
  if (shape === "idb") return 0
  try {
    const root = await navigator.storage.getDirectory()
    const lsm = await root.getDirectoryHandle("opfs-lsm")
    return await dirBytes(await lsm.getDirectoryHandle(dbName(shape)))
  } catch {
    return 0
  }
}

function idbCount(database: string, store: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(database)
    req.onerror = () => reject(req.error ?? new Error(`open ${database}`))
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(store)) {
        db.close()
        resolve(0)
        return
      }
      const count = db.transaction(store, "readonly").objectStore(store).count()
      count.onsuccess = () => {
        resolve(count.result)
        db.close()
      }
      count.onerror = () => reject(count.error ?? new Error(`count ${store}`))
    }
  })
}

async function populate(shape: Shape): Promise<WriteResult> {
  status(`write ${shape}: ${TOTAL} docs`)
  const started = performance.now()
  const { store, db } = await openStore(shape)
  let updates = 0
  let updateBytes = 0
  let done = 0
  await pool(TOTAL, async (i) => {
    const handle = await store.open(i)
    handle.doc.on("update", (update: Uint8Array) => {
      updates += 1
      updateBytes += update.byteLength
    })
    writeNote(handle.doc, i)
    await handle.settle()
    await handle.close()
    done += 1
    if (done % 500 === 0) status(`write ${shape}: ${done}/${TOTAL}`)
  })
  const writeMs = performance.now() - started
  let ingestMs = 0
  if (shape === "kv-sst" && db) {
    status(`write ${shape}: ingest`)
    const ingestStarted = performance.now()
    await db.ingest()
    ingestMs = performance.now() - ingestStarted
  }
  await store.close()
  const [opfs, walRecords, usage] = await Promise.all([
    opfsBytes(shape),
    shape === "idb" ? Promise.resolve(0) : idbCount(`opfs-lsm-wal/${dbName(shape)}`, "wal"),
    navigator.storage.estimate().then((estimate) => estimate.usage ?? 0),
  ])
  return { shape, writeMs, ingestMs, docs: TOTAL, updates, updateBytes, opfsBytes: opfs, walRecords, originUsage: usage }
}

function rotate(run: number): Shape[] {
  const shift = run % SHAPES.length
  return [...SHAPES.slice(shift), ...SHAPES.slice(0, shift)]
}

function loadState(): BenchState | undefined {
  const raw = sessionStorage.getItem(STATE_KEY)
  if (!raw) return undefined
  const state = JSON.parse(raw) as BenchState
  if (state.docs !== DOCS || state.runs !== RUNS || state.concurrency !== CONCURRENCY || state.edits !== EDITS) {
    return undefined
  }
  return state
}

function saveState(state: BenchState): void {
  sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
}

async function main(): Promise<void> {
  if (!params.has("auto")) {
    status("open with ?auto=1")
    return
  }
  let state = loadState()
  if (!state) {
    const writes: WriteResult[] = []
    for (const shape of SHAPES) writes.push(await populate(shape))
    state = { docs: DOCS, total: TOTAL, runs: RUNS, concurrency: CONCURRENCY, edits: EDITS, writes, loads: [], nextRun: 0 }
    saveState(state)
    status(`wrote ${TOTAL} docs x ${SHAPES.length}, reloading for cold load`)
    location.reload()
    return
  }
  if (state.nextRun < state.runs) {
    const indices = sample()
    const order = rotate(state.nextRun)
    for (let k = 0; k < order.length; k++) {
      const shape = order[k]!
      status(`run ${state.nextRun + 1}/${state.runs} ${shape}: cold load`)
      const cold = await measurePass(shape, indices, "cold")
      status(`run ${state.nextRun + 1}/${state.runs} ${shape}: warm load`)
      const warm = await measurePass(shape, indices, "warm")
      state.loads.push({ shape, run: state.nextRun, order: k, passes: [cold, warm] })
    }
    state.nextRun += 1
    saveState(state)
    if (state.nextRun < state.runs) {
      status(`reload for cold run ${state.nextRun + 1}/${state.runs}`)
      location.reload()
      return
    }
  }
  window.__BENCH = state
  status("done")
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
  window.__BENCH = { error: message }
  status(message)
})
